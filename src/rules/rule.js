'use strict';
/**
 * Legado 规则求值核心（默认文法 / CSS / XPath-ish 子集）。
 *
 * 语法模型（来自 100 条真实规则的统计）：
 *   规则串 = 段1 @ 段2 @ 段3 ...      （段间用裸 @ 分隔，需括号/引号感知）
 *   段1    = 选择器，可取前缀形态：
 *              @css:<sel>     显式 CSS
 *              @XPath:<expr>  显式 XPath（实现常用子集）
 *              @json:<path>   JSONPath（对 JSON 文本）
 *              @js:<code>     整条规则就是 JS
 *              默认文法：CSS 选择器，或简写 class./id./tag./text.
 *   段n    = 提取操作或下一级选择器，取值：
 *              提取：text | textNodes | ownText | html | all | content | value | src | href | title | <任意属性名> | tag
 *              选择：CSS 选择器，或简写 class./id./tag./text.
 *              索引：纯数字（等价于 .N）
 *              切片：p[a:b]（支持负索引）
 *              正则：##<regex>##<replacement>   （替换）
 *                    #!<regex>                  （保留匹配）
 *              JS  ：js 或 js:<code>（script 中可用 result）
 *              CSS ：css 或 css:<sel>
 *              URL ：不支持单独形式，统一用 href/src
 *   组合符：段内可用 &&（与）和 ||（或）连接多个子规则
 *   占位符：{{...}} 在 URL/字符串里做 JS 求值
 */

const cheerio = require('cheerio');

/* ------------------------------------------------------------------ *
 * 1. 切分
 * ------------------------------------------------------------------ */

/** 按裸 '@' 切分，跳过 [] () {} 内部与引号内部的 @ */
function splitTop(s, sep = '@') {
  const out = [];
  let cur = '';
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      cur += ch;
      if (ch === q && s[i - 1] !== '\\') q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(' || ch === '{') { depth++; cur += ch; continue; }
    if (ch === ']' || ch === ')' || ch === '}') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 找顶层**最先出现**的组合操作符。
 *
 * 逐行对齐 Legado `RuleAnalyzer.splitRule("&&", "||", "%%")` —— 内部用 `consumeToAny`
 * 按位置扫描，取的是文本里最靠前的那个操作符（**不按参数顺序**），然后整串只用它切分。
 * 所以「`&&` 优先于 `||`」这种优先级模型是错的：哪个先出现就用哪个。
 * `[]` / `()` / `{}` 与引号内不参与（Legado 的 `findToAny + chompBalanced`）。
 */
function firstComboOp(s) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q && s[i - 1] !== '\\') q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === '[' || ch === '(' || ch === '{') { depth++; continue; }
    if (ch === ']' || ch === ')' || ch === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    if (s.startsWith('&&', i) || s.startsWith('||', i) || s.startsWith('%%', i)) {
      return { op: s.slice(i, i + 2), pos: i };
    }
  }
  return null;
}

/** 按顶层操作符切分（与 Legado 的 consumeToAny 一致的括号/引号感知） */
function splitOp(s, op) {
  const parts = [];
  let depth = 0;
  let q = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q && s[i - 1] !== '\\') q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(' || ch === '{') { depth++; cur += ch; continue; }
    if (ch === ']' || ch === ')' || ch === '}') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (depth === 0 && s.startsWith(op, i)) { parts.push(cur); cur = ''; i += op.length - 1; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/* ------------------------------------------------------------------ *
 * 1b. JS 块先摘（Legado `AppPattern.JS_PATTERN` + `AnalyzeRule.splitSourceRule`）
 *
 * Legado 求值任何规则前，先按 JS_PATTERN 把 `<js>…</js>` / `@js:…`（贪婪到串尾）
 * 抠成独立片段，剩下的文本片段各自成为普通规则，**按顺序串联求值**：
 *   文本片段 → 以当前 result 为起点继续求值
 *   JS 片段   → `evalJS(code, result)`
 * ⇒ JS 体内的 `&&` / `||` / `%%` / `##` 永远不会被外层切分逻辑误伤，
 *   而 `@js:` 前面的选择器（如起点的 `@css:…@js:…`）先跑完再把元素交给 JS。
 * ------------------------------------------------------------------ */

const JS_PATTERN = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;

/**
 * 把规则串切成 [{type:'text'|'js', …}]，空文本片段丢弃。
 * @returns {Array<{type:'text',text:string}|{type:'js',code:string}>}
 */
function splitJsBlocks(ruleStr) {
  const s = String(ruleStr == null ? '' : ruleStr);
  const out = [];
  let start = 0;
  let m;
  JS_PATTERN.lastIndex = 0;
  while ((m = JS_PATTERN.exec(s)) !== null) {
    if (m.index > start) {
      const t = s.slice(start, m.index).trim();
      if (t) out.push({ type: 'text', text: t });
    }
    // group2 = `@js:` 的体（可为空串）；group1 = `<js>…</js>` 的体。
    // Legado: `groupValues[2].ifEmpty { groupValues[1] }`
    const code = m[2] === undefined || m[2] === '' ? (m[1] || '') : m[2];
    out.push({ type: 'js', code });
    start = m.index + m[0].length;
    if (m[0].length === 0) JS_PATTERN.lastIndex++;
  }
  if (start < s.length) {
    const t = s.slice(start).trim();
    if (t) out.push({ type: 'text', text: t });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 1c. jsoup Elements/Element → 规则 JS 可直接使用的适配层
 *
 * 真实书源的 JS 块把 `result` 当 jsoup 的集合用，例如起点目录规则：
 *   $ = result; for (i in $) { $[i].select("li").forEach(a => a.select("a").attr("href")) }
 * 这里把 cheerio 集合包成同样的形状：
 *   - `for (i in $)` 只枚举数字下标（对齐 Rhino 对 Java List 的枚举行为），
 *     不会漏出 cheerio 原型上的那一堆方法名；
 *   - `$[i]` / `$.length` / `select()` / `find()` / `forEach()` / `text()` / `attr()` /
 *     `html()` / `String(x)` 直接可用，其余方法透传 cheerio，返回值继续包装。
 * ------------------------------------------------------------------ */

function makeDomProxy($, obj, isCollection) {
  const target = {};
  // 只有「集合」代理才物化数字下标子项；子项是「单元素」代理（叶子，不再物化下标）。
  // 单元素若也挂 target["0"]（再包一层 $(node)）会无限递归 → Maximum call stack size exceeded
  // （52书库 7909 的 @js: 字段规则一碰就炸）。
  if (isCollection) {
    obj.toArray().forEach((node, i) => {
      Object.defineProperty(target, String(i), {
        value: makeDomProxy($, $(node), false),
        enumerable: true,
        configurable: true,
      });
    });
    Object.defineProperty(target, 'length', { value: obj.length, enumerable: false, configurable: true });
  }
  const wrap = (r) => {
    if (r && typeof r === 'object' && typeof r.find === 'function') return makeDomProxy($, r, true);
    if (r && typeof r === 'object' && typeof r.type === 'string') return makeDomProxy($, $(r), false);
    return r;
  };
  const proxyRef = new Proxy(target, {
    get(t, prop) {
      if (prop === 'length') return isCollection ? obj.length : undefined;
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        if (prop in t) return t[prop];
        // 单元素（叶子）代理：result[0] 返回自身（Legado 单元素集合语义）
        if (!isCollection && prop === '0') return proxyRef;
        return undefined;
      }
      if (prop === 'select' || prop === 'find') return (sel) => wrap(obj.find(String(sel)));
      if (prop === 'forEach') return (cb) => { obj.toArray().forEach((node, i) => cb(makeDomProxy($, $(node), false), i)); };
      if (prop === 'size') return () => obj.length;
      if (prop === 'get') return (i) => wrap(obj.eq(i));
      if (prop === 'text') return () => obj.text();
      if (prop === 'ownText') return () => obj.contents().filter((_i, n) => n.type === 'text').toArray().map((n) => n.data).join('');
      if (prop === 'attr') return (n) => obj.attr(String(n));
      if (prop === 'html') return () => obj.html();
      if (prop === 'toString') return () => String(obj);
      if (prop === Symbol.toPrimitive) return () => String(obj);
      if (prop === 'tagName' || prop === 'nodeName') return obj[0] ? (obj[0].name || '') : '';
      const v = obj[prop];
      if (typeof v === 'function') return (...args) => wrap(v.apply(obj, args));
      return v;
    },
    has(t, prop) { return typeof prop === 'string' && /^\d+$/.test(prop) ? prop in t : prop in obj; },
  });
  return proxyRef;
}

/** 当前中间态 → 交给 JS 块当 `result` 的值（对齐 Legado evalJS 的 result 形参） */
function jsResultValue($, state) {
  if (!state) return '';
  if (state.elems && state.elems.length) return makeDomProxy($, state.elems, true);
  if (state.items) return state.items;
  if (state.strings) return state.strings.join('\n');
  return '';
}

/**
 * 页面级规则的初始 `result` = **整页 HTML**。
 *
 * Legado `AnalyzeRule.setContent(body)` 把响应体塞进 `content`，`getString/getStringList`
 * 在 `mContent == null` 时用 `this.content` 起手（`AnalyzeRule.kt:207` `val content = mContent ?: this.content`）。
 * 所以「没有 root、没有 result0」的规则，JS 块里的 `result` 拿到的是页面 HTML 串，不是空串。
 *
 * 反例（本实现的真实 bug）：7908 神文小说 `ruleContent.content = "@js:var s=''+result;…"`，
 * `result` 为空 → 正则一条都匹配不到 → 正文 0 字。同类还有 7908 的 `coverUrl`、
 * 7940 uu书库的 `bookList = "@js:(function(){var html=String(result);…})()"`。
 */
function pageHtmlOf($) {
  if (!$) return '';
  if (typeof $.__srcHtml === 'string') return $.__srcHtml;
  try {
    return $.html() || '';
  } catch (_) {
    return '';
  }
}

/** 构造页面级规则的初始中间态 */
function initialPageState($, opts) {
  if (opts.root) return { elems: opts.root };
  if (opts.result0 != null) return { strings: [String(opts.result0)] };
  const html = pageHtmlOf($);
  return html ? { strings: [html] } : null;
}

/**
 * 列表规则结果 → 待逐项解析的目标数组。
 *
 * Legado `BookChapterList.kt:203,232` 里 `analyzeRule.getElements(listRule)` 拿到的
 * `List<Any>` 实际有三种元素类型，取字段时各走一条路：
 *   - jsoup Element      → `setContent(item)` 后求值
 *   - NativeObject       → 键名 / `@js:` / JSONPath 直取
 *   - String（HTML 片段）→ 重新解析成文档后求值
 *
 * @returns {Array<{kind:'elem'|'item'|'html', value:any}>}
 */
function listTargets($, res) {
  const out = [];
  if (!res) return out;
  if (res.items && res.items.length) {
    for (const it of res.items) out.push({ kind: 'item', value: it });
    return out;
  }
  if (res.elems && res.elems.length) {
    for (const el of res.elems.toArray()) out.push({ kind: 'elem', value: $(el) });
    return out;
  }
  const ss = res.strings || [];
  // 整串含标签 → 当 HTML 片段解析；否则当纯文本（`text` 规则直接返回原文）
  const looksHtml = ss.some((s) => /<[a-zA-Z][^>]*>/.test(String(s)));
  for (const s of ss) {
    if (s === '' || s == null) continue;
    out.push(looksHtml ? { kind: 'html', value: String(s) } : { kind: 'text', value: String(s) });
  }
  return out;
}

/** JS 返回值 → 中间态 */
function stateFromJs(v, $) {
  if (v == null) return { strings: [] };
  if (typeof v === 'string') return { strings: v.split('\n') };
  if (typeof v === 'number' || typeof v === 'boolean') return { strings: [String(v)] };
  if (Array.isArray(v)) {
    const domLike = v.length > 0 && v.every((x) => x && typeof x === 'object' && typeof x.type === 'string' && (typeof x.name === 'string' || x.type === 'root'));
    if (domLike) {
      const coll = $(v);
      return { elems: coll, strings: elemsToStrings($, coll, 'text') };
    }
    if (!v.length) return { strings: [] };
    const objLike = v.every((x) => x && typeof x === 'object');
    if (objLike) {
      // JS 对象条目（如起点目录规则的 {text, href, info, vip, volume}）：
      // 结构必须保留，交给引擎按 Legado 的 NativeObject 快捷路径取键值。
      return { items: v, strings: v.map((x) => (x.text == null ? '' : String(x.text))) };
    }
    return { strings: v.map((x) => (x == null ? '' : String(x))) };
  }
  if (typeof v === 'object') return { items: [v], strings: [v.text == null ? '' : String(v.text)] };
  return { strings: [String(v)] };
}

/**
 * 组合符合并（Legado `AnalyzeByJSoup.getStringList` / `getElements` 的收尾分支）：
 *   `%%` → 以 results[0] 为准按下标交错；`&&` 与无操作符 → 直接 `addAll` 并联。
 */
function mergeResults(results, op, $) {
  if (!results.length) return { strings: [], elems: null, items: null, text: '' };
  if (results.length === 1) return results[0];
  const allElems = results.every((r) => r.elems && r.elems.length);
  if (allElems) {
    const lists = results.map((r) => r.elems.toArray());
    const arr = [];
    if (op === '%%') {
      for (let i = 0; i < lists[0].length; i++) for (const l of lists) if (i < l.length) arr.push(l[i]);
    } else {
      for (const l of lists) arr.push(...l);
    }
    const coll = $(arr);
    return { strings: elemsToStrings($, coll, 'text'), elems: coll, items: null, text: '' };
  }
  const lists = results.map((r) => r.strings);
  const out = [];
  if (op === '%%') {
    for (let i = 0; i < lists[0].length; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  } else {
    for (const l of lists) out.push(...l);
  }
  return { strings: out, elems: null, items: null, text: out.filter((s) => s !== '').join('\n') };
}

/* ------------------------------------------------------------------ *
 * 2. 简写选择器 → CSS
 * ------------------------------------------------------------------ */

function isAllDigits(s) { return /^\d+$/.test(s); }

/* ------------------------------------------------------------------ *
 * 2b. 索引语法（Legado ElementsSingle.findIndexSet 的逐行移植）
 *
 * 两套写法（AnalyzeByJSoup.kt:282-292 文档注释 + :406-510 实现）：
 *   1. 阅读原有写法：':' 分隔索引，'!' 或 '.' 表示筛选方式，索引可为负
 *        如 tag.div.-1:10:2  或  tag.div!0:3
 *   2. jsonPath 风格 [] 写法：'[it,it,...]'，'[!' 开头表示排除；
 *        区间为 start:end 或 start:end:step（start=0/end=-1 可省略），负索引受支持
 *        如 tag.div[-1, 3:-2:-10, 2]；特殊用法 tag.div[-1:0] 可让列表反向
 *
 * 注意：以 ']' 结尾时走 [] 分支，但逆向扫描遇到「第一个非数字字符且尚无数字」会
 * 立即 break —— 这正是 [property="og:novel:author"] 这类纯 CSS 属性选择器不被
 * 误判为索引语法的原因（AnalyzeByJSoup.kt:441-443）。
 * 返回值：{ beforeRule, split, indexDefault, indexes }
 *   split: '.' 选择 | '!' 排除 | ' ' 不筛选（无索引语法）
 *   indexes 元素为 number（单索引）或 { start, end, step }（区间）
 * ------------------------------------------------------------------ */
function findIndexSet(rule) {
  const rus = String(rule == null ? '' : rule).trim();
  let len = rus.length;
  let curInt = null;
  let curMinus = false;
  const curList = [];
  let l = '';
  const indexDefault = [];
  const indexes = [];
  let split = '.';
  let beforeRule = '';

  const isDigit = (c) => c >= '0' && c <= '9';

  if (rus.length > 0 && rus[rus.length - 1] === ']') {
    // ---- 常规索引写法 [index...] ----
    len--; // 跳过尾部 ']'
    while (len-- >= 0) {
      let rl = rus[len];
      if (rl === ' ') continue;

      if (isDigit(rl)) { l = rl + l; continue; }
      if (rl === '-') { curMinus = true; continue; }

      curInt = l === '' ? null : (curMinus ? -parseInt(l, 10) : parseInt(l, 10));

      if (rl === ':') {
        curList.push(curInt); // 区间右端或区间间隔
      } else {
        // 为保证查找顺序，区间和单个索引都添加到同一集合
        if (curList.length === 0) {
          if (curInt === null) break; // 是 jsoup 选择器而非索引列表，跳出
          indexes.push(curInt);
        } else {
          // 列表最后压入的是区间右端，若有两位则最先压入的是间隔
          indexes.push({
            start: curInt,
            end: curList[curList.length - 1],
            step: curList.length === 2 ? curList[0] : 1,
          });
          curList.length = 0; // 重置，避免影响下个区间
        }

        if (rl === '!') {
          split = '!';
          do { rl = rus[--len]; } while (len > 0 && rl === ' '); // 跳过所有空格
        }
        if (rl === '[') { beforeRule = rus.substring(0, len); return { beforeRule, split, indexDefault, indexes }; }
        if (rl !== ',') break; // 非索引结构，跳出
      }

      l = '';
      curMinus = false;
    }
  } else {
    // ---- 阅读原本写法 ----
    while (len-- >= 0) {
      const rl = rus[len];
      if (rl === ' ') continue;

      if (isDigit(rl)) { l = rl + l; continue; }
      if (rl === '-') { curMinus = true; continue; }

      if (rl === '!' || rl === '.' || rl === ':') {
        indexDefault.push(curMinus ? -parseInt(l, 10) : parseInt(l, 10));
        if (rl !== ':') {
          split = rl;
          beforeRule = rus.substring(0, len);
          return { beforeRule, split, indexDefault, indexes };
        }
      } else break; // 非索引结构，跳出

      l = '';
      curMinus = false;
    }
  }

  split = ' ';
  beforeRule = rus; // 无索引，原样返回全部
  return { beforeRule, split, indexDefault, indexes };
}

/** [attr~=regex] 是 jsoup 特有语法，cheerio/css-select 不支持，需摘出来单独过滤 */
const REGEX_ATTR_RE = /\[\s*([\w:-]+)\s*~=\s*([^\]]*?)\s*\]/g;

function splitRegexAttrs(sel) {
  const conds = [];
  const rest = String(sel).replace(REGEX_ATTR_RE, (_m, name, pat) => {
    conds.push({ name, pat });
    return '';
  });
  return { rest: rest.trim(), conds };
}

function applyRegexAttrs($, els, conds) {
  let out = els;
  for (const c of conds) {
    const re = safeRegExp(c.pat);
    out = out.filter((_i, el) => {
      const v = $(el).attr(c.name) || '';
      return re ? re.test(v) : v === c.pat;
    });
  }
  return out;
}

/** getElementsSingle 里 beforeRule 的前置选择（AnalyzeByJSoup.kt:310-322） */
function selectByBeforeRule($, base, beforeRule) {
  const b = beforeRule == null ? '' : beforeRule;
  const root = base || $.root();

  if (b === '') return root.children(); // 前置规则为空 → children（允许索引直接作根）

  const rules = b.split('.');
  switch (rules[0]) {
    case 'children': return root.children();
    case 'class': return root.find('.' + rules[1]);
    case 'tag': return root.find(rules[1]);
    case 'id': return root.find('#' + rules[1]);
    case 'text': return findBylext($, root, rules.slice(1).join('.'));
    default: break;
  }

  const { rest, conds } = splitRegexAttrs(b);
  const sel = rest === '' ? '*' : rest;
  let els;
  try {
    els = base ? root.find(sel) : $(sel);
  } catch (_) {
    els = $();
  }
  if (conds.length) els = applyRegexAttrs($, els, conds);
  return els;
}

/** 索引筛选（AnalyzeByJSoup.kt:324-400） */
function applyIndexSet($, els, parsed) {
  const { split, indexDefault, indexes } = parsed;
  if (split === ' ') return els; // 无索引语法 → 原样返回

  const arr = els.toArray();
  const len = arr.length;
  const picked = [];
  const seen = new Set();
  const push = (v) => { if (!seen.has(v)) { seen.add(v); picked.push(v); } };

  const lastIndexes = indexDefault.length > 0 ? indexDefault.length - 1 : indexes.length - 1;

  const addSingle = (it) => {
    if (it >= 0 && it < len) push(it);
    else if (it < 0 && len >= -it) push(it + len);
  };

  if (indexes.length === 0) {
    // 非 [] 式：集合是逆向遍历插入的，故逆向遍历以还原顺序
    for (let ix = lastIndexes; ix >= 0; ix--) addSingle(indexDefault[ix]);
  } else {
    for (let ix = lastIndexes; ix >= 0; ix--) {
      const item = indexes[ix];
      if (item && typeof item === 'object') {
        let start = item.start == null ? 0 : item.start;
        if (start < 0) start += len;
        let end = item.end == null ? (len - 1) : item.end;
        if (end < 0) end += len;

        if ((start < 0 && end < 0) || (start >= len && end >= len)) continue; // 同侧越界无效

        if (start >= len) start = len - 1; else if (start < 0) start = 0;
        if (end >= len) end = len - 1; else if (end < 0) end = 0;

        if (start === end || item.step >= len) { push(start); continue; }

        const step = item.step > 0 ? item.step : (-item.step < len ? item.step + len : 1);
        if (end > start) { for (let v = start; v <= end; v += step) push(v); }
        else { for (let v = start; v >= end; v -= step) push(v); }
      } else {
        addSingle(item);
      }
    }
  }

  if (split === '!') {
    const drop = new Set(picked);
    return $(arr.filter((_el, i) => !drop.has(i)));
  }
  // split === '.' → 按 indexSet 顺序选择
  return $(picked.map((i) => arr[i]).filter(Boolean));
}

/**
 * 单段求值：findIndexSet 解析 → beforeRule 选元素 → 索引筛选。
 * 对应 Legado `ElementsSingle().getElementsSingle(temp, seg)`。
 */
function selectSingle($, base, seg) {
  const parsed = findIndexSet(seg);
  const els = selectByBeforeRule($, base, parsed.beforeRule);
  return applyIndexSet($, els, parsed);
}

/**
 * 翻译「默认文法」的选择器段。
 * @returns {{css:string, index:number|null, textMatch:string|null, idMatch:string|null}}
 */
function translateSelector(seg) {
  let s = seg.trim();
  let index = null;
  let textMatch = null;
  let idMatch = null;

  // 去掉尾部 .N 索引（class.a.b.0 → class.a.b + index 0）
  // 但 .0.1 这种多级索引只取最后一个（Legado 只支持一级）
  const parts = s.split('.');
  if (parts.length > 1 && isAllDigits(parts[parts.length - 1])) {
    index = parseInt(parts.pop(), 10);
    s = parts.join('.');
  }

  if (s.startsWith('class.')) {
    const cls = s.slice(6);
    const list = cls.split('.').filter(Boolean);
    return { css: list.map((c) => '.' + c).join(''), index, textMatch, idMatch };
  }
  if (s.startsWith('id.')) {
    const id = s.slice(3).split('.').filter(Boolean);
    idMatch = id[0];
    return { css: '#' + id.join('.').replace(/\./g, '\\x2e'), index, textMatch, idMatch };
  }
  if (s.startsWith('tag.')) {
    const rest = s.slice(4).split('.').filter(Boolean);
    const tag = rest.shift();
    return { css: tag + rest.map((c) => '.' + c).join(''), index, textMatch, idMatch };
  }
  if (s.startsWith('text.')) {
    textMatch = s.slice(5);
    return { css: '*', index, textMatch, idMatch };
  }
  if (s.startsWith('@')) {
    return { css: s.slice(1), index, textMatch, idMatch };
  }
  return { css: s, index, textMatch, idMatch };
}

/** 该段是否是「选择器段」 */
function looksLikeSelector(seg) {
  const s = seg.trim();
  if (!s) return false;
  if (/^(class|id|tag|text)\./.test(s)) return true;
  // 纯数字 = 索引，不是选择器
  if (isAllDigits(s)) return false;
  // 以 . # [ : > + ~ * 或字母开头的 CSS
  if (/^[.#\[:>+~*]/.test(s)) return true;
  if (/^[a-zA-Z][\w-]*(\.[\w-]+|#[\w-]+|\[[^\]]*\])*$/.test(s)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * 3. 提取操作
 * ------------------------------------------------------------------ */

const TEXT_OPS = new Set(['text', 'textNodes', 'ownText', 'all', 'textContent']);
const HTML_OPS = new Set(['html', 'innerHtml', 'outerHtml']);
const ATTR_OPS = new Set(['href', 'src', 'content', 'value', 'title', 'alt', 'data-src', 'data-original']);
const META_OPS = new Set(['tag', 'js', 'js:', 'css:', 'xpath:', 'json:', 'rule:', 'get:', 'put:']);

/**
 * 判断一个段是否是「提取动作」而非选择器。
 * 只有这些固定名字才算：text/html/href/src/content/value/title/all/ownText/textNodes/tag
 */
function classifySegment(seg) {
  const s = seg.trim();
  if (s === '') return { kind: 'noop' };
  if (s.startsWith('##')) return { kind: 'regexReplace', raw: s };
  if (s.startsWith('#!')) return { kind: 'regexKeep', raw: s };
  if (isAllDigits(s)) return { kind: 'index', index: parseInt(s, 10) };
  if (s === 'js' || s.startsWith('js:')) return { kind: 'js', code: s === 'js' ? '' : s.slice(3) };
  if (s === 'css' || s.startsWith('css:')) return { kind: 'css', sel: s === 'css' ? '' : s.slice(4) };
  if (s === 'xpath' || s.startsWith('XPath:') || s.startsWith('xpath:')) {
    return { kind: 'xpath', expr: s.replace(/^(XPath|xpath):?/, '') };
  }
  if (s.startsWith('json:')) return { kind: 'json', path: s.slice(5) };
  if (s.startsWith('rule:')) return { kind: 'subrule', rule: s.slice(5) };
  if (TEXT_OPS.has(s)) return { kind: 'text', mode: s };
  if (HTML_OPS.has(s)) return { kind: 'html', mode: s };
  if (s === 'tag') return { kind: 'tagName' };
  // 常见属性名，或看起来像属性名（data-*）
  if (ATTR_OPS.has(s) || /^data-[a-z0-9-]+$/i.test(s)) return { kind: 'attr', name: s };
  return null; // 交给选择器判断
}

/* ------------------------------------------------------------------ *
 * 4. 求值上下文
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Ctx
 * @property {string} baseUrl     书源 baseUrl
 * @property {object} source      书源对象
 * @property {object} book        当前书籍（JS 中可用）
 * @property {import('./jsrt').JsRuntime} [js]  JS 运行时（存在则可跑 @js:）
 * @property {(s:string)=>string} [expand]      {{...}} 展开器
 */

/* ------------------------------------------------------------------ *
 * 5. 核心求值：把规则作用于 cheerio 元素集合
 * ------------------------------------------------------------------ */

/** 对 cheerio 集合取字符串（每个元素一个结果） */
/**
 * 元素 → 字符串数组。
 *
 * 逐行对齐 Legado `AnalyzeByJSoup.getResultLast`（AnalyzeByJSoup.kt:229-280）：
 *   text / ownText —— **只 add 非空值**（`if (text.isNotEmpty())`）；
 *   textNodes —— 每个文本节点 trim 后非空才收，再 `joinToString("\n")`，整组非空才 add；
 *   html —— 先删 script/style 再 outerHtml，非空才 add；
 *   all —— 直接 add `elements.outerHtml()`（不做非空判断）。
 * 属性取值走 attrToStrings（另有空白与去重规则）。
 *
 * cheerio 没有 `outerHtml()`，多元素序列化用 `$.html(selection)`；`html` 模式需要先删
 * script/style，所以把 HTML 文本重新 parse 成一棵独立的树再删，避免污染原 DOM。
 */
function elemsToStrings($, elems, mode, op) {
  if (mode === 'all') {
    const html = $.html(elems);
    return [html == null ? '' : String(html)];
  }
  if (mode === 'html' || mode === 'outerHtml') {
    // 复刻：elements.select("script").remove(); elements.select("style").remove()
    const tree = cheerio.load($.html(elems) || '', null, false);
    tree('script').remove();
    tree('style').remove();
    const html = tree.root().html() || '';
    return html.length ? [String(html)] : [];
  }
  const out = [];
  elems.each((_, el) => {
    const $el = $(el);
    let v = '';
    if (mode === 'text') v = $el.text();
    else if (mode === 'ownText') v = $el.contents().filter((_i, n) => n.type === 'text').text();
    else if (mode === 'textNodes') {
      // 每个 text 节点 trim 后非空才收，join '\n'
      const parts = [];
      $el.contents().each((_i, n) => {
        if (n.type !== 'text') return;
        const t = String(n.data == null ? '' : n.data).trim();
        if (t) parts.push(t);
      });
      if (parts.length) out.push(parts.join('\n'));
      return;
    } else if (mode === 'innerHtml') {
      const s = $el.html() || '';
      if (s.length) out.push(s);
      return;
    } else if (mode === 'textContent') v = $el.text();
    else v = $el.text();
    const s = v == null ? '' : String(v);
    if (s.length) out.push(s); // Legado：空值不入列
  });
  return out;
}

/**
 * 属性取值（逐行对齐 AnalyzeByJSoup.getResultLast 的 else 分支）：
 *   `val url = element.attr(lastRule)`；
 *   `if (url.isBlank() || textS.contains(url)) continue` —— **空值跳过，且结果内去重**。
 * 另外保留 src/href 的 data-* 退化（Legado 侧由 AnalyzeRule 的 @get 兜底处理）。
 */
function attrToStrings($, elems, name) {
  const out = [];
  elems.each((_, el) => {
    const $el = $(el);
    let v = $el.attr(name);
    if (v == null && (name === 'src' || name === 'href')) v = $el.attr('data-' + name);
    if (v == null) return;
    const s = String(v);
    if (!s.trim()) return; // isBlank() → continue
    if (out.includes(s)) return; // textS.contains(url) → continue
    out.push(s);
  });
  return out;
}

/**
 * 对一组「中间结果」继续应用剩余段。
 * 中间结果统一表示为 { elems: cheerio 集合 } 或 { strings: [] }
 */
function toElems($, x) {
  if (x && x.elems) return x.elems;
  return $(); // 空集合
}
function toStrings($, x) {
  if (!x) return [];
  if (x.strings) return x.strings;
  if (x.elems) return elemsToStrings($, x.elems, 'text');
  return [];
}
/**
 * 求值主入口。
 *
 * 求值顺序严格对齐 Legado：
 *   1. `AnalyzeRule.splitSourceRule` 先按 `JS_PATTERN` 把 `<js>` / `@js:` 块摘出来
 *      （见 `splitJsBlocks`），每块成为独立片段；
 *   2. 其余文本片段各自按 `##` 拆正则 → 交给 `evalRuleCore` 求值；
 *   3. 片段之间**串联**：前一片段的输出作为后一片段的输入（JS 片段拿它当 `result`）。
 *
 * @param {string} rule
 * @param {import('cheerio').CheerioAPI} $
 * @param {Ctx} ctx
 * @param {object} [opts] { root: cheerio 集合作为起点, result0: 初始字符串, asHtml }
 * @returns {{strings:string[], elems:any|null, items:any[]|null, text:string}}
 */
function evalRule(rule, $, ctx = {}, opts = {}) {
  const rawFull = String(rule == null ? '' : rule).trim();
  if (!rawFull) return emptyResult();

  const blocks = splitJsBlocks(rawFull);
  if (!blocks.length) return emptyResult();

  // 单片段：绝大多数规则走这里，与原路径完全一致
  if (blocks.length === 1) {
    if (blocks[0].type === 'js') {
      return resultFromState($, runJsBlock(blocks[0].code, $, ctx, opts,
        initialPageState($, opts)), ctx);
    }
    return evalRuleText(blocks[0].text, $, ctx, opts);
  }

  let state = initialPageState($, opts);

  for (const b of blocks) {
    if (b.type === 'js') {
      state = runJsBlock(b.code, $, ctx, opts, state);
    } else {
      const r = evalRuleText(b.text, $, ctx, stateOpts(state, opts));
      state = { elems: r.elems, strings: r.strings, items: r.items };
    }
  }
  return resultFromState($, state, ctx);
}

function emptyResult() { return { strings: [], elems: null, items: null, text: '' }; }

/** 单个「纯文本」片段：先按整条规则拆 `##` 正则，再求值，最后统一施加替换 */
function evalRuleText(text, $, ctx, opts) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return emptyResult();

  // ---------------------------------------------------------------
  // `##` 正则替换：Legado 把 `##regex##replacement` 挂在【整条规则】上，
  // 拆出后本体才参与求值，替换在求值【之后】统一施加到结果字符串上。
  // 见 legado 源码 AnalyzeRule.kt:768-779（makeUpRule）+ :491-514（replaceRegex）：
  //   val ruleStrS = rule.split("##"); rule = ruleStrS[0].trim()
  //   if (size > 1) replaceRegex = [1]; if (size > 2) replacement = [2]; if (size > 3) replaceFirst = true
  // 第 4 段存在（即 3 个以上 `##`）时进入 replaceFirst 分支（replaceRegex.find 后只换首处）。
  // ---------------------------------------------------------------
  if (raw.indexOf('##') < 0) return evalRuleCore(raw, $, ctx, opts);

  const parts = raw.split('##');
  const body = parts[0].trim();
  const replaceRegex = parts.length > 1 ? parts[1] : '';
  const replacement = parts.length > 2 ? parts[2] : '';
  const replaceFirst = parts.length > 3;

  const res = body ? evalRuleCore(body, $, ctx, opts) : emptyResult();
  const apply = (s) => replaceRegex ? applyReplaceRegex(String(s), replaceRegex, replacement, replaceFirst) : String(s);
  if (res.strings.length) res.strings = res.strings.map(apply);
  if (res.elems) res.text = apply(res.text);
  else res.text = res.strings.filter((s) => s !== '').join('\n');
  return res;
}

/** 跑一个 JS 片段，返回新的中间态 */
function runJsBlock(code, $, ctx, opts, state) {
  if (!ctx.js) return { strings: [] };
  const resultVal = jsResultValue($, state);
  const srcStr = state && state.elems ? String(state.elems)
    : state && state.strings ? state.strings.join('\n') : '';
  const vars = { result: resultVal, src: srcStr, ...ctx };
  const v = ctx.js.runRaw ? ctx.js.runRaw(code, vars) : ctx.js.run(code, vars);
  return stateFromJs(v, $);
}

/** 前一片段的输出 → 后一文本片段的输入 opts */
function stateOpts(state, opts) {
  if (!state) return opts;
  if (state.elems) return { ...opts, root: state.elems };
  if (state.items) return { ...opts, root: null, items0: state.items };
  return { ...opts, root: null, result0: state.strings.join('\n'), asHtml: true };
}

function resultFromState($, state, ctx) {
  const out = emptyResult();
  if (!state) return out;
  if (state.items) {
    out.items = state.items;
    out.strings = state.items.map((x) => (x && x.text != null ? String(x.text) : ''));
  } else if (state.elems) {
    out.elems = state.elems;
    out.strings = elemsToStrings($, state.elems, 'text');
  } else if (state.strings) {
    out.strings = state.strings.slice();
  }
  if (ctx.expand) out.strings = out.strings.map((s) => ctx.expand(s));
  out.text = out.strings.filter((s) => s !== '').join('\n');
  return out;
}

/**
 * 从 JS 对象条目上按 Legado 的 NativeObject 快捷路径取值（`AnalyzeRule.kt:314-330`）：
 *   `@js:` → `evalJS(rule, result)`；`$.x`/`@json:` → JSONPath；其余 → `result[rule]` 键值直取。
 */
function pickItemField(item, rule, ctx) {
  let s0 = String(rule == null ? '' : rule).trim();
  if (!s0 || item == null) return '';
  // `{{...}}` 模板展开（Legado：{{}} 先于规则求值，块内 JS 的 `$`/`result` = 当前条目）。
  // 真实用例：书旗小说 8011 bookUrl = `@js:…bookId = "{{$.bookId||$.bid}}";…`
  if (s0.includes('{{') && ctx && ctx.js) {
    s0 = s0.replace(/\{\{([\s\S]*?)\}\}/g, (_m, code) => {
      try {
        const v = ctx.js.run(String(code).trim(), { result: item, $: item, ...ctx });
        if (v == null) return '';
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      } catch (_) { return ''; }
    });
  }
  // `||` 组合：依次尝试每个备选，首个非空即用（Legado 组合符语义）。
  // 真实用例：长佩文学 8011 字段 `$.novel_name||$.name##<.*?>` —— 缺了这条路，
  // 每个条目所有字段都解出空，搜索结果整批被丢。
  // `@js:` / `<js>` 规则体内的 `||` 属于代码，不拆。
  const alts = s0.includes('||') && !s0.startsWith('@js:') && !s0.startsWith('<js>')
    ? s0.split('||')
    : [s0];
  for (const alt of alts) {
    const v = pickItemFieldSingle(item, alt.trim(), ctx);
    if (v !== '' && v != null) return v;
  }
  return '';
}

/** pickItemField 的单条路径（不含 `||` 组合） */
function pickItemFieldSingle(item, s0, ctx) {
  if (!s0 || item == null) return '';
  // `##regex##replacement` 后缀：Legado 挂在【整条规则】上，键值直取 / JSONPath
  // 路径同样适用（真实用例：搬山人 bookUrl = `$.slug##^(.+)$##https://…/novel/$1`）。
  // `@js:` 规则体内的 `##` 属于代码，不拆。
  let s = s0;
  let rx = null;
  if (s0.indexOf('##') >= 0 && !s0.startsWith('@js:') && !s0.startsWith('<js>')) {
    const parts = s0.split('##');
    s = parts[0].trim();
    rx = parts.slice(1);
  }
  let v;
  if (s.startsWith('@js:') || s.startsWith('<js>')) {
    if (!ctx || !ctx.js) return '';
    const code = s.startsWith('@js:') ? s.slice(4) : s.replace(/^<js>/, '').replace(/<\/js>$/, '');
    v = ctx.js.runRaw ? ctx.js.runRaw(code, { result: item, ...ctx }) : ctx.js.run(code, { result: item, ...ctx });
    v = v == null ? '' : v;
  } else if (s.startsWith('$.') || s.startsWith('$[') || /^@json:/i.test(s)) {
    try { v = jsonPath(JSON.stringify(item), s.replace(/^@json:/i, '')); } catch (_) { v = ''; }
  } else {
    v = item[s];
  }
  if (rx && rx.length >= 2) {
    v = applyReplaceRegex(v == null ? '' : String(v), rx[0], rx[1] == null ? '' : rx[1], rx.length >= 3);
  }
  return v == null ? '' : v;
}

/**
 * Legado `AnalyzeRule.replaceRegex`（AnalyzeRule.kt:491-514）逐字复刻。
 * replaceFirst 为真时只替换首个匹配（且返回匹配片段本身）；否则全局替换。
 * 正则编译失败时退回字面量替换。
 */
function applyReplaceRegex(input, replaceRegex, replacement, replaceFirst) {
  let re = null;
  try { re = new RegExp(replaceRegex, replaceFirst ? '' : 'g'); } catch (_) { re = null; }
  if (!re) {
    // 编译失败 → 字面量替换
    if (!replaceFirst) return String(input).split(replaceRegex).join(replacement);
    const i = String(input).indexOf(replaceRegex);
    if (i < 0) return String(input);
    return String(input).slice(0, i) + replacement + String(input).slice(i + replaceRegex.length);
  }
  if (!replaceFirst) return String(input).replace(re, replacement);
  const m = re.exec(String(input));
  return m ? m[0].replace(new RegExp(replaceRegex), replacement) : '';
}

function evalRuleCore(raw, $, ctx = {}, opts = {}) {
  const result = emptyResult();

  // JS 对象条目（Legado NativeObject 快捷路径）：把规则当键名/JS/JSONPath 直接取值
  if (opts.item && typeof opts.item === 'object') {
    const v = pickItemField(opts.item, raw, ctx);
    result.strings = [v == null ? '' : String(v)];
    result.text = result.strings.filter((s) => s !== '').join('\n');
    return result;
  }
  if (opts.items0 && opts.items0.length) {
    const vals = opts.items0.map((it) => pickItemField(it, raw, ctx));
    result.strings = vals.map((v) => (v == null ? '' : String(v)));
    result.text = result.strings.filter((s) => s !== '').join('\n');
    return result;
  }

  // 前缀抽取（Legado `SourceRule` 构造时的 mode 判定，AnalyzeRule.kt:609-643）
  //   显式前缀 > isJSON/startsWith("$.")/startsWith("$[") 自动判 Json > 原样
  let prefix = null;
  let body = raw;
  let m = /^@(css|XPath|xpath|json|rule):/.exec(raw);
  if (m) {
    prefix = m[1].toLowerCase();
    body = raw.slice(m[0].length);
  } else if (raw.startsWith('$.') || raw.startsWith('$[') || /^\.\[/.test(raw)) {
    // Legado 会把 `$.author` / `$[0].name` 这类规则自动当作 JSONPath。
    // 真实书源里非 `@json:` 前缀的写法很常见：番茄小说 17 处、纸间 7 处；
    // `.[?(@.k)]`（省略 $ 的过滤器写法）也有：书旗小说 8011。
    prefix = 'json';
    body = raw;
  }

  // 顶层组合符：`RuleAnalyzer.splitRule("&&","||","%%")` 取**文本中最先出现**的那一个，
  // 整串只用它切分（见 firstComboOp 注释）。
  const combo = firstComboOp(body);
  if (combo) {
    const parts = splitOp(body, combo.op);
    const results = [];
    for (const p of parts) {
      const r = evalRule(p, $, ctx, opts);
      const nonEmpty = (r.elems && r.elems.length) || (r.items && r.items.length) || r.strings.some((s) => s !== '');
      if (nonEmpty) results.push(r);
      if (combo.op === '||' && nonEmpty) break;
    }
    if (!results.length) return result; // 全空：与 Legado 一致（results 为空 → 无输出）
    if (combo.op === '||') return results[0];
    return mergeResults(results, combo.op, $);
  }

  // 段切分
  const segs = splitTop(body, '@');
  let state = null; // {elems} | {strings} | {items}
  let startIdx = 1; // 后续段起始下标（单段提取动作时从 0 开始）

  // 第一段
  const first = segs[0] == null ? '' : segs[0];
  // 单段且是「提取动作」（text/href/html/tag/索引/切片…）：
  // Legado 的 getResultList 在 rules.size==1 时循环不执行，直接把最后一段当 lastRule 作用于 element 本身。
  // 例：chapterName="text"、chapterUrl="href" → 对当前元素取文本/属性，而不是去找名为 <text>/<href> 的标签。
  const onlyExtract = segs.length === 1 && first.trim() !== '' && (() => {
    const c = classifySegment(first);
    return !!(c && c.kind !== 'noop');
  })();

  if (onlyExtract) {
    state = opts.root ? { elems: opts.root }
      : opts.result0 != null ? { strings: [String(opts.result0)] }
      : { elems: $.root() };
    startIdx = 0;
  } else if (prefix === 'css') {
    state = { elems: opts.root ? opts.root.find(first) : $(first) };
    if (opts.root && first === '') state = { elems: opts.root };
  } else if (prefix === 'xpath') {
    state = { strings: xpathEval($, opts.root || $.root(), first) };
  } else if (prefix === 'json') {
    // JSON 规则的取值来源：显式 result0 > 页面原文（JSON API 响应走 search/content
    // 时以原文本形式挂在 $.__srcHtml 上，此前没传 result0 时这里恒为空串，
    // 导致 `$.model.data[*]` 这类 JSON API 书源全部解不出 —— 实测搬山人 8023）。
    const src = opts.result0 != null ? String(opts.result0) : pageHtmlOf($);
    const vals = jsonPathValues(src, first);
    // 列表语义：匹配结果整体是「对象或对象数组」时按条目产出（对齐 Legado
    // getElements 对 JSON 列表返回 List<Map>），引擎才能逐条取 name/bookUrl。
    const objs = [];
    for (const v of vals) {
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') objs.push(x); }
      else if (v && typeof v === 'object') objs.push(v);
    }
    if (objs.length) state = { items: objs };
    else state = { strings: vals.map((v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))) };
  } else if (first.trim() === '' && segs.length > 1) {
    // 以 @ 开头：直接对 root 做后续操作
    state = opts.root ? { elems: opts.root }
      : opts.result0 != null ? { strings: [String(opts.result0)] }
      : { elems: $.root() };
  } else if (opts.asHtml && opts.result0) {
    // 上一片段产出的是 HTML 字符串：重新解析后当文档用
    const doc = cheerio.load(String(opts.result0), null, false);
    state = { elems: selectSingle(doc, doc.root(), first) };
  } else if (opts.result0 != null) {
    // 有初始字符串却给了选择器规则：Legado `getAnalyzeByJSoup(result)` 会把字符串当文档解析
    const doc = cheerio.load(String(opts.result0), null, false);
    state = { elems: selectSingle(doc, doc.root(), first) };
  } else {
    // 默认文法：把该段当作单段规则（beforeRule 选择器 + 索引语法）处理
    const base = opts.root || $.root();
    state = { elems: selectSingle($, base, first) };
  }

  // 后续段
  for (let i = startIdx; i < segs.length; i++) {
    const seg = segs[i];
    const cls = classifySegment(seg);
    if (cls && cls.kind === 'noop') continue;

    if (cls && cls.kind === 'text') {
      if (state && state.strings && !state.elems) continue; // 已是字符串态：文本动作无操作
      state = { strings: elemsToStrings($, toElems($, state), cls.mode) };
      continue;
    }
    if (cls && cls.kind === 'html') {
      if (state && state.strings && !state.elems) continue;
      state = { strings: elemsToStrings($, toElems($, state), 'html') };
      continue;
    }
    if (cls && cls.kind === 'attr') {
      const els = toElems($, state);
      if (!els.length) continue; // 字符串态下取属性无意义
      state = { strings: attrToStrings($, els, cls.name) };
      continue;
    }
    if (cls && cls.kind === 'tagName') {
      const out = [];
      toElems($, state).each((_i, el) => out.push(el.tagName || el.name || ''));
      state = { strings: out };
      continue;
    }
    if (cls && cls.kind === 'index') {
      if (state && state.elems) state = { elems: state.elems.eq(cls.index) };
      else { const s = toStrings($, state); state = { strings: s[cls.index] == null ? [] : [s[cls.index]] }; }
      continue;
    }
    if (cls && cls.kind === 'regexReplace') {
      // 理论上不可达（`##` 已在 evalRule 入口整体拆走）。留作兜底：
      // 段内残留的 `##a##b` 按字面量处理，避免静默丢内容。
      state = { strings: toStrings($, state) };
      continue;
    }
    if (cls && cls.kind === 'regexKeep') {
      const pattern = seg.slice(2);
      const re = safeRegExp(pattern, 'g');
      state = { strings: toStrings($, state).map((s) => (re ? (s.match(re) || []).join('') : s)) };
      continue;
    }
    if (cls && cls.kind === 'js') {
      // 段内 `js` / `js:<code>`：对当前元素集合逐个跑（Legado 的 per-element setContent 语义），
      // 也可整串一次跑（结果里带 \n 时按行拆开）。
      const outAll = [];
      const per = state && state.elems ? state.elems.toArray() : [null];
      if (ctx.js) {
        for (let k = 0; k < per.length; k++) {
          const el = per[k];
          const st = state && state.elems
            ? (el ? { elems: $(el) } : { elems: $() })
            : (state && state.items ? { items: state.items, strings: state.strings }
              : { strings: [toStrings($, state)[k] != null ? toStrings($, state)[k] : toStrings($, state).join('\n')] });
          const next = runJsBlock(cls.code, $, ctx, opts, st);
          outAll.push(next);
        }
      }
      if (outAll.some((n) => n.items && n.items.length)) {
        state = { items: outAll.flatMap((n) => n.items || []), strings: outAll.flatMap((n) => n.strings) };
      } else if (outAll.some((n) => n.elems && n.elems.length)) {
        const arr = [];
        for (const n of outAll) arr.push(...n.elems.toArray());
        state = { elems: $(arr) };
      } else {
        const flat = [];
        for (const n of outAll) for (const s of n.strings) flat.push(s);
        state = { strings: flat };
      }
      continue;
    }
    if (cls && cls.kind === 'css') {
      const sel = cls.sel;
      const src = state && state.strings ? state.strings.join('\n') : '';
      const sub = sel ? cheerio.load(typeof src === 'string' ? src : '', null, false) : null;
      state = { elems: sel && sub ? sub(sel) : toElems($, state) };
      continue;
    }
    if (cls && cls.kind === 'subrule') {
      const r = evalRule(cls.rule, $, ctx, { root: toElems($, state) });
      state = { strings: r.strings, items: r.items, elems: r.elems };
      continue;
    }

    // 否则当「单段选择规则」处理（beforeRule 选择器 + 索引语法），与 Legado 的
    // getResultList 一致：除最后一段外，每段都交给 ElementsSingle.getElementsSingle。
    if (state && state.strings && !state.elems) {
      // 字符串态下遇到选择器：把字符串当作 HTML 重新解析（Legado 允许）
      const doc = cheerio.load(state.strings.join('\n'), null, false);
      state = { elems: selectSingle(doc, doc.root(), seg) };
    } else {
      state = { elems: selectSingle($, toElems($, state), seg) };
    }
    continue;
  }

  return resultFromState($, state, ctx);
}

/** 按文本内容找元素（text.xxx 简写） */
function findBylext($, root, needle) {
  const out = [];
  const want = needle.trim();
  const all = (root && root.length) || 0;
  const scan = root.find ? root.find('*') : $('*');
  scan.each((_i, el) => {
    const $el = $(el);
    const own = $el.contents().filter((_j, n) => n.type === 'text').text();
    if (own.includes(want)) { out.push(el); return; }
    if ($el.children().length === 0 && $el.text().includes(want)) out.push(el);
  });
  let sel = $(out);
  if (all) sel = sel.filter((_i, el) => true);
  return sel;
}

function safeRegExp(pattern, flags) {
  try { return new RegExp(pattern, flags); } catch (_) { return null; }
}

/** {{...}} 占位符展开（交给 JS 运行时） */
function expandBraces(s, ctx) {
  if (!s || s.indexOf('{{') < 0 || !ctx.js) return s;
  return s.replace(/\{\{([\s\S]*?)\}\}/g, (_m, code) => {
    try {
      const v = ctx.js.run(code, { ...ctx });
      return v == null ? '' : String(v);
    } catch (_) { return ''; }
  });
}

/* ------------------------------------------------------------------ *
 * 6. XPath 子集 / JSONPath 子集
 * ------------------------------------------------------------------ */

/** 极小 XPath 子集：//tag、//tag[@attr='v']、//tag/text()、//*[@id="x"] */
function xpathEval($, root, expr) {
  const e = String(expr).trim();
  let axisAttr = null;
  let m = /text\(\)\s*$/.test(e);
  const wantText = m;
  let core = e.replace(/\/text\(\)\s*$/, '');
  let attrName = null;
  const am = /\/@([\w-]+)\s*$/.exec(core);
  if (am) { attrName = am[1]; core = core.slice(0, am.index); }
  const cond = /\[@([\w-]+)\s*=\s*['"]([^'"]*)['"]\]/.exec(core);
  let css = core.replace(/\[[^\]]*\]/g, '');
  css = css.replace(/^\/+/, '').replace(/\/\//g, ' ').replace(/\//g, ' > ').trim();
  if (!css) css = '*';
  let set;
  try { set = css === '*' && root.find ? root.find('*') : (root.find ? root.find(css) : $(css)); } catch (_) { set = $(); }
  // 若是 //tag 形式，回退全局找
  if (set.length === 0 && css !== '*') {
    try { set = $(css); } catch (_) { /* ignore */ }
  }
  if (cond) set = set.filter((_i, el) => $(el).attr(cond[1]) === cond[2]);
  const out = [];
  set.each((_i, el) => {
    if (attrName) out.push($(el).attr(attrName) || '');
    else if (wantText) out.push($(el).text());
    else out.push($(el).text());
  });
  return out;
}

/** 极小 JSONPath：$.a.b[0].c、$.a[*].b、$.a、a.b —— 求值核心，匹配值原样返回（对象不串化） */
function jsonPathValues(jsonText, path) {
  if (!jsonText) return [];
  let data;
  try { data = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText; } catch (_) { return []; }
  let p = String(path).trim().replace(/^\$/, '').replace(/^\./, '');
  if (!p) return Array.isArray(data) ? data : [data];
  const tokens = [];
  // 括号感知的分段：'.' 只在括号外才是路径分隔符（`@.title`、`[?(@.a=='x.y')]`
  // 里的点属于过滤器表达式，此前裸 split('.') 会把 `[?(@.title)]` 拆碎）
  const parts = [];
  {
    let buf = '';
    let depth = 0;
    for (const ch of p) {
      if (ch === '[') depth++;
      else if (ch === ']') depth = Math.max(0, depth - 1);
      if (ch === '.' && depth === 0) { parts.push(buf); buf = ''; }
      else buf += ch;
    }
    if (buf) parts.push(buf);
  }
  for (const part of parts) {
    let rest = part;
    // 过滤器 `[?(@.key)]` / `[?(@.key=='v')]`：对数组按条件筛（真实用例：书旗小说
    // 8011 bookList = `.[?(@.bookName)]||.[?(@.title)]`）
    for (const fm of rest.matchAll(/\[\?\(@\.([^\]!~=]+)(?:\s*([!~=]=?)\s*'?\"?([^'\"]*)'?\")?\)\]/g)) {
      tokens.push({ t: 'filter', k: fm[1].trim(), op: fm[2] || '', v: fm[3] != null ? fm[3].replace(/["']/g, '') : '' });
      rest = rest.replace(fm[0], '');
    }
    const nameM = /^([^\[\]]*)/.exec(rest)[1];
    if (nameM) tokens.push({ t: 'key', k: nameM }); // 空串（"[?(…)]" 开头的过滤器段）不产生 key token
    for (const mm of rest.matchAll(/\[([^\]]*)\]/g)) {
      const inner = mm[1].trim();
      if (inner === '*') tokens.push({ t: 'wild' });
      else if (/^\d+$/.test(inner)) tokens.push({ t: 'idx', i: parseInt(inner, 10) });
      else if (/^['"].*['"]$/.test(inner)) tokens.push({ t: 'key', k: inner.slice(1, -1) });
    }
  }
  let cur = [data];
  for (const tk of tokens) {
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      if (tk.t === 'key') { if (c[tk.k] !== undefined) next.push(c[tk.k]); }
      else if (tk.t === 'idx') { if (Array.isArray(c) && c[tk.i] !== undefined) next.push(c[tk.i]); }
      else if (tk.t === 'wild') { if (Array.isArray(c)) next.push(...c); else if (typeof c === 'object') next.push(...Object.values(c)); }
      else if (tk.t === 'filter') {
        const match = (it) => {
          if (!it || typeof it !== 'object' || it[tk.k] == null) return false;
          if (!tk.op) return true;
          if (tk.op === '==') return String(it[tk.k]) === tk.v;
          if (tk.op === '!=') return String(it[tk.k]) !== tk.v;
          return false;
        };
        if (Array.isArray(c)) {
          for (const it of c) if (match(it)) next.push(it);
        } else if (typeof c === 'object') {
          // 对象根上的过滤器：递归深扫所有嵌套数组（等价 Legado `$..[?(…)]` 递归下降，
          // 真实用例：书旗小说 8011 bookList = `.[?(@.bookName)]`，books 藏在深层）
          const stack = [c];
          while (stack.length) {
            const cur2 = stack.pop();
            if (Array.isArray(cur2)) {
              for (const it of cur2) {
                if (match(it)) next.push(it);
                else if (it && typeof it === 'object') stack.push(it);
              }
            } else if (cur2 && typeof cur2 === 'object') {
              for (const v of Object.values(cur2)) {
                if (v && typeof v === 'object') stack.push(v);
              }
            }
          }
        }
      }
    }
    cur = next;
  }
  return cur;
}

/** 极小 JSONPath：$.a.b[0].c、$.a[*].b、$.a、a.b（匹配值串化后按 \n 连接） */
function jsonPath(jsonText, path) {
  const cur = jsonPathValues(jsonText, path);
  if (cur.length === 0) return '';
  if (cur.length === 1) {
    const v = cur[0];
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return cur.map((v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join('\n');
}

/* ------------------------------------------------------------------ *
 * 7. URL 处理
 * ------------------------------------------------------------------ */

/** 相对 URL 补全 */
function absUrl(base, href) {
  if (!href) return '';
  const h = String(href).trim();
  if (!h) return '';
  if (/^(https?:)?\/\//i.test(h)) {
    if (h.startsWith('//')) {
      try { return new URL(base).protocol + h; } catch (_) { return 'https:' + h; }
    }
    return h;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return h; // javascript:、data: 等原样返回
  try { return new URL(h, base).toString(); } catch (_) { return h; }
}

/** 是否是「不可用」的链接（占位、js 伪链接） */
function isBadUrl(url) {
  if (!url) return true;
  const u = String(url).trim();
  if (!u) return true;
  if (/^javascript:/i.test(u) && !/#/.test(u)) return true;
  if (u === '#' || u === 'javascript:void(0);') return true;
  return false;
}

module.exports = {
  splitTop, splitOp, firstComboOp, splitJsBlocks, translateSelector, looksLikeSelector, classifySegment,
  evalRule, absUrl, isBadUrl, expandBraces, jsonPath, jsonPathValues, xpathEval, safeRegExp,
  elemsToStrings, attrToStrings, findBylext, applyReplaceRegex,
  makeDomProxy, jsResultValue, stateFromJs, mergeResults, pickItemField, listTargets,
};
