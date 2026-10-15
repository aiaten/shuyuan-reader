'use strict';
/**
 * 网页转书源：输入小说网站地址，自动嗅探其结构并生成 Legado 3.x 书源。
 *
 * 需求原文（用户 m11556 / m11586）：
 *   「增加一个网页转书源功能，输入小说网站，就能帮忙转化成书源添加到本地书源的功能」
 *   「以笔趣阁，得奇小说为例子来添加」
 *
 * 设计：
 *   1. `probeSite(url)`   —— 抓首页，找搜索表单（GET/POST、参数名、action）
 *   2. 用搜索词去搜（或退化为分类页）拿到「书籍列表页」
 *   3. `sniffList($)`     —— 识别列表容器与各字段（书名/作者/简介/封面/最后更新）
 *   4. 进详情页 `sniffBookInfo($)` —— 书名/作者/简介/封面/分类
 *   5. `sniffToc($)`      —— 目录容器（取「一组结构相同的、指向详情页子路径的链接」）
 *   6. 进正文页 `sniffContent($)` —— 正文容器（文本密度最高的块）
 *   7. 组装成书源 JSON，交给 probe.js 六阶段闸门判定能否入库
 *
 * 关键取舍：**只用 CSS 选择器，不生成 @js 规则**。
 * 自动嗅探无法可靠地推断出站点私有的加密/签名逻辑，与其生成一个「看起来能跑但
 * 实际取不到正文」的 js 规则，不如生成纯选择器规则；跑不通就诚实报「不可添加」，
 * 由用户在界面上手改。这与项目「不能读取的网站不能添加」的红线一致。
 */

const cheerio = require('cheerio');
const http = require('../net/http');
const { CookieJar } = require('../net/cookiejar');

/** 嗅探用的默认搜索词。取两字词：得奇类站点要求「关键字不少于 4 个字节」，
 *  单字（3 字节 UTF-8）会被判错误页。失败时还会依次试备选词。 */
const DEFAULT_KEYWORD = '都市';
const KEYWORD_FALLBACKS = ['剑', '我的'];

/** 单个请求超时 */
const REQ_TIMEOUT = 20000;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 绝对化 URL；失败返回空串 */
function abs(base, href) {
  if (!href) return '';
  const s = String(href).trim();
  if (!s) return '';
  if (/^(javascript:|mailto:|#)/i.test(s)) return '';
  try {
    return new URL(s, base).toString();
  } catch (_) {
    return '';
  }
}

/** 取站点根：协议 + 主机名 */
function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return '';
  }
}

/** 归一化站点地址：补协议、去末尾斜杠 */
function normalizeSiteUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return '';
  }
}

/** 带超时的请求 */
async function fetchText(url, opts = {}) {
  const res = await http.request(url, {
    method: opts.method || 'GET',
    body: opts.body || null,
    headers: opts.headers || {},
    jar: opts.jar || null,
    timeout: opts.timeout || REQ_TIMEOUT,
    charset: opts.charset,
  });
  return res;
}

/** 取标题 */
function pageTitle($) {
  return ($('title').first().text() || '').trim();
}

/** 页面是否像「错误的/空的」页面 */
function looksEmptyOrError($) {
  const t = pageTitle($);
  if (!t) return true;
  return /(404|not\s*found|错误|不存在|无法找到|服务器错误|禁止访问|forbidden|access\s*denied)/i.test(t);
}

/** 滤掉工具类/状态类后剩下的「像业务类名」的类列表 */
function bizClasses($, el) {
  return String($(el).attr('class') || '').trim().split(/\s+/).filter(Boolean)
    .filter((c) => !/^(clear|clearfix|hidden|visible|active|on|off|row|col|container|wrap|wrapper|fl|fr|left|right|text-center|pull-left|pull-right|mt\d*|mb\d*|pt\d*|pb\d*|p\d+|m\d+)$/i.test(c));
}

/** 元素自身是否有「文档里唯一」的稳定选择器（id 或 class 组合）；有则返回 */
function uniqueSelfSelector($, el) {
  const id = $(el).attr('id');
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `${el.name}#${id}`;
  const cls = bizClasses($, el);
  for (let k = Math.min(2, cls.length); k >= 1; k--) {
    const seg = `${el.name}.${cls.slice(0, k).join('.')}`;
    try { if ($(seg).length === 1) return seg; } catch (_) { /* 非法类名跳过 */ }
  }
  return null;
}

/**
 * 生成尽量稳定、短的选择器：
 * 1) 自身 id → `tag#id`；
 * 2) 自身 class 组合全文档唯一 → `tag.a.b`（页面改版时比绝对路径活命率高）；
 * 3) 最近「有稳定身份」的祖先 + 自身 class 组合；
 * 4) 都没有才退化为 tag 绝对路径（旧行为）。
 */
function selectorOf($, el) {
  const own = uniqueSelfSelector($, el);
  if (own) return own;
  let node = el.parent;
  let depth = 0;
  while (node && node.type === 'tag' && depth < 4) {
    const anc = uniqueSelfSelector($, node);
    if (anc) {
      const cls = bizClasses($, el);
      const self = cls.length ? `${el.name}.${cls.slice(0, 2).join('.')}` : el.name;
      /* ⚠ anc 不一定是 el 的亲父（中间可能隔着无身份祖先）。
         直接拼 `anc > self` 会生成匹配 0 个的假直接子选择器——实测 m.bqg52.com 的
         `div.biqunaicc > div.layout.layout-col1`（真父是 div.row.row-detail）让整本书
         目录解析不出章节地址。必须先在全文档验证命中数。 */
      const direct = `${anc} > ${self}`;
      try { if ($(direct).length === 1) return direct; } catch (_) { /* 非法选择器跳过 */ }
      const desc = `${anc} ${self}`;
      try { if ($(desc).length === 1) return desc; } catch (_) { /* 同上 */ }
    }
    node = node.parent;
    depth++;
  }
  // 兜底：绝对路径（旧实现）
  const parts = [];
  node = el;
  depth = 0;
  while (node && node.type === 'tag' && depth < 4) {
    let seg = node.name;
    const cls = bizClasses($, node);
    if (cls.length) seg += '.' + cls.slice(0, 2).join('.');
    parts.unshift(seg);
    node = node.parent;
    depth++;
  }
  return parts.join(' > ');
}

/** 数字密度：文本里数字占比 */
function digitRatio(s) {
  const t = String(s || '');
  if (!t.length) return 0;
  const d = (t.match(/\d/g) || []).length;
  return d / t.length;
}

/** 中文数字 → 整数（一~九千九百九十九；解析不了返回 null）。口语省略「二百五」=250 */
function cn2num(s) {
  const D = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const U = { 十: 10, 百: 100, 千: 1000 };
  let n = 0;
  let cur = 0;
  let lastU = 0;
  for (const ch of String(s)) {
    if (D[ch] != null) cur = D[ch];
    else if (U[ch] != null) { n += (cur || 1) * U[ch]; cur = 0; lastU = U[ch]; }
    else return null;
  }
  if (cur && lastU >= 100) cur *= lastU / 10; // 二百五→250、一千二→1200；二十五 不放大
  return n + cur;
}

/** 从「第N章/节/回…」解析阿拉伯数字序号；解析不了返回 null */
function chapterOrdinal(name) {
  const m = String(name || '').trim().match(/^第\s*([0-9]+|[零〇一二三四五六七八九十百千两]{1,8})\s*(?:[章节回卷话集篇])/);
  if (!m) return null;
  return /^[0-9]+$/.test(m[1]) ? parseInt(m[1], 10) : cn2num(m[1]);
}

/** 是否像章节名（第N章/节/回、序章、番外、正文） */
function looksLikeChapterName(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 60) return false;
  return /^(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回卷话集篇]|序[章言]?|楔子|引子|番外|后记|尾声|正文|终章|完本感言|请假)/.test(t);
}

/** 文本是否像「作者名」 */
function looksLikeAuthor(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 30) return false;
  if (/[:：]/.test(t)) return false;
  if (looksLikeChapterName(t)) return false;
  if (/[0-9]{3,}/.test(t)) return false;
  return /^[\u4e00-\u9fa5A-Za-z0-9_·．.\-]{1,20}$/.test(t);
}

/** 是否像「简介」文本 */
function looksLikeIntro(s) {
  const t = String(s || '').trim();
  return t.length >= 20 && !looksLikeChapterName(t);
}

/** 是否像「书籍详情页」（单结果搜索 302 直达的那种） */
function looksLikeDetailPage($) {
  if ($('meta[property="og:novel:book_name"]').length) return true;
  if ($('meta[property="og:novel:chapter_name"], meta[property="og:novel:latest_chapter_name"]').length) {
    const h1 = ($('h1').first().text() || '').trim();
    if (h1 && h1.length <= 40) return true;
  }
  return false;
}

/** 缩短显示用的 URL */
function shortUrl(u) {
  const s = String(u || '');
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

/**
 * 生成搜索模板 URL（必须带 {{key}}，不能把试探词写死进去）。
 * 输入是嗅探时真实发出的那次请求 at={method,url,body,kw}：
 * - GET  → /path?a=b&searchkey={{key}}（隐藏字段等静态参数原样保留）
 * - POST → /path,\n{"method":"POST","body":"action=login&searchkey={{key}}"}
 *          （Legado 选项串，本引擎 resolveUrlRule 按 `,\s*{` 切分，与线上 ryw笔趣阁78 同款写法。
 *           隐藏字段必须留在 body 里：得奇类站点缺 action/searchtype 会返回空壳页）
 */
function templateSearchUrl(at, param) {
  const kw = encodeURIComponent(at.kw || DEFAULT_KEYWORD);
  if (at.method === 'POST') {
    const body = String(at.body || '').replace(`${param}=${kw}`, `${param}={{key}}`);
    const safe = body.includes('{{key}}') ? body : `${body ? body + '&' : ''}${param}={{key}}`;
    return `${pathOf(at.url)},\n{\n"method": "POST",\n"body": "${safe}"\n}`;
  }
  let pathname = at.url;
  const keep = [];
  try {
    const u = new URL(at.url);
    pathname = u.pathname;
    for (const [k, v] of u.searchParams.entries()) {
      if (k === param) continue;
      if (v === '{{key}}') continue;
      keep.push(`${k}=${v}`);
    }
  } catch (_) { /* 兜底用原串 */ }
  const q = keep.join('&');
  return `${pathname}?${q ? q + '&' : ''}${param}={{key}}`;
}

/* ------------------------------------------------------------------ *
 * 1. 找搜索入口
 * ------------------------------------------------------------------ */

/**
 * 从「静态 HTML 里的 <form> 串」造搜索入口描述。
 * 站点常把搜索框写进 JS 模板字符串（document.writeln('<form …>')），
 * 静态 DOM 里根本没有 <form>——实测 redan.cc / bqg711.cc 的 /js/common.js
 * 就是这么注入搜索框的。这里把这类模板串临时插进一个 DOM 里按真表单解析。
 * @returns {Array} findSearchForm 同款描述数组（可能为空）
 */
function jsFormTemplates($) {
  const out = [];
  const seen = new Set();
  const push = (html) => {
    if (!html || !/<form/i.test(html) || seen.has(html)) return;
    seen.add(html);
    try {
      const fake = cheerio.load(`<body>${html}</body>`);
      const f = findSearchForm(fake, 'https://fake.local/');
      if (f) out.push(f);
    } catch (_) { /* 模板残缺就跳过 */ }
  };
  // 内联脚本里的字符串常量。按引号类型分三种正则——单引号串里可以合法出现双引号
  // （redan/common.js 就是 `'<form action="/user/search.html">'` 这种形态），
  // 用统一字符类会在第一个内层引号处截断，模板永远解析不出来。
  const texts = [];
  for (const s of $('script:not([src])').toArray()) texts.push($(s).html() || '');
  const inline = texts.join('\n');
  const fragOf = (m) => m[1];
  const strRes = [
    /'((?:[^'\\]|\\.){0,1500}?)'/g,
    /"((?:[^"\\]|\\.){0,1500}?)"/g,
    /`((?:[^`\\]|\\.){0,1500}?)`/g,
  ];
  for (const re of strRes) {
    let m;
    while ((m = re.exec(inline))) {
      const frag = fragOf(m);
      if (!/<form/i.test(frag)) continue;
      push(frag.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(['"`\\])/g, '$1'));
    }
  }
  return out;
}

/**
 * 从首页 HTML 里找搜索表单。
 * @returns {{action:string, method:string, param:string, kind:'form'|'link'}|null}
 */
function findSearchForm($, baseUrl, opts = {}) {
  const forms = $('form').toArray();
  for (const f of forms) {
    const $f = $(f);
    // 输入框：text / search 类型，或没有 type 的 input
    const inputs = $f.find('input, select').toArray().filter((el) => {
      const $el = $(el);
      const type = String($el.attr('type') || 'text').toLowerCase();
      const name = String($el.attr('name') || '').trim();
      if (!name) return false;
      if (/^(hidden|submit|button|image|reset|checkbox|radio|file)$/.test(type)) return false;
      return true;
    });
    if (!inputs.length) continue;
    const $in = $(inputs[0]);
    const param = String($in.attr('name') || '').trim();
    const action = abs(baseUrl, $f.attr('action') || '') || baseUrl;
    const method = String($f.attr('method') || 'get').toLowerCase();
    // 隐藏字段必须一起带上：得奇类站点缺 action=login&searchtype=all 会返回空壳页
    const hidden = {};
    for (const el of $f.find('input[type=hidden]').toArray()) {
      const $el = $(el);
      const name = String($el.attr('name') || '').trim();
      if (name && !(name in hidden)) hidden[name] = String($el.attr('value') || '');
    }
    // 过滤明显不是搜索的表单（登录/注册）
    const allNames = $f.find('input').toArray().map((el) => String($(el).attr('name') || '').toLowerCase()).join(' ');
    if (/password|passwd|captcha|verify|login|register|username/.test(allNames) && !/search|key|kw|q\b|word/.test(allNames)) continue;
    if (param) {
      return { action, method, param, kind: 'form', actionRaw: $f.attr('action') || '', hidden };
    }
  }
  return null;
}

/** 首页里找「书库/分类」入口，作为搜索不可用时的兜底 */
function findCatalogLinks($, baseUrl) {
  const out = [];
  const seen = new Set();
  const RE = /(全部小说|书库|小说库|分类|排行|排行榜|完结|全本|玄幻|都市|仙侠|修真|历史|科幻|网游|言情)/;
  for (const a of $('a').toArray()) {
    const $a = $(a);
    const text = ($a.text() || '').trim();
    const href = abs(baseUrl, $a.attr('href'));
    if (!href || !RE.test(text)) continue;
    if (!/^https?:/i.test(href)) continue;
    if (originOf(href) !== originOf(baseUrl)) continue;
    const key = text + '\u0000' + href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: text.slice(0, 10), url: href });
    if (out.length >= 12) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. 书籍列表嗅探
 * ------------------------------------------------------------------ */

/**
 * 在一组候选容器里挑「最像书籍列表」的那个。
 * 判据：容器内直接子元素重复出现（>=3），每个子元素里有指向本站的链接 + 非空文本。
 */
function sniffBookList($, baseUrl) {
  const origin = originOf(baseUrl);
  let best = null;

  // 候选：所有有 2+ 个同标签同 class 兄弟的元素
  // （下限取 2：单关键词搜索常常只命中 2 条，取 3 会把真实搜索页判成「没有列表」）
  for (const el of $('div, ul, ol, dl, table, tbody').toArray()) {
    const $el = $(el);
    const children = $el.children().toArray();
    if (children.length < 2) continue;
    // 按 tag+class 分组
    const groups = new Map();
    for (const c of children) {
      const $c = $(c);
      const clsStr = String($c.attr('class') || '').trim().split(/\s+/).filter(Boolean).sort().join('.');
      // 无 class 时不能拼出 "li." 这种尾点 key——它会流进 itemSel 变成非法 CSS 选择器
      const key = clsStr ? `${c.name}.${clsStr}` : c.name;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const [key, items] of groups) {
      if (items.length < 2) continue;
      // 每个 item 里必须有链接
      let withLink = 0;
      let totalText = 0;
      let chapterLike = 0;
      let numLike = 0;
      const n = Math.min(items.length, 12);
      for (const it of items.slice(0, 12)) {
        const $it = $(it);
        const links = $it.find('a[href]').toArray();
        const hit = links.find((a) => {
          const h = abs(baseUrl, $(a).attr('href'));
          return h && originOf(h) === origin;
        });
        if (hit) withLink++;
        const txt = ($it.text() || '').replace(/\s+/g, ' ').trim();
        totalText += txt.length;
        if (looksLikeChapterName(txt)) chapterLike++;
        if (digitRatio(txt) > 0.5) numLike++;
      }
      // 判定只看抽样内的命中率：拿 n（≤12）和「全组 60%」比是错的——
      // 100 条的真实搜索页永远过不了这道闸。
      if (withLink < Math.max(1, Math.ceil(n * 0.6))) continue;
      // 目录项（章节列表）通常文本很短且高度雷同 → 排除
      const avgText = totalText / n;
      if (avgText < 8) continue;
      if (chapterLike / n > 0.5) continue;
      if (numLike / n > 0.5) continue;

      // itemSel 用「相对容器的重复单元选择器」（tag + 稳定 class），
      // 这样换页/换栏目也能命中；绝不写整条绝对路径。
      const itemSel = itemSelectorSeg(items[0], key);
      const sel = selectorOf($, el);

      // 打分。
      // 关键：真正「书籍列表页」的每个条目都指向**不同的书籍详情页**；
      // 侧栏推荐/热榜往往只有几条、且指向同样几个固定的书；
      // 导航块则指向栏目页。所以「不同书籍链接数」是最强的信号。
      const bookUrls = new Set();
      for (const it of items.slice(0, 20)) {
        const hit = $(it).find('a[href]').toArray()
          .map((a) => abs(baseUrl, $(a).attr('href')))
          .find((h) => h && originOf(h) === origin);
        if (hit) bookUrls.add(hit);
      }
      const distinct = bookUrls.size;

      // 结构信号 1：条目**直接**挂在本站链接上（a 是 item 的亲儿子）。
      // 「内容容器」的典型形态就是 <div class=bookbox><a href=详情页>…；
      // 侧栏/导航块里的链接多埋在子层里、或指向栏目页。
      let direct = 0;
      for (const it of items.slice(0, 12)) {
        const hit = $(it).children('a[href]').toArray()
          .map((a) => abs(baseUrl, $(a).attr('href')))
          .find((h) => h && originOf(h) === origin);
        if (hit) direct++;
      }
      // 结构信号 2：链接路径模板的多样性。
      // 主列表条目 → 每本书 URL 各不相同且带书名/编号段；
      // 导航/榜单块的链接常被归一成同一模板（/top/、/sort/x/ 之类）。
      const shapes = new Set();
      for (const u of bookUrls) {
        try {
          const p = new URL(u).pathname.split('/').filter(Boolean);
          shapes.add(p.length + ':' + (p[0] || ''));
        } catch (_) { /* 忽略 */ }
      }
      const shapeBonus = Math.max(0.5, Math.min(2, 0.5 + shapes.size * 0.3));

      // 侧栏/推荐块惩罚：只作弱信号（词表不可靠——得奇把主列表容器直接命名成 id="fengtui"）。
      // 命中词表**且结构信号也很弱**（直接链接少、去重链接少）才惩罚。
      const clsAll = `${$(el).attr('class') || ''} ${$(el).attr('id') || ''}`.toLowerCase();
      const sideWord = /(side|hot|rank|top|rec|recommend|tui|newbook|new-book|sidebar|crumb|nav|menu|footer|header)/.test(clsAll);
      const sidePenalty = (sideWord && direct < n * 0.3 && distinct < items.length * 0.5) ? 0.4 : 1;
      // 结构长度惩罚（选择器越长越脆）
      const lenPenalty = 1 / (1 + sel.split('>').length * 0.12);

      const score = distinct * Math.min(avgText, 120) * (1 + direct / Math.max(1, n)) * shapeBonus * sidePenalty * lenPenalty;
      if (!best || score > best.score) {
        best = {
          score,
          containerSel: sel,
          itemSel,
          items,
          itemCount: items.length,
          distinct,
          sample: items[0],

        };
      }
    }
  }
  return best;
}

/**
 * 生成「重复单元」的相对选择器：tag + 稳定 class（排除排版工具类）。
 * 不用绝对路径 —— 绝对路径在换页后极易失配。
 */
function itemSelectorSeg(el, fallbackKey) {
  const cls = String((el && el.attribs && el.attribs.class) || '').trim().split(/\s+/).filter(Boolean);
  const stable = cls.filter((c) => !/^(clear|clearfix|hidden|visible|active|on|off|row|col|container|wrap|wrapper|fl|fr|left|right|text-center|pull-left|pull-right|mt\d*|mb\d*|pt\d*|pb\d*|p\d+|m\d+|first|last|odd|even)$/i.test(c));
  const tag = (el && el.name) || 'div';
  if (stable.length) return `${tag}.${stable.slice(0, 2).join('.')}`;
  // 兜底 key 去尾点（"li." → "li"），否则产出非法 CSS
  if (fallbackKey) return String(fallbackKey).replace(/\.$/, '');
  return tag;
}

/** 排版/状态类：不当作身份类用 */
const TOOL_CLASS_RE = /^(clear|clearfix|hidden|visible|active|on|off|row|col|container|wrap|wrapper|fl|fr|left|right|text-center|pull-left|pull-right|mt\d*|mb\d*|pt\d*|pb\d*|p\d+|m\d+|first|last|odd|even)$/i;
/** 可安全进 CSS 选择器的类名 */
const SAFE_CLASS_RE = /^[A-Za-z][\w-]*$/;

/**
 * 生成「相对条目」的后代路径：从 item 的孩子开始、到 el 结束的 tag.class 链。
 * 引擎执行 ruleSearch 的字段规则是按条目 find 的，所以这里绝不能带条目外的锚点。
 */
function relPathWithin(itemEl, el) {
  const segs = [];
  let node = el;
  let hops = 0;
  while (node && node !== itemEl && hops < 8) {
    let seg = node.name || '';
    if (!seg) return null;
    const cls = String((node.attribs && node.attribs.class) || '').trim().split(/\s+/).filter(Boolean)
      .filter((c) => SAFE_CLASS_RE.test(c) && !TOOL_CLASS_RE.test(c));
    if (cls.length) seg += '.' + cls.slice(0, 2).join('.');
    segs.unshift(seg);
    node = node.parent;
    hops++;
  }
  if (node !== itemEl) return null; // 不在条目内
  return segs.join(' > ');
}

/** 从列表项里提取书名/作者/简介/封面/链接 的候选选择器（全部相对条目） */
function deriveListItemRules($, baseUrl, container) {
  const itemEl = container.sample;
  const $container = $(itemEl);
  // bookList 必须指向「每一个条目」而不是外层容器：引擎对每个 bookList 命中元素
  // 再执行相对字段规则。写成容器会把整页书名并成一条。（与线上书源 .bookbox 惯例一致）
  const bookList = `${container.containerSel} ${container.itemSel}`;
  const rule = { bookList, name: '', author: '', intro: '', coverUrl: '', bookUrl: '', kind: '', lastChapter: '' };
  /** 相对条目找得到东西才算数 */
  const okRel = (rel) => {
    if (!rel) return false;
    try { return $container.find(rel).length > 0; } catch (_) { return false; }
  };
  /**
   * 相对条目选择器 + 多命中消歧：命中多于 1 个时给末段加 .0 索引后缀
   * （Legado「取首个匹配」惯例，与线上 ryw笔趣阁78 的 div.author.0 同款写法）。
   */
  const pickRel = (el) => {
    const rel = relPathWithin(itemEl, el);
    if (!rel) return null;
    let m = 0;
    try { m = $container.find(rel).length; } catch (_) { return null; }
    if (m === 0) return null;
    if (m === 1) return rel;
    const arr = rel.split(' > ');
    arr[arr.length - 1] = `${arr[arr.length - 1]}.0`;
    return arr.join(' > ');
  };

  const origin = originOf(baseUrl);
  // bookUrl/name：条目内第一个「文本像书名」的本站链接
  const links = $container.find('a[href]').toArray().map((a) => ({ el: a, href: abs(baseUrl, $(a).attr('href')), text: ($(a).text() || '').trim() }))
    .filter((x) => x.href && originOf(x.href) === origin);
  if (links.length) {
    const bookish = links.filter((x) => {
      const t = x.text;
      if (!t || t.length < 2 || t.length > 40) return false;
      if (looksLikeChapterName(t)) return false;
      if (/^(更多|全部|首页|上一页|下一页|尾页|末页|排行|书架|登录|注册|搜索|目录|详情|阅读)$/.test(t)) return false;
      return true;
    });
    const pick = bookish[0] || links[0];
    const rel = pickRel(pick.el);
    if (rel && okRel(rel)) {
      rule.bookUrl = `${rel}@href`;
      rule.name = `${rel}@text`;
    }
  }

  // lastChapter：条目内文本像章节名的链接
  if (!rule.lastChapter) {
    const chapLink = links.find((x) => looksLikeChapterName(x.text));
    if (chapLink) {
      const rel = pickRel(chapLink.el);
      if (rel && okRel(rel)) rule.lastChapter = `${rel}@text`;
    }
  }

  // author/kind/intro/cover：叶子元素逐个判
  for (const el of $container.find('*').toArray()) {
    const $el = $(el);
    if ($el.children().length > 0) continue; // 只要叶子
    const t = ($el.text() || '').trim();
    if (!t || t.length > 60) continue;
    const cls = String($el.attr('class') || '').toLowerCase();
    const rel = pickRel(el);
    if (!rel) continue;
    if (!rule.author && (/作者/.test(t) || /author|zuozhe|writer/.test(cls))) {
      rule.author = /作者[:：]/.test(t) ? `${rel}@text##作者[:：]` : `${rel}@text`;
    }
    if (!rule.intro && /简介/.test(t)) {
      // 叶子只含「简介：」标签而正文是兄弟文本时，往上退一层拿整块文本
      let useRel = rel;
      if (/^简介[:：]?$/.test(t) && el.parent && el.parent !== itemEl) {
        const prel = pickRel(el.parent);
        if (prel) useRel = prel;
      }
      rule.intro = `${useRel}@text##简介[:：]`;
    }
    if (!rule.kind && (/分类|类型/.test(t) || /cat|kind|sort/.test(cls)) && !/更新|阅读/.test(t)) {
      rule.kind = `${rel}@text`;
    }
    if (!rule.coverUrl) {
      const img = $el.find('img').first();
      if (img.length) {
        const isrc = img.attr('data-src') || img.attr('data-original') || img.attr('src');
        const irel = pickRel(img.get(0));
        if (isrc && !/^data:/i.test(isrc) && irel) rule.coverUrl = `${irel}@src`;
      }
    }
  }
  // 图片兜底（img 不是叶子循环时）
  if (!rule.coverUrl) {
    const img = $container.find('img').first();
    if (img.length) {
      const isrc = img.attr('data-src') || img.attr('data-original') || img.attr('src');
      const irel = pickRel(img.get(0));
      if (isrc && !/^data:/i.test(isrc) && irel) rule.coverUrl = `${irel}@src`;
    }
  }
  // 简介兜底：条目内最长的一段像简介文本（可含子节点，但只到条目级）
  if (!rule.intro) {
    let longest = null;
    for (const el of $container.find('p, div, span').toArray()) {
      const $el = $(el);
      if ($el.children().length > 0) continue;
      const t = ($el.text() || '').trim();
      if (!looksLikeIntro(t)) continue;
      if (!longest || t.length > longest.t.length) longest = { el, t };
    }
    if (longest) {
      const rel = pickRel(longest.el);
      if (rel) rule.intro = `${rel}@text`;
    }
  }
  return rule;
}

/* ------------------------------------------------------------------ *
 * 3. 详情页嗅探
 * ------------------------------------------------------------------ */

/** 详情页里提取书名/作者/简介/封面/分类 */
function sniffBookInfo($, baseUrl) {
  const out = { name: '', author: '', intro: '', coverUrl: '', kind: '', lastChapter: '' };

  // OpenGraph 优先 —— 最稳
  const og = (p) => {
    const v = $(`meta[property="${p}"]`).attr('content') || $(`meta[name="${p}"]`).attr('content');
    return v ? String(v).trim() : '';
  };
  const ogName = og('og:novel:book_name') || og('og:title');
  if (ogName) out.name = `meta[property="og:novel:book_name"]@content||meta[property="og:title"]@content`;
  const ogAuthor = og('og:novel:author');
  if (ogAuthor) out.author = `meta[property="og:novel:author"]@content`;
  const ogIntro = og('og:description');
  if (ogIntro) out.intro = `meta[property="og:description"]@content`;
  const ogCover = og('og:image');
  if (ogCover) out.coverUrl = `meta[property="og:image"]@content`;
  const ogKind = og('og:novel:category');
  if (ogKind) out.kind = `meta[property="og:novel:category"]@content`;
  const ogLast = og('og:novel:latest_chapter_name') || og('og:novel:lastest_chapter_name');
  if (ogLast) out.lastChapter = `meta[property="og:novel:latest_chapter_name"]@content`;

  // h1（书名）
  if (!out.name) {
    const h1 = $('h1').first();
    if (h1.length) {
      const t = (h1.text() || '').trim();
      if (t && t.length <= 60) {
        // h1 里可能含 <i>字数</i><a>书名</a>，优先取 a
        const a = h1.find('a').first();
        if (a.length && (a.text() || '').trim()) out.name = `${selectorOf($, h1.get(0))} a@text||h1@text`;
        else out.name = 'h1@text';
      }
    }
  }

  // 作者
  if (!out.author) {
    for (const el of $('a[href*="author"], a[href*="zuozhe"], [class*="author"], [class*="zuozhe"]').toArray()) {
      const t = ($(el).text() || '').trim();
      if (!looksLikeAuthor(t)) continue;
      const sel = selectorOf($, el);
      out.author = /作者[:：]/.test(t) ? `${sel}@text##作者[:：]` : `${sel}@text`;
      break;
    }
  }

  // 简介
  if (!out.intro) {
    let best = null;
    for (const el of $('[class*="intro"], [class*="des"], [class*="jianjie"], #intro, .intro, p').toArray()) {
      const $el = $(el);
      const t = ($el.text() || '').replace(/\s+/g, ' ').trim();
      if (!looksLikeIntro(t)) continue;
      if (!best || t.length > best.t.length) best = { el, t };
    }
    if (best) out.intro = `${selectorOf($, best.el)}@text`;
  }

  // 封面
  if (!out.coverUrl) {
    for (const el of $('[class*="cover"] img, [class*="bookimg"] img, [class*="pic"] img, img').toArray()) {
      const $el = $(el);
      const src = $el.attr('data-src') || $el.attr('data-original') || $el.attr('src') || '';
      if (!src || /^data:/i.test(src)) continue;
      if (!/\.(jpe?g|png|webp|gif)/i.test(src) && !/image|cover|pic/i.test(src)) continue;
      out.coverUrl = `${selectorOf($, el)}@src`;
      break;
    }
  }

  // 分类
  if (!out.kind) {
    for (const el of $('[class*="cat"] span, [class*="kind"] span, [class*="tag"] span, [class*="info"] span').toArray()) {
      const t = ($(el).text() || '').trim();
      if (!t || t.length > 12) continue;
      if (/^(连载|完结|全本|已完结|连载中|签约|VIP|免费)$/.test(t)) continue;
      out.kind = `${selectorOf($, el)}@text`;
      break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. 目录嗅探
 * ------------------------------------------------------------------ */

/**
 * 找目录容器：一组「大量、结构相同、指向同站点、路径在同一前缀下」的链接。
 * 判据要点：章名文本很像章节名，或链接数极多（>30）。
 */
function sniffToc($, baseUrl, bookUrl) {
  const origin = originOf(baseUrl);
  let best = null;

  for (const el of $('div, ul, ol, dl, table, tbody, section').toArray()) {
    const $el = $(el);
    const links = $el.find('a[href]').toArray();
    if (links.length < 8) continue;

    let sameOrigin = 0;
    let chapterName = 0;
    const hrefs = [];
    const pairs = []; // {a, h}：hrefs 是过滤后的数组，后面按主导目录复算时必须对得上原元素
    for (const a of links) {
      const h = abs(baseUrl, $(a).attr('href'));
      if (!h || originOf(h) !== origin) continue;
      sameOrigin++;
      hrefs.push(h);
      pairs.push({ a, h });
      if (looksLikeChapterName(($(a).text() || '').trim())) chapterName++;
    }
    if (sameOrigin < 8) continue;
    let ratio = chapterName / Math.max(1, hrefs.length);
    // 章名比例高 → 目录；链接数极多（>40）也基本可以确定是目录
    if (ratio < 0.35 && links.length < 40) continue;
    // 链接应集中在一本书的目录下。
    // 旧实现用「全部链接的字符串公共前缀」：redan.cc 详情页 DL.book 有 78/1177
    // 个章链（ratio 0.97），但少量导航/站内其它链接把公共前缀砍到站点根
    // `https://www.redan.cc/`（长度不够 origin+3）→ 整本书目录被判非目录 →
    // 「详情页里找不到章节列表」。改成「多数目录分组」：取出现最多的父目录，
    // 用它算前缀和章名命中率；没有主导目录时退回公共前缀算法。
    const dirCount = new Map();
    for (const h of hrefs) {
      const i = h.lastIndexOf('/');
      const d = i > 0 ? h.slice(0, i + 1) : h;
      dirCount.set(d, (dirCount.get(d) || 0) + 1);
    }
    let prefix = '';
    let dirN = 0;
    for (const [d, n] of dirCount) if (n > dirN) { prefix = d; dirN = n; }
    if (dirN < 8) prefix = commonPrefix(hrefs);
    if (prefix.length < origin.length + 3) continue;
    // 章名命中率按主导目录内计（防止目录块混入全站导航稀释判据）
    let chapterCountDom = Math.round(hrefs.length * ratio);
    if (dirN >= 8) {
      let inDir = 0;
      let inDirChapter = 0;
      for (const p of pairs) {
        if (!p.h.startsWith(prefix)) continue;
        inDir++;
        if (looksLikeChapterName(($(p.a).text() || '').trim())) inDirChapter++;
      }
      if (inDir >= 8) {
        const r2 = inDirChapter / inDir;
        if (r2 < 0.35 && inDir < 40) continue;
        ratio = r2;
        chapterCountDom = inDirChapter;
      }
    }

    // 找「容器内重复出现的直接子元素」作为条目的选择器
    const itemInfo = pickTocItem($, el, baseUrl, origin);
    if (!itemInfo) continue;

    const score = links.length * (0.4 + ratio) - el.name.length * 0.01;
    if (!best || score > best.score) {
      best = {
        score,
        containerSel: selectorOf($, el),
        itemSel: itemInfo.itemSel,
        count: links.length,
        inChapter: chapterCountDom,
        chapterRatio: ratio,
        prefix,
      };
    }
  }
  return best;
}

/** 在目录容器里挑「条目」选择器（返回基于容器后缀的选择器） */
function pickTocItem($, container, baseUrl, origin) {
  const $c = $(container);
  // 常见结构：<div id="list"><ul><li><a>…</a></li></ul></div>，或 <div id="list"><dd><a/></dd></div>
  const cands = [];
  // 1) 直接子元素里的重复项
  const kids = $c.children().toArray();
  for (const k of kids) {
    const $k = $(k);
    const inner = $k.children().toArray();
    if (inner.length >= 5) {
      const key = `${inner[0].name}`;
      const same = inner.filter((x) => x.name === key).length;
      if (same >= 5) cands.push({ prefix: '', itemSel: `${key}`, count: same, leaf: true });
    } else if ($k.find('a[href]').length >= 5) {
      cands.push({ prefix: '', itemSel: selectorSeg($, k), count: $k.find('a[href]').length, leaf: false });
    }
  }
  // 2) 锚点「直接父」的签名众数：条目通常是 <li><a>/<dd><a>。
  //    上面 1b 可能把容器层当条目（m.bqg52.com：div.layout.layout-col1 里 119 个 a
  //    被当成 1 个「条目」，引擎 a@text 把整块章节名拼成一条）。
  //    这里按「不同父元素个数」计票：父元素本身重复 >=5 个才算条目候选，且优先采纳。
  //    另算一份「上溯到容器直接子元素」的签名（ul>li>div.f>a 的条目语义单元是 li）：
  //    上溯结果 >=5 个才算并优先用；单壳链（div.row 只 1 个）退回直接父签名。
  const sig0 = new Map();
  const sigC = new Map();
  const bump = (map, p, a) => {
    const cls = String($(p).attr('class') || '').trim().split(/\s+/).filter(Boolean).sort().join('.');
    const key = cls ? `${p.name}.${cls}` : p.name;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(p);
  };
  for (const a of $c.find('a[href]').toArray()) {
    const h = abs(baseUrl, $(a).attr('href'));
    if (!h || originOf(h) !== origin) continue;
    const p = $(a).parent()[0];
    if (!p || p === container || p.name === 'body' || p.name === 'html' || p.name === 'a') continue;
    bump(sig0, p);
    let q = p;
    while (q && q !== container && $(q).parent().length && $(q).parent()[0] !== container) q = $(q).parent()[0];
    if (q && q !== container && q !== p && $(q).parent()[0] === container) bump(sigC, q);
  }
  const pickSig = (map) => {
    let bk = null;
    let bs = 0;
    for (const [key, set] of map) if (set.size > bs) { bs = set.size; bk = key; }
    return bs >= 5 ? { prefix: '', itemSel: bk, count: bs, leaf: true } : null;
  };
  const climbed = pickSig(sigC);
  const direct = pickSig(sig0);
  if (climbed) cands.push(climbed);
  else if (direct) cands.push(direct);
  // 3) 容器自身是一堆同标签兄弟
  if (!cands.length) {
    const tagCount = {};
    for (const k of kids) tagCount[k.name] = (tagCount[k.name] || 0) + 1;
    for (const [tag, n] of Object.entries(tagCount)) {
      if (n >= 5 && $(`${tag} a[href]`, $c).length >= 5) cands.push({ prefix: '', itemSel: tag, count: n, leaf: true });
    }
  }
  if (!cands.length) return null;
  // leaf（真条目层）优先，其次数量
  cands.sort((a, b) => (b.leaf ? 1 : 0) - (a.leaf ? 1 : 0) || b.count - a.count);
  const pick = cands[0];
  const containerSel = selectorOf($, container);
  const full = pick.prefix ? `${containerSel} ${pick.itemSel}` : `${containerSel} ${pick.itemSel}`;
  return { itemSel: full, count: pick.count };
}

/** 单个元素的选择器片段 */
function selectorSeg($, el) {
  const tag = el.name;
  const id = $(el).attr('id');
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `${tag}#${id}`;
  const cls = String($(el).attr('class') || '').trim().split(/\s+/).filter(Boolean);
  if (cls.length) return `${tag}.${cls.slice(0, 2).join('.')}`;
  return tag;
}

/** 一组 URL 的公共前缀（按路径段） */
function commonPrefix(urls) {
  if (!urls.length) return '';
  let pre = urls[0];
  for (const u of urls.slice(1)) {
    let i = 0;
    while (i < pre.length && i < u.length && pre[i] === u[i]) i++;
    pre = pre.slice(0, i);
    if (!pre) break;
  }
  return pre;
}

/* ------------------------------------------------------------------ *
 * 5. 正文嗅探
 * ------------------------------------------------------------------ */

/**
 * 找正文容器：文本密度最高、段落最多的块。
 * 打分：净文本长度 × log(段落数) − 链接文本占比惩罚。
 */
function sniffContent($, baseUrl) {
  let best = null;
  const candidates = $('div, article, section, td').toArray();
  for (const el of candidates) {
    const $el = $(el);
    // 跳过整页容器
    const text = ($el.text() || '').replace(/\s+/g, ' ').trim();
    if (text.length < 150) continue;
    // 容器里如果再嵌一个同样大的「块容器」，说明这个太外层。
    // 只认块级容器子元素——正文整体塞进单个 <p>/<font> 的站点很常见（实测 bqg52 家族），
    // 那种情况 <p> 占父文本 >80% 是正常的，不能把正文块本身拒掉。
    const childBig = $el.children().toArray().some((c) =>
      (c.name === 'div' || c.name === 'article' || c.name === 'section' || c.name === 'td')
      && ($c => ($c.text() || '').replace(/\s+/g, ' ').trim().length > text.length * 0.8)($(c)));
    if (childBig) continue;

    const linkText = $el.find('a').toArray().reduce((n, a) => n + ($(a).text() || '').length, 0);
    const linkRatio = linkText / Math.max(1, text.length);
    if (linkRatio > 0.25) continue;

    // 正文必须「像文章」：句子密度。导航/脚本壳的 div 里全是短语，
    // 没有连续标点分句 —— 用它把 AJAX 壳页（正文不在 HTML 里）挡掉。
    const sentences = (text.match(/[。！？；]/g) || []).length;
    if (sentences < 8) continue;

    // 段落数：<br> 分隔或 <p> 数
    const pCount = $el.find('p').length;
    const brCount = $el.find('br').length;
    const paragraphs = Math.max(pCount, Math.ceil(brCount / 2), 1);

    // 正文里通常不含大量表单/导航
    const navLike = $el.find('form, nav, select, button').length;
    if (navLike > 3) continue;

    const score = text.length * Math.log2(1 + paragraphs) * (1 - linkRatio) * Math.min(1, sentences / 20) - navLike * 200;
    if (!best || score > best.score) {
      best = { score, sel: selectorOf($, el), length: text.length, paragraphs, pCount, brCount, sentences };
    }
  }
  if (!best) return null;

  // 选文本提取方式：<p> 多就用 tag.p@html 逐段，否则用 @html（保留 <br> 分段）
  let contentRule;
  if (best.pCount >= 3) contentRule = `${best.sel}@html`;
  else if (best.brCount >= 5) contentRule = `${best.sel}@html`;
  else contentRule = `${best.sel}@html`;

  // 分页（下一页）
  let nextRule = '';
  const nextA = $('a').toArray().find((a) => /^\s*(下一页|下页|下一頁|next)\s*$/i.test(($(a).text() || '').trim()));
  if (nextA) {
    const h = abs(baseUrl, $(nextA).attr('href'));
    // 只在链接确实指向本站、且不是单纯 JS 时采纳
    if (h && originOf(h) === originOf(baseUrl) && !/^javascript:/i.test(String($(nextA).attr('href') || ''))) {
      nextRule = 'a:contains(下一页)@href';
    }
  }
  return { content: contentRule, nextContentUrl: nextRule, sel: best.sel, length: best.length };
}

/* ------------------------------------------------------------------ *
 * 6. 主流程
 * ------------------------------------------------------------------ */

/**
 * 嗅探一个站点并生成书源。
 *
 * @param {string} siteUrl 小说网站地址（可省协议）
 * @param {object} [opts] { keyword, logger, timeout }
 * @returns {Promise<{ok:boolean, source?:object, steps:Array, error?:string, notes:string[]}>}
 */
async function generateSource(siteUrl, opts = {}) {
  const log = opts.logger || (() => {});
  const notes = [];
  const steps = [];
  const keyword = String(opts.keyword || DEFAULT_KEYWORD).trim() || DEFAULT_KEYWORD;
  /* 测试可注入页面抓取（离线单测用假站点），生产走真实 http */
  const fetchPage = opts.fetchText || fetchText;

  const step = (name, ok, detail) => {
    steps.push({ name, ok, detail: detail || '' });
    log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  const base = normalizeSiteUrl(siteUrl);
  if (!base) {
    return { ok: false, steps, notes, error: `不是合法的网址：${siteUrl}` };
  }
  const origin = originOf(base);
  const jar = new CookieJar();

  /* --- 1. 首页 --- */
  log(`嗅探 ${base}`);
  let home;
  try {
    home = await fetchPage(base + '/', { jar });
  } catch (e) {
    step('首页可达', false, e.message);
    return { ok: false, steps, notes, error: `站点无法访问：${e.message}` };
  }
  if (!home || home.status >= 400 || !home.text) {
    step('首页可达', false, `HTTP ${home && home.status}`);
    return { ok: false, steps, notes, error: `站点无法访问（HTTP ${home && home.status}）` };
  }
  const $home = cheerio.load(home.text);
  const homeTitle = pageTitle($home);
  step('首页可达', true, `HTTP ${home.status}，${home.text.length} 字节，标题「${homeTitle.slice(0, 30)}」`);

  /* --- 2. 搜索表单 --- */
  // 静态表单优先；没有就从内联脚本的 document.write 模板串里找（redan 壳族）。
  let form = findSearchForm($home, base);
  let formFromJs = false;
  if (!form) {
    const jsForms = jsFormTemplates($home);
    if (jsForms.length) { form = jsForms[0]; formFromJs = true; }
  }
  let searchUrl = '';
  let searchMethod = 'GET';
  let searchBodyParam = '';
  let listHtml = '';
  let listUrl = '';
  /** 单结果搜索 302 直达的详情页（得奇型站点：搜一本只命中一本的书 → 直接跳书页） */
  let directDetail = null;
  /** true=列表形态未知，ruleSearch 强制用 OpenGraph 兜底 */
  let ogForced = false;

  if (form) {
    step('发现搜索表单', true, `${formFromJs ? 'JS 注入模板 ' : ''}${form.method.toUpperCase()} ${form.action}${form.method === 'post' ? ' 参数 ' + form.param : '?' + form.param + '=…'}`);
    const hiddenPairs = Object.entries(form.hidden || {});
    /** 按表单形态生成一次请求描述（隐藏字段必须带上，空值也带——服务器可能用它判表单合法性） */
    const mkAttempt = (kw, method) => {
      if (method === 'POST') {
        const body = hiddenPairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).concat(`${form.param}=${encodeURIComponent(kw)}`).join('&');
        return { method: 'POST', url: form.action, body, kw };
      }
      let url = appendQuery(form.action, form.param, kw);
      for (const [k, v] of hiddenPairs) url = appendQuery(url, k, v);
      return { method: 'GET', url, body: null, kw };
    };
    // 主词 × 两种方法 都不中，再依次换备选词（有的站要求关键词最小长度）
    const kwList = [keyword, ...KEYWORD_FALLBACKS.filter((k) => k !== keyword)];
    const attempts = [];
    for (const kw of kwList) {
      if (form.method === 'post') {
        attempts.push(mkAttempt(kw, 'POST'));
        attempts.push(mkAttempt(kw, 'GET'));
      } else {
        attempts.push(mkAttempt(kw, 'GET'));
        attempts.push(mkAttempt(kw, 'POST'));
      }
    }
    let hitKeyword = keyword;
    for (const at of attempts) {
      try {
        const res = await fetchPage(at.url, {
          method: at.method,
          body: at.body,
          jar,
          headers: at.method === 'POST'
            ? { 'Content-Type': 'application/x-www-form-urlencoded', Referer: base + '/' }
            : { Referer: base + '/' },
        });
        if (res.status >= 400) continue;
        const $t = cheerio.load(res.text);
        const cont = sniffBookList($t, res.url || at.url);
        const urlOfRes = res.url || at.url;
        if (cont) {
          searchUrl = templateSearchUrl(at, form.param);
          searchMethod = at.method;
          hitKeyword = at.kw;
          listHtml = res.text;
          listUrl = urlOfRes;
          step('搜索可用', true, `${at.method} 命中 ${cont.itemCount} 条`);
          break;
        }
        // 没有列表但落点是「书页详情页」→ 站点是「单结果直跳」型（得奇/笔趣阁家族）。
        // 引擎的搜索兜底路径（_readBookInfo + 302 落点回填）能处理这种情况，
        // 所以这也算搜索可用；多结果时同样地址会返回真列表。
        if (looksLikeDetailPage($t)) {
          searchUrl = templateSearchUrl(at, form.param);
          searchMethod = at.method;
          hitKeyword = at.kw;
          directDetail = { html: res.text, url: urlOfRes };
          step('搜索可用', true, `${at.method} 单结果直达书页（${shortUrl(urlOfRes)}），多结果时返回列表`);
          break;
        }
      } catch (e) { /* 换下一种 */ }
    }
    if (searchUrl && hitKeyword !== keyword) {
      notes.push(`搜索探测使用备选关键词「${hitKeyword}」（默认词未命中，站点可能对关键词长度有限制）`);
    }
    if (!searchUrl) {
      step('搜索可用', false, `搜索探测均取不到书籍列表`);
      notes.push('搜索接口探测失败，将尝试用分类页作为发现入口');
    }
  } else {
    step('发现搜索表单', false, '首页没有可识别的搜索表单');
    notes.push('未找到搜索表单，将使用分类页作为发现入口');
  }

  /* --- 3. 分类页兜底（或单结果直达时补充列表规则） --- */
  let explore = [];
  const catalogLinks = findCatalogLinks($home, base);
  // directDetail 时列表规则也想从分类页取（搜索页没见到列表形态）
  if (!listHtml) {
    for (const c of catalogLinks.slice(0, 5)) {
      try {
        const res = await fetchPage(c.url, { jar, headers: { Referer: base + '/' } });
        if (res.status >= 400) continue;
        const $t = cheerio.load(res.text);
        const cont = sniffBookList($t, res.url || c.url);
        if (cont) {
          listHtml = res.text;
          listUrl = res.url || c.url;
          step('分类页可用', true, `${c.name} 命中 ${cont.itemCount} 条`);
          break;
        }
      } catch (e) { /* 继续 */ }
    }
    if (!listHtml) {
      step('分类页可用', false, '首页里的分类入口都取不到书籍列表');
      if (directDetail) {
        // 搜索可用但全站找不到列表形态：用「详情页自身」作列表样本，
        // ruleSearch 走 og 兜底（本引擎与线上笔趣阁类书源同款套路）
        listHtml = directDetail.html;
        listUrl = directDetail.url;
        ogForced = true;
        notes.push('未能识别书籍列表容器，ruleSearch 将用 OpenGraph 兜底（多结果搜索可能只出 1 条）');
      } else {
        return { ok: false, steps, notes, error: '既没有可用的搜索接口，也没有可用的分类页——该站点无法生成书源' };
      }
    }
  }
  // 无论搜索是否成功，都把能用的分类页收进 ruleExplore
  for (const c of catalogLinks) {
    if (explore.length >= 8) break;
    if (explore.some((x) => x.url === c.url)) continue;
    explore.push(c);
  }

  const $list = cheerio.load(listHtml);
  const listCont = sniffBookList($list, listUrl);
  let listRule;
  if (listCont && !ogForced) {
    step('识别书籍列表', true, `容器 ${listCont.containerSel}，${listCont.itemCount} 条`);
    listRule = deriveListItemRules($list, listUrl, listCont);
    if (!listRule.bookUrl) {
      step('提取书籍链接', false, '列表项里找不到指向本站的书籍链接');
      return { ok: false, steps, notes, error: '无法从列表里提取书籍链接' };
    }
    step('提取列表字段', true, `书名 ${listRule.name || '—'} / 链接 ${listRule.bookUrl}${listRule.author ? ' / 作者 ' + listRule.author : ''}`);
  } else {
    step('识别书籍列表', false, '列表页里找不到书籍条目容器');
    if (!directDetail) {
      return { ok: false, steps, notes, error: '无法识别书籍列表结构' };
    }
    // 单结果直达型站点且找不到任何列表形态：og 兜底规则。
    // 多结果列表页将搜不到条目、单结果直达时正常出书 —— 引擎的
    // _readBookInfo 兜底路径（含 302 落点回填）配合这条规则是线上验证过的写法。
    listRule = {
      bookList: 'body:has([property="og:novel:book_name"])',
      name: 'meta[property="og:novel:book_name"]@content||h1@text',
      author: 'meta[property="og:novel:author"]@content',
      kind: 'meta[property="og:novel:category"]@content',
      intro: 'meta[property="og:description"]@content',
      coverUrl: 'meta[property="og:image"]@content',
      bookUrl: 'meta[property="og:url"]@content||meta[property="og:novel:book_url"]@content',
      lastChapter: 'meta[property="og:novel:latest_chapter_name"]@content||meta[property="og:novel:lastest_chapter_name"]@content',
    };
    step('提取列表字段', true, 'OpenGraph 兜底规则（详情页驱动）');
  }

  /* --- 4. 详情页 --- */
  let detailRes;
  let detailUrl;
  if (directDetail) {
    // 搜索时已经拿到过详情页，不再重复请求
    detailRes = { text: directDetail.html, url: directDetail.url, status: 200 };
    detailUrl = directDetail.url;
    step('进入详情页', true, `复用搜索直达页 ${shortUrl(directDetail.url)}`);
  } else {
    const firstHref = resolveRuleOn($list, listCont.sample, listRule.bookUrl, listUrl);
    if (!firstHref) {
      step('进入详情页', false, '从列表项解析不出书籍地址');
      return { ok: false, steps, notes, error: '无法解析书籍详情地址' };
    }
    try {
      detailRes = await fetchPage(firstHref, { jar, headers: { Referer: listUrl } });
    } catch (e) {
      step('进入详情页', false, e.message);
      return { ok: false, steps, notes, error: `详情页无法访问：${e.message}` };
    }
    detailUrl = detailRes.url || firstHref;
    step('进入详情页', true, shortUrl(detailUrl));
  }
  const $detail = cheerio.load(detailRes.text);
  const bookInfo = sniffBookInfo($detail, detailUrl);
  step('解析详情页', true, `书名 ${bookInfo.name || '—'}${bookInfo.author ? ' / 作者 ' + bookInfo.author : ''}`);

  /* --- 5. 目录 --- */
  let toc = sniffToc($detail, detailUrl, detailUrl);
  if (!toc) {
    step('识别目录', false, '详情页里找不到章节列表');
    return { ok: false, steps, notes, error: '无法识别目录结构（详情页里没有成规模的章节链接）' };
  }
  let tocRule = {
    chapterList: toc.itemSel,
    chapterName: 'a@text',
    chapterUrl: 'a@href',
  };
  step('识别目录', true, `${toc.itemSel}，${toc.count} 章（章名匹配率 ${(toc.chapterRatio * 100).toFixed(0)}%）`);

  /* --- 5.5 目录分页 --- */
  // 详情页目录常只列前 100 章（m.bqg52.com 全站 689 章只露 112）：
  // 找「查看更多章节/下一页」类子页链接 → 到子页重嗅目录 →
  // ruleBookInfo.tocUrl 用 text.…@href 规则（引擎在详情页上求值出子页地址），
  // ruleToc.nextTocUrl='text.下一页@href' 让引擎串行翻到最后一页（url 去重合并）。
  let tocCtx = { $: $detail, url: detailUrl };
  {
    const originD = originOf(detailUrl);
    const detailDir = detailUrl.replace(/[^/?#]*(\?|#)?$/, '');
    const subCands = [];
    for (const a of $detail('a[href]').toArray()) {
      const t = ($detail(a).text() || '').trim();
      if (!t || t.length > 24) continue;
      if (!/下一页|下页|更多章节|完整目录|全部章节|查看全部|更多目录/.test(t)) continue;
      const h = abs(detailUrl, $detail(a).attr('href'));
      if (!h || originOf(h) !== originD || h === detailUrl) continue;
      if (!h.startsWith(detailDir)) continue; // 必须是本书目录下的子页
      subCands.push({ t, h });
    }
    for (const cand of subCands.slice(0, 3)) {
      let subRes;
      let $sub;
      let toc2;
      try {
        subRes = await fetchPage(cand.h, { jar, headers: { Referer: detailUrl } });
        $sub = cheerio.load(subRes.text);
        toc2 = sniffToc($sub, subRes.url || cand.h, subRes.url || cand.h);
        if (!toc2) continue;
        // 比较的是「主导目录内的章链数」而不是原始链接数（211 vs 119 那种假高）
        if ((toc2.inChapter || toc2.count) < (toc.inChapter || toc.count) * 0.95) continue;
        // 子页必须还能「下一页」续下去，否则只是同一页换个入口，不值得换起点
        const hasNext = $sub('a[href]').toArray().some((a) => {
          const t2 = ($sub(a).text() || '').trim();
          if (!/下一页|下页/.test(t2)) return false;
          const h2 = abs(subRes.url || cand.h, $sub(a).attr('href'));
          return h2 && originOf(h2) === originD && h2 !== (subRes.url || cand.h);
        });
        if (!hasNext) continue;
        tocRule = {
          chapterList: toc2.itemSel,
          chapterName: 'a@text',
          chapterUrl: 'a@href',
          nextTocUrl: 'text.下一页@href',
        };
        // DOM 文本的尾部省略号常是 CSS ::after 画的（bqg52「查看更多章节」实测无实点），
        // text. 规则 includes 匹配会被假点崩掉 → 构建规则前剥掉尾标点
        const tip = cand.t.replace(/[@|#|&&]/g, '').replace(/[….。．·、\s.]+$/g, '').slice(0, 16);
        if (!tip) continue;
        bookInfo.tocUrl = `text.${tip}@href`;
        toc = toc2;
        tocCtx = { $: $sub, url: subRes.url || cand.h };
        step('目录分页', true, `子页 ${shortUrl(cand.h)} ${toc2.count} 章；tocUrl=${bookInfo.tocUrl}，nextTocUrl=text.下一页@href`);
        break;
      } catch (e) {
        step('目录分页', false, e.message);
        break;
      }
    }
  }

  /** 目录头部导航杂质（真目录之前常混入这些项） */
const JUNK_TOC_RE = /^(最新章节\s*[：:]|【[^】]*】|第?\s*\d+\s*页|上一页|下一页?(页)?|(返回|全书|全部)目录|开始阅读|.*TXT.{0,6}下载|(百度|搜狗|谷歌)搜索)/i;

/* --- 5.9 目录头部杂质：笔趣阁族常在真目录前塞「最新章节：…」捷径、「【在百度搜索…】」、
     「【…TXT下载】」等条目。从头数连续杂质项，用 :nth-of-type 跳过（引擎/cheerio 都支持）。 --- */
  if (toc && tocRule && toc.itemSel) {
    const $tl = tocCtx.$ || $detail;
    const all = $tl(toc.itemSel).toArray();
    let k = 0;
    while (k < 8 && k < all.length && JUNK_TOC_RE.test(($tl(all[k]).text() || '').trim())) k++;
    if (k > 0 && all.length - k >= 10) {
      toc.itemSel = `${toc.itemSel}:nth-of-type(n+${k + 1})`;
      tocRule.chapterList = toc.itemSel;
      step('识别目录', true, `目录前 ${k} 项为导航杂质已跳过（${toc.itemSel}）；有效 ${all.length - k} 章`);
    }
  }

  /* --- 5.9b 「最新章节」捷径块检测：目录列表里「第N章」序号一旦出现非升序（头部混 689..682 降序块、
     尾部混 1..6 快捷块——bqg52 的 my1 就是三段混在一个 ul 里），CSS 表达不了「跳头留尾」，
     改打引擎扩展字段 sortByOrdinal：引擎去重后按章节序号稳定重排。 --- */
  if (toc && tocRule && toc.itemSel) {
    const $tt = tocCtx.$ || $detail;
    const items = $tt(toc.itemSel).toArray();
    if (items.length >= 30) {
      const ord = [];
      for (const el of items) {
        const n = chapterOrdinal(($tt(el).text() || '').trim());
        if (n != null) ord.push(n);
      }
      if (ord.length >= items.length * 0.6) {
        let outOfOrder = false;
        for (let i = 1; i < ord.length; i++) if (ord[i] < ord[i - 1]) { outOfOrder = true; break; }
        if (outOfOrder) {
          tocRule.sortByOrdinal = true;
          step('识别目录', true, '目录混有「最新章节」捷径块（序号非升序），已启用按章节序号排序');
        }
      }
    }
  }

  /* --- 6. 正文 --- */
  let contentRule = { content: '', nextContentUrl: '' };
  const firstChapter = resolveChapterUrl(tocCtx.$, toc, tocCtx.url);
  if (firstChapter) {
    // 有的站对爬虫吐「空章」（正文只剩提示语）——多试几章，取字数最多的一章做嗅探样本
    const $t3 = tocCtx.$ || $detail;
    const nToc = $t3(toc.itemSel).length || 10;
    const candIdxs = [0, 1, 2, Math.min(nToc - 1, Math.max(3, Math.floor(nToc / 50)))];
    let best = null;
    for (const ci of new Set(candIdxs)) {
      let cu = ci === 0 ? firstChapter : null;
      if (!cu) {
        const el = $t3(toc.itemSel).toArray()[ci];
        if (el) {
          const $it = $t3(el);
          const $a = $it.find('a[href]').first().length ? $it.find('a[href]').first() : $it.filter('a[href]').first();
          cu = $a.length ? abs(tocCtx.url, $a.attr('href')) : '';
        }
      }
      if (!cu) continue;
      try {
        const chRes = await fetchPage(cu, { jar, headers: { Referer: tocCtx.url } });
        const $ch = cheerio.load(chRes.text);
        const c = sniffContent($ch, chRes.url || cu);
        if (!c) continue;
        const plainLen = String($ch(c.sel).text() || '').replace(/\s+/g, '').length;
        if (!best || plainLen > best.plainLen) best = { c, chRes, $ch, plainLen };
        if (best.plainLen >= 400) break; // 够长就当它是真正文，不再多试
      } catch (_) { /* 换下一张 */ }
    }
    if (best) {
      const c = best.c;
      const $ch = best.$ch;
      contentRule = { content: c.content, nextContentUrl: c.nextContentUrl };
      step('识别正文', true, `${c.sel}，约 ${best.plainLen} 字${c.nextContentUrl ? '（有分页）' : ''}`);
      // 正文里混入的导航噪声：「上一章…下一章」导航、「（第N页）」水印尾巴、书签/推荐行、面包屑
      // （引擎按 Legado 语义对整章正文全局应用 ruleContent.replaceRegex 替换为空串）
      try {
        const plain = String($ch(c.sel).text() || '');
        const pats = [];
        if (/上一章[\s\S]{0,24}下一章/.test(plain)) pats.push('\\s*上一章[\\s\\S]{0,24}?下一章');
        if (/（第\s*\d+\s*页）|\(\s*第\s*\d+\s*页\s*\)/.test(plain)) pats.push('（第\\s*\\d+\\s*页）|\\(\\s*第\\s*\\d+\\s*页\\s*\\)');
        if (/加入书签|推荐本书|打开书架|添加书签|阅读记录|报告错误|相邻推荐|返回目录|返回书页/.test(plain)) {
          pats.push('[^\\n]*(?:加入书签|推荐本书|打开书架|添加书签|阅读记录|报告错误|相邻推荐|返回目录|返回书页)[^\\n]*');
        }
        if (/浏览器阅读模式/.test(plain)) pats.push('[^\\n]*浏览器阅读模式[^\\n]*');
        // 面包屑噪声（「好看的小说 > 介绍 > 书名 …」尾巴措辞每页随机换，按 > 结构整行剥；
        // 正文行里出现「汉字 > 汉字」的极罕见，Legado 站源同款做法）
        if (/[\u4e00-\u9fa5A-Za-z0-9]{2,12}\s*>\s*[\u4e00-\u9fa5]/.test(plain)) pats.push('[^\\n]*\\s>\\s[^\\n]*');
        if (pats.length) {
          contentRule.replaceRegex = pats.join('|');
          notes.push('正文含导航噪声，已生成 replaceRegex 清洗规则');
          step('识别正文', true, `${c.sel}，约 ${best.plainLen} 字${c.nextContentUrl ? '（有分页）' : ''}；已加正文清洗规则`);
        }
      } catch (_) { /* 清洗探测非致命 */ }
    } else {
      step('识别正文', false, '正文页里找不到正文块');
    }
  } else {
    step('识别正文', false, '目录里解析不出章节地址');
  }

  /* --- 7. 组装书源 --- */
  if (!contentRule.content) {
    // 红线：正文认不出来 = 读不了 = 不能自动添加。
    // 得奇型 AJAX 正文页会走到这里；把已嗅到的规则一并返回，便于用户手工补 @js。
    notes.push('正文规则缺失：若该站正文靠 JS/AJAX 加载，纯选择器无法覆盖，需手工补 @js 规则后走「粘贴 JSON 导入」');
    return {
      ok: false,
      steps,
      notes,
      error: '未能识别正文容器——该站点正文疑似动态加载，自动转换不允许添加',
      source: null,
      partial: { listRule, bookInfo, tocRule },
    };
  }
  const name = guessSiteName(homeTitle, base);
  const source = {
    bookSourceName: name,
    bookSourceGroup: '自动生成',
    bookSourceType: 0,
    bookSourceUrl: base,
    bookSourceComment: `由「网页转书源」自动生成（${new Date().toISOString().slice(0, 10)}）。探测量：搜索${form ? '有' : '无'}、分类${explore.length}项、目录${toc.count}章。规则为纯 CSS 选择器；若站点有 JS 加密/签名，需要手工补充 @js 规则。`,
    enabled: true,
    enabledExplore: explore.length > 0,
    enabledCookieJar: true,
    customOrder: 0,
    concurrentRate: '1/1000',
    header: JSON.stringify({ 'User-Agent': http.DEFAULT_UA, Referer: base + '/' }),
    searchUrl: searchUrl || '',
    ruleSearch: listRule,
    ruleBookInfo: bookInfo,
    ruleToc: tocRule,
    ruleContent: contentRule,
    ruleExplore: explore.map((x) => ({ name: x.name, url: pathOf(x.url) })),
    ruleExplore_item: {
      bookList: listRule.bookList,
      name: listRule.name,
      bookUrl: listRule.bookUrl,
      coverUrl: listRule.coverUrl,
      author: listRule.author,
    },
    weight: 0,
    respondTime: 8000,
  };

  if (!source.searchUrl) {
    notes.push('未能识别搜索接口，只生成了发现（分类）入口；该源可浏览分类找书，但书名搜索不可用。');
  }

  return { ok: true, source, steps, notes };
}

/** 把绝对 URL 转成相对路径（保留 query） */
function pathOf(url, param) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch (_) {
    return url;
  }
}

/** 往 URL 上追加查询参数 */
function appendQuery(url, param, value) {
  try {
    const u = new URL(url);
    u.searchParams.set(param, value);
    return u.toString();
  } catch (_) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}${param}=${encodeURIComponent(value)}`;
  }
}

/** 猜站点名：从首页标题里切 */
function guessSiteName(title, base) {
  let t = String(title || '').trim();
  // 标题常是「XXX小说-最新章节」或「借剑幼儿园一把手无防盗免费阅读 - 笔趣阁」
  t = t.split(/[-_|｜]/).pop() || t;
  t = t.replace(/(最新章节|无弹窗|免费阅读|小说阅读网|小说网|无错版|精校版|全文阅读|在线阅读).*$/, '');
  t = t.trim();
  if (t.length >= 2 && t.length <= 12) return t;
  try {
    return new URL(base).hostname.replace(/^www\./, '');
  } catch (_) {
    return '自动生成书源';
  }
}

/**
 * 在样本元素上跑一条我们自己生成的选择器，取出值。
 * 只支持本模块会生成的形态：`sel@attr` / `sel@text` / `sel a@text` 等（含 `||`）。
 */
function resolveRuleOn($, sampleEl, rule, baseUrl) {
  if (!rule) return '';
  for (const alt of String(rule).split('||')) {
    const m = alt.match(/^(.*?)@(href|src|text|content)$/);
    if (!m) continue;
    const [, sel, op] = m;
    let target;
    if (!sel.trim()) target = $(sampleEl);
    else {
      const $s = $(sampleEl).find(sel.trim());
      target = $s.length ? $s.first() : $(sampleEl).filter(sel.trim()).first();
    }
    if (!target || !target.length) continue;
    if (op === 'text') {
      const t = (target.text() || '').trim();
      if (t) return t;
    } else {
      const v = target.attr(op) || '';
      if (v) return op === 'href' || op === 'src' ? abs(baseUrl, v) : v;
    }
  }
  return '';
}

/** 从详情页按目录规则解析出第一章地址 */
function resolveChapterUrl($, toc, baseUrl) {
  const links = $(`${toc.itemSel} a[href]`).toArray();
  for (const a of links) {
    const h = abs(baseUrl, $(a).attr('href'));
    if (h) return h;
  }
  // itemSel 里已含 a 的情况
  const links2 = $(toc.itemSel).toArray();
  for (const el of links2) {
    const href = $(el).attr('href');
    const h = abs(baseUrl, href);
    if (h) return h;
  }
  return '';
}

module.exports = {
  generateSource,
  normalizeSiteUrl,
  findSearchForm,
  findCatalogLinks,
  sniffBookList,
  sniffBookInfo,
  sniffToc,
  sniffContent,
  DEFAULT_KEYWORD,
  KEYWORD_FALLBACKS,
  /* 单测用纯函数 */
  deriveListItemRules,
  selectorOf,
  relPathWithin,
  itemSelectorSeg,
  templateSearchUrl,
  looksLikeDetailPage,
  looksLikeChapterName,
  chapterOrdinal,
  cn2num,
  jsFormTemplates,
  R: require('../rules/rule.js'),
  fetchText,
};
