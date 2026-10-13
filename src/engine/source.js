'use strict';
/**
 * 书源引擎：把「书源 JSON + 规则求值 + HTTP + CookieJar + JS 运行时」组装成
 * 搜索 / 详情 / 目录 / 正文 / 发现 五类操作。
 *
 * ## 预取-重跑循环
 * `@js:` 里 `java.ajax(...)` 在 Legado 中是同步的。本实现里它是「查缓存，未命中返回空串
 * 并登记 miss」。引擎在一次求值后检查 miss，并发取回，然后重跑规则；因为缓存已填，
 * 第二次跑就是确定性的，结果与同步语义等价。最多跑 `MAX_ROUNDS` 轮防死循环。
 */

const cheerio = require('cheerio');
const { JsRuntime, Prefetcher } = require('../rules/jsrt');
const { CookieJar } = require('../net/cookiejar');
const http = require('../net/http');
const R = require('../rules/rule');
const H = require('../util/htmlformat');

/**
 * 预取-重跑的最大轮数。
 *
 * 每轮最多只能发现「一个」尚未缓存的 URL（`getSync` 是同步的，未命中即返回空），
 * 所以串行翻页 N 页就需要 N 轮。这里给足空间，页数本身另有上限：
 * 目录 `toc()` 的 `guard < 200`、正文 `content()` 的 `opts.maxPages`（默认 50）。
 */
const MAX_ROUNDS = 64;

/* ------------------------------------------------------------------ *
 * 请求头解析
 * ------------------------------------------------------------------ */

/**
 * 解析页面并挂上原始 HTML。
 *
 * 页面级规则的初始 `result` 是**响应体原文**（对齐 Legado 的 `AnalyzeRule.content`），
 * 而 `$.html()` 会被 cheerio 规范化（补 html/head/body、重排属性顺序），
 * 对「在原文里用正则捞 base64 / og meta」这类规则不稳。所以把原文挂在实例上，
 * 由 `rule.js::pageHtmlOf($)` 优先取用（真实用例：7908 神文 `ruleContent.content`、
 * 7908 `ruleBookInfo.coverUrl`、7940 uu书库 `ruleSearch.bookList`）。
 */
function loadDoc(html) {
  const $ = cheerio.load(html);
  if (html) $.__srcHtml = String(html);
  return $;
}

/** 书源 header 字段是 JSON 字符串 */
function parseHeader(header) {
  if (!header) return {};
  if (typeof header === 'object') return { ...header };
  try {
    const h = JSON.parse(header);
    return h && typeof h === 'object' ? h : {};
  } catch (_) {
    return {};
  }
}

/** 展开 URL 模板里的占位符：{{key}} {{page}} {{searchKey}} 等 */
function expandTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_m, expr) => {
    const e = expr.trim();
    if (e in vars) return vars[e] == null ? '' : String(vars[e]);
    return '';
  });
}

/** `<1,2,3>` 形式的分页规则（Legado `pagePattern = Regex("<(.*?)>")`） */
const PAGE_PATTERN = /<(.*?)>/g;
/** `url,{options}` 形式里逗号的形态（Legado `paramPattern = Regex("\\s*,\\s*(?=\\{)")`） */
const PARAM_PATTERN = /\s*,\s*(?=\{)/;
/** JS 块（Legado `AppPattern.JS_PATTERN`） */
const JS_PATTERN = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;

/**
 * 复刻 Legado `AnalyzeUrl` 的 `initUrl()` → 三条顺序流水线：
 *
 *   1. `analyzeJs()`          — 把 `<js>` / `@js:` 块执行掉，块之间的文本用 `@result` 承接上一块输出
 *   2. `replaceKeyPageJs()`   — 替换 `{{...}}` 内嵌 JS，再替换 `<a,b,c>` 分页规则
 *   3. `analyzeUrl()`         — 按 `,\s*{` 切出 URL 与 `UrlOption` JSON
 *
 * 这解释了为什么神文小说(7908) 的 searchUrl 整体是 `@js:` 开头：它必须先跑 JS 才能
 * 得到 `https://www.shenwen.org/search.html,{...}` 这个字符串，而不是把 `@js:` 当 URL。
 *
 * @param {string} ruleUrl 原始 URL 规则文本
 * @param {(code: string, result: string) => any} evalJs JS 求值函数
 * @param {{key?:string, page?:number, baseUrl?:string}} vars
 * @returns {{urlRaw:string, options:object, jsErrors:string[]}}
 */
function resolveUrlRule(ruleUrl, evalJs, vars = {}) {
  const jsErrors = [];
  let result = String(ruleUrl);

  /* ---- 1. analyzeJs：JS 块管道，块间文本承接 @result ---- */
  JS_PATTERN.lastIndex = 0;
  const matches = [...String(ruleUrl).matchAll(JS_PATTERN)];
  if (matches.length) {
    let start = 0;
    result = String(ruleUrl);
    for (const m of matches) {
      const at = m.index;
      if (at > start) {
        const between = String(ruleUrl).slice(start, at).trim();
        if (between) result = between.replace(/@result/g, result);
      }
      const code = m[2] && m[2] !== '' ? m[2] : m[1];
      try {
        const v = evalJs(code, result);
        result = v == null ? '' : String(v);
      } catch (e) {
        jsErrors.push(`searchUrl JS 执行失败：${e.message}`);
        result = '';
      }
      start = at + m[0].length;
    }
    const tail = String(ruleUrl).slice(start).trim();
    if (tail) result = tail.replace(/@result/g, result);
  } else {
    result = String(ruleUrl);
  }

  /* ---- 2. replaceKeyPageJs：先 {{...}} 内嵌 JS，再 <a,b,c> 分页 ---- */
  if (result.includes('{{') && result.includes('}}')) {
    result = result.replace(/\{\{([\s\S]*?)\}\}/g, (_m, code) => {
      try {
        const v = evalJs(String(code).trim(), result);
        if (v == null) return '';
        if (typeof v === 'number' && Number.isInteger(v)) return String(v);
        return String(v);
      } catch (e) {
        jsErrors.push(`{{}} JS 执行失败：${e.message}`);
        return '';
      }
    });
  }
  if (vars.page != null) {
    const page = Number(vars.page);
    PAGE_PATTERN.lastIndex = 0;
    const pm = [...result.matchAll(PAGE_PATTERN)];
    for (const m of pm) {
      const pages = m[1].split(',');
      const pick = page < pages.length ? pages[page - 1] : pages[pages.length - 1];
      result = result.replace(m[0], String(pick).trim());
    }
  }

  /* ---- 3. analyzeUrl：切 URL 与 options ---- */
  let urlRaw = result;
  let options = {};
  const pm = PARAM_PATTERN.exec(result);
  if (pm) {
    urlRaw = result.slice(0, pm.index);
    const optStr = result.slice(pm.index + pm[0].length);
    try {
      options = JSON.parse(optStr);
    } catch (_) {
      // 容错：截到最后一个 '}'（Legado 会退回宽松 GSON 解析并打日志）
      const end = optStr.lastIndexOf('}');
      if (end > 0) {
        try { options = JSON.parse(optStr.slice(0, end + 1)); } catch (_e) { options = {}; }
      }
    }
  }
  return { urlRaw: urlRaw.trim(), options: options || {}, jsErrors };
}

/**
 * 在「一条列表结果」上求一个字段规则。
 *
 * 对齐 Legado `BookChapterList.kt:232-240` / `BookList.kt`：列表规则的产出有三种形态，
 * 每种对应一种「取字段」的方式：
 *   - 元素（jsoup Element）→ 以该元素为上下文求值（`analyzeRule.setContent(item)`）
 *   - JS 对象（Legado NativeObject）→ 直接把规则当键名/`@js:`/JSONPath 取值
 *   - HTML 字符串（JS 返回字符串数组，如神文小说）→ 把该串重新解析成文档再求值
 *
 * @param {string} rule 字段规则
 * @param {object} $ 整页 cheerio
 * @param {object} ctx
 * @param {{kind:'elem'|'item'|'html'|'text', value:any}} target
 * @param {object} [rt] JS 运行时
 * @returns {string}
 */
function evalFieldOn(rule, $, ctx, target, rt) {
  if (rule == null || rule === '') return '';
  const r = String(rule);
  if (target.kind === 'item') {
    const v = R.pickItemField(target.value, r, { ...ctx, js: rt });
    return v == null ? '' : String(v);
  }
  if (target.kind === 'html' || target.kind === 'text') {
    // 列表规则产出字符串（HTML 片段或纯文本）时，Legado 走 `setContent(item)`：
    // 该字符串就是本条目的 `result`。`rule.js` 里 `result0` 同时喂给两种求值路径 ——
    // `@js:` 块直接把 `result0` 当 `result`（7940 的 `JSON.parse(String(result)).n`），
    // 选择器规则则把 `result0` 当文档解析（7908 的 `a@text`）。
    const opts = { result0: String(target.value) };
    return String(R.evalRule(r, $, ctx, opts).text || '');
  }
  return String(R.evalRule(r, $, ctx, { root: target.value }).text || '');
}

/* ------------------------------------------------------------------ *
 * 引擎
 * ------------------------------------------------------------------ */

class SourceEngine {
  /**
   * @param {object} source 书源 JSON
   * @param {object} [opts] { jar, logger, httpOptions }
   */
  constructor(source, opts = {}) {
    this.source = source || {};
    this.name = this.source.bookSourceName || '(未命名)';
    this.baseUrl = this._normalizeBase(this.source.bookSourceUrl || '');
    this.jar = opts.jar || new CookieJar();
    this.logger = opts.logger || null;
    this.httpOptions = opts.httpOptions || {};
    this.lastDiagnostics = { unsupported: [], errors: [] };
    this.requestCount = 0;
  }

  _normalizeBase(u) {
    if (!u) return '';
    // 部分书源 baseUrl 带路径或没有尾斜杠
    return String(u).trim().replace(/\/+$/, '');
  }

  _headers() {
    return parseHeader(this.source.header);
  }

  /** 相对 URL 补全（相对书源 baseUrl） */
  _abs(href) {
    return R.absUrl(this.baseUrl + '/', href);
  }

  /**
   * 带 cookie 的请求。
   * 优先级：httpOptions.headers（全局，如 UA）< source.header（书源头）< options.headers（调用点）
   */
  async _fetch(url, options = {}) {
    const jar = this.source.enabledCookieJar === false ? null : this.jar;
    const runtimeHeaders = { ...(this.httpOptions.headers || {}) };
    this.requestCount++;
    return http.request(url, {
      timeout: this.httpOptions.timeout || 25000,
      ...options,
      jar,
      headers: { ...runtimeHeaders, ...this._headers(), ...(options.headers || {}) },
    });
  }

  /** 构造一次求值会话（含 JS 运行时与预取器） */
  _makeRuntime(extraVars = {}) {
    const prefetcher = new Prefetcher();
    const rt = new JsRuntime({
      prefetcher,
      jar: this.jar,
      source: this.source,
      logger: this.logger,
    });
    return { prefetcher, rt, extraVars };
  }

  /**
   * 执行一段「会产生网络请求」的求值：预取-重跑循环。
   * @param {(ctx:object)=>any} fn 接受 { rt } 返回结果（可能是 Promise，但内部必须同步）
   * @param {object} vars
   */
  async _runWithPrefetch(fn, vars = {}) {
    const { prefetcher, rt } = this._makeRuntime(vars);
    rt.resetDiagnostics();
    const maxRounds = Math.max(1, this.httpOptions.maxRounds || MAX_ROUNDS);

    for (let round = 0; round < maxRounds; round++) {
      prefetcher.clearMisses();
      let out;
      let threw = null;
      try {
        // fn 允许是 async（内部只做同步取值，async 只是语法糖），统一 await 以兼容两种写法
        out = await fn(rt);
      } catch (e) {
        threw = e;
      }

      if (!prefetcher.hasMisses()) {
        this.lastDiagnostics = rt.getDiagnostics();
        if (threw) throw threw;
        return out;
      }

      // 按登记顺序【串行】取回所有 miss。
      //
      // 这里必须串行，不能 Promise.all：Legado 的 `java.ajax` 在 Rhino 里是同步阻塞的，
      // 「调用顺序 = 执行顺序」，所以书源可以依赖前一个请求的副作用（典型是服务端
      // 通过 Set-Cookie 下发签名令牌，后一个 POST 才带得上它）。
      // 并发取回会打乱这个顺序，让后一个请求在 cookie 写入前就发出去。
      // 真实样本：7940 uu书库 `searchUrl` = ajax(00JT.html) → ajax(?action=signJs) → POST /search。
      const misses = prefetcher.takeMisses();
      if (this.logger) this.logger(`[prefetch] ${this.name} 第 ${round + 1} 轮，${misses.length} 个请求`);
      for (const m of misses) {
        const o = m.options || {};
        const url = String(m.url);
        try {
          const r = await this._fetch(url, {
            method: o.method || 'GET',
            body: o.body == null ? null : o.body,
            headers: o.headers || {},
            charset: o.charset || undefined,
          });
          prefetcher.cache.set(m.key, { status: r.status, text: r.text, url: r.url });
        } catch (e) {
          prefetcher.cache.set(m.key, { status: 0, text: '', url, error: String(e && e.message) });
        }
      }
    }

    this.lastDiagnostics = rt.getDiagnostics();
    throw new Error(`规则预取超过 ${maxRounds} 轮仍未收敛（可能存在链式 java.ajax）`);
  }

  /* ---------------- 搜索 ---------------- */

  /**
   * @param {string} keyword
   * @param {number} [page=1]
   * @returns {Promise<Array<{name,author,kind,intro,coverUrl,bookUrl,lastChapter,sourceName}>>}
   */
  async search(keyword, page = 1) {
    const searchUrl = this.source.searchUrl;
    if (!searchUrl) throw new Error(`书源「${this.name}」未定义 searchUrl`);

    const keyEnc = encodeURIComponent(keyword);
    const vars = {
      key: keyword,
      searchKey: keyEnc,
      page: String(page),
      searchPage: String(page),
      baseUrl: this.baseUrl,
    };
    const rawRule = String(searchUrl);

    return this._runWithPrefetch((rt) => {
      /* 复刻 AnalyzeUrl.initUrl()：先跑 JS 块 → 再替换 {{}} 与 <分页> → 再切 options */
      const evalJs = (code, res) => rt.runRaw
        ? rt.runRaw(code, { ...vars, result: res, cookie: this.jar, source: this.source, baseUrl: this.baseUrl })
        : rt.run(code, { ...vars, result: res, cookie: this.jar, source: this.source, baseUrl: this.baseUrl });
      const { urlRaw, options, jsErrors } = resolveUrlRule(rawRule, evalJs, vars);
      if (jsErrors.length) this.lastDiagnostics.errors.push(...jsErrors);

      const finalUrl = this._abs(urlRaw);
      if (!/^https?:\/\//i.test(finalUrl)) {
        throw new Error(`searchUrl 解析结果不是合法 URL（${String(urlRaw).slice(0, 60)}…）`);
      }

      const method = String(options.method || (options.body != null && options.body !== '' ? 'POST' : 'GET')).toUpperCase();
      const headers = {};
      for (const [k, v] of Object.entries(options.headers || {})) {
        headers[k] = typeof v === 'string' ? expandTemplate(v, vars) : v;
      }
      const body = options.body == null ? undefined : expandTemplate(String(options.body), vars);

      // 用预取器拿页面（同步语义）
      const html = rt.prefetcher.getSync(finalUrl, {
        method,
        body,
        headers,
        charset: options.charset,
      });

      if (!html) return []; // 本轮未取到，会重跑

      const $ = loadDoc(html);
      const rs = this.source.ruleSearch || {};
      const ctx = {
        baseUrl: finalUrl,
        source: this.source,
        js: rt,
        expand: null,
      };

      // bookList 选元素
      const listRule = rs.bookList || '';
      const listRes = R.evalRule(listRule, $, ctx, options.root ? {} : {});

      const out = [];

      // 逐字段求值：对每个 list 条目单独跑（元素 / JS 对象 / HTML 串三种形态）
      const targets = R.listTargets($, listRes);
      const fieldOf2 = (rule, target, dflt) => evalFieldOn(rule == null || rule === '' ? dflt : rule, $, ctx, target, rt);

      // bookList 选不中任何元素 → 该页面本身就是详情页，
      // 用 ruleBookInfo 解析一条（对齐 Legado BookList.kt:100-108 → getInfoItem）。
      // 注意绝不能拿 ruleSearch 的 name/bookUrl 去对整页求值：那样会把整页文本当成书名。
      if (!targets.length) {
        const info = this._readBookInfo($, rt, finalUrl);
        if (!info.name) return [];
        return [{
          name: info.name.trim(),
          author: (info.author || '').trim(),
          kind: (info.kind || '').trim(),
          intro: (info.intro || '').trim(),
          coverUrl: info.coverUrl || '',
          // 对齐 Legado：列表页即详情页时，bookUrl 就是当前地址
          bookUrl: info.bookUrl,
          lastChapter: (info.lastChapter || '').trim(),
          sourceName: this.name,
        }];
      }

      for (const target of targets) {
        const name = fieldOf2(rs.name, target, '');
        const bookUrl = fieldOf2(rs.bookUrl, target, '');
        if (!name && !bookUrl) continue;
        out.push({
          name: name.trim(),
          author: fieldOf2(rs.author, target, '').trim(),
          kind: fieldOf2(rs.kind, target, '').trim(),
          intro: fieldOf2(rs.intro, target, '').trim(),
          coverUrl: this._abs(fieldOf2(rs.coverUrl, target, '').trim()),
          bookUrl: this._abs(bookUrl.trim()),
          lastChapter: fieldOf2(rs.lastChapter, target, '').trim(),
          sourceName: this.name,
        });
      }
      return out;
    }, vars);
  }

  /* ---------------- 书籍详情 ---------------- */

  /**
   * 用 ruleBookInfo 解析一个详情页。
   * @param {object} $ cheerio 实例
   * @param {object} rt JS 运行时（供 {{...}} / init 规则用）
   * @param {string} url 该页地址
   */
  _readBookInfo($, rt, url) {
    const ri = this.source.ruleBookInfo || {};
    const ctx = { baseUrl: this.baseUrl, source: this.source, js: rt };
    const get = (rule) => {
      if (!rule) return '';
      if (rule === '{{baseUrl}}') return this.baseUrl;
      if (/^\{\{[\s\S]*\}\}$/.test(rule)) {
        const v = rt.run(rule.replace(/^\{\{|\}\}$/g, ''), { baseUrl: this.baseUrl, ...ctx });
        return v == null ? '' : String(v);
      }
      const r = R.evalRule(rule, $, ctx, {});
      return r.text;
    };
    const info = {
      name: get(ri.name),
      author: get(ri.author),
      kind: get(ri.kind),
      intro: get(ri.intro),
      coverUrl: this._abs(get(ri.coverUrl)),
      tocUrl: this._abs(get(ri.tocUrl)) || url,
      lastChapter: get(ri.lastChapter),
      wordCount: get(ri.wordCount),
      sourceName: this.name,
      bookUrl: url,
    };
    // init 规则：可能改写 bookUrl / tocUrl，或做登录
    if (ri.init) {
      const v = rt.run(String(ri.init).replace(/^@js:/, ''), { baseUrl: this.baseUrl, ...ctx, book: info });
      if (typeof v === 'string' && /^https?:/.test(v.trim())) info.tocUrl = v.trim();
    }
    return info;
  }

  async bookInfo(bookUrl) {
    const url = this._abs(bookUrl);
    return this._runWithPrefetch(async (rt) => {
      const html = rt.prefetcher.getSync(url, { method: 'GET' });
      if (!html) return null;
      const $ = loadDoc(html);
      return this._readBookInfo($, rt, url);
    }, {});
  }

  /* ---------------- 目录 ---------------- */

  /**
   * 目录（含分页合并）。
   *
   * 对齐 Legado `model/webBook/BookChapterList.kt`：
   *  - `chapterList` 规则以 `-` 开头 → 最终列表反转；`+` 开头 → 仅剥掉前缀。
   *  - `nextTocUrl` 求值为**字符串列表**（`getStringList(rule, isUrl = true)`），
   *    等于本页 redirectUrl 的项被丢弃。
   *  - 列表 0 条 → 不翻页；1 条 → 串行 while（`!nextUrlList.contains(nextUrl)` 防环）；
   *    >1 条 → 并发取各页且每页 `getNextUrl = false`（不再递归翻页），按顺序拼接。
   *  - 逐元素取 title/url/isVolume；url 为空时：卷 → `title + index`，否则 → 本页 url。
   *  - title 为空则丢弃该条。最后按 url 去重。
   *
   * @param {string} tocUrl
   * @returns {Promise<null|Array<{name,url,index,isVolume,isVip,isPay,tag,baseUrl}>>}
   */
  async toc(tocUrl) {
    const url = this._abs(tocUrl || this.baseUrl);
    const rc = this.source.ruleToc || {};
    let listRule = rc.chapterList == null ? '' : String(rc.chapterList);
    let reverse = false;
    if (listRule.startsWith('-')) { reverse = true; listRule = listRule.slice(1); }
    else if (listRule.startsWith('+')) { listRule = listRule.slice(1); }
    const nextTocRule = rc.nextTocUrl ? String(rc.nextTocUrl) : '';

    return this._runWithPrefetch(async (rt) => {
      /** 解析一页目录：章列表 + 下一页链接列表 */
      const parsePage = (html, pageUrl, getNextUrl) => {
        const $ = loadDoc(html);
        const ctx = { baseUrl: pageUrl, source: this.source, js: rt };
        const items = [];

        const nextUrls = [];
        if (getNextUrl && nextTocRule) {
          const seen = new Set([pageUrl]);
          const nr = R.evalRule(nextTocRule, $, ctx, {});
          for (const s of nr.strings || []) {
            const v = String(s).trim();
            if (!v) continue;
            const abs = R.absUrl(pageUrl, v);
            if (!abs || R.isBadUrl(abs) || seen.has(abs)) continue;
            seen.add(abs);
            nextUrls.push(abs);
          }
        }

        const listRes = R.evalRule(listRule, $, ctx, {});
        // 列表规则产出三种形态：cheerio 元素集合 / JS 对象数组 / HTML 字符串数组
        // （神文小说 7908 的 `@js:` 返回拼好的 `<a href>…</a>` 串，Legado 会把它当文档解析）
        const targets = R.listTargets($, listRes);
        targets.forEach((target, idx) => {
          const fieldOf = (rule, dflt) => evalFieldOn(rule == null || rule === '' ? dflt : rule, $, ctx, target, rt).trim();
          const name = fieldOf(rc.chapterName, 'text');
          let href = fieldOf(rc.chapterUrl, 'href');
          const isVolume = /^(true|1)$/i.test(fieldOf(rc.isVolume, ''));
          if (!href) {
            href = isVolume ? name + idx : pageUrl;
          }
          if (!name) return;
          items.push({
            name,
            // 章节链接相对「本页最终 URL」补全（Legado: bookChapter.baseUrl = redirectUrl）
            url: R.absUrl(pageUrl, href),
            index: 0,
            isVolume,
            isVip: /^(true|1)$/i.test(fieldOf(rc.isVip, '')),
            isPay: /^(true|1)$/i.test(fieldOf(rc.isPay, '')),
            tag: fieldOf(rc.updateTime, ''),
            baseUrl: pageUrl,
          });
        });
        return { items, nextUrls };
      };

      const chapters = [];
      let serialNext = url;
      let parallelQueue = null;
      const visited = new Set();
      let guard = 0;

      while (guard++ < 200) {
        if (parallelQueue) {
          const batch = parallelQueue;
          parallelQueue = null;
          let blocked = false;
          for (const u of batch) {
            if (!u || visited.has(u)) continue;
            visited.add(u);
            const html = rt.prefetcher.getSync(u, { method: 'GET' });
            if (!html) { blocked = true; continue; }
            const p = parsePage(html, u, false);
            chapters.push(...p.items);
          }
          if (blocked) return null;
          break;
        }

        const cur = serialNext;
        if (!cur || visited.has(cur)) break;
        visited.add(cur);
        const html = rt.prefetcher.getSync(cur, { method: 'GET' });
        if (!html) return null;
        const p = parsePage(html, cur, true);
        chapters.push(...p.items);

        if (!p.nextUrls.length) break;
        if (p.nextUrls.length === 1) serialNext = p.nextUrls[0];
        else parallelQueue = p.nextUrls;
      }

      if (!chapters.length) return [];

      // `-` 前缀表示书源声明站点顺序与阅读顺序相反
      if (reverse) chapters.reverse();

      // 按 url 去重（保留首次出现顺序）
      const seenUrl = new Set();
      const out = [];
      for (const c of chapters) {
        if (seenUrl.has(c.url)) continue;
        seenUrl.add(c.url);
        c.index = out.length;
        out.push(c);
      }
      return out;
    }, {});
  }

  /* ---------------- 正文 ---------------- */

  /**
   * 正文（含分页合并）。
   *
   * 对齐 Legado `model/webBook/BookContent.kt`：
   *  - `nextContentUrl` 的求值结果是**字符串列表**（`getStringList(rule, isUrl = true)`），
   *    不是单值；逐项绝对 URL 补全后去重（Legado `getResultLast` 也会去重）。
   *  - 列表 1 条 → 串行翻页（`while (nextUrl.isNotEmpty() && !nextUrlList.contains(nextUrl))`）；
   *    翻页前若命中的正是**下一章** URL 则立刻停止（避免把下一章正文吞进来）。
   *  - 列表 >1 条 → 并发取各页，且每页**不再递归翻页**（`getNextPageUrl = false`），按顺序拼接。
   *  - 每页都用**自己**的 url 作为 baseUrl 重新跑一次 `ruleContent.content`。
   *
   * 预取-重跑：某页未命中时本轮返回 null（外层填缓存后重跑，结果确定）。
   *
   * @param {string} chapterUrl
   * @param {{nextChapterUrl?:string, maxPages?:number}} [opts]
   * @returns {Promise<null|{text:string,url:string,pageCount:number,pageUrls:string[],title:string,nextContentUrl:string}>}
   */
  async content(chapterUrl, opts = {}) {
    const url = this._abs(chapterUrl);
    const rc = this.source.ruleContent || {};
    const maxPages = Math.max(1, opts.maxPages || 50);
    const nextChapterAbs = opts.nextChapterUrl ? R.absUrl(url, this._abs(opts.nextChapterUrl)) : '';
    const nextRule = rc.nextContentUrl ? String(rc.nextContentUrl) : '';

    return this._runWithPrefetch(async (rt) => {
      /** 解析一页：正文 + 下一页链接列表 */
      const parsePage = (html, pageUrl) => {
        const $ = loadDoc(html);
        const ctx = { baseUrl: pageUrl, source: this.source, js: rt };
        const r = R.evalRule(rc.content || '', $, ctx, {});
        let t = r.strings.join('\n');
        if (!t.trim() && r.elems && r.elems.length) t = r.elems.text();
        // 正文净化格式化，对齐 BookContent.kt:234-251 的 HtmlFormatter.formatKeepImg
        if (t) t = H.formatContent(t, pageUrl, (base, href) => R.absUrl(base, href));

        const nextUrls = [];
        if (nextRule) {
          const seen = new Set();
          const nr = R.evalRule(nextRule, $, ctx, {});
          for (const s of nr.strings || []) {
            const v = String(s).trim();
            if (!v) continue;
            const abs = R.absUrl(pageUrl, v);
            if (!abs || R.isBadUrl(abs) || seen.has(abs)) continue;
            seen.add(abs);
            nextUrls.push(abs);
          }
        }
        return { text: t, nextUrls, $, ctx };
      };

      const pageTexts = [];
      const pageUrls = [];
      const visited = new Set();
      let serialNext = url;
      let parallelQueue = null;
      let tailNext = '';
      let firstPage = null;
      let guard = 0;

      while (guard++ < maxPages) {
        if (parallelQueue) {
          // 并发分支：本批全部取完即结束，不再递归翻页
          const batch = parallelQueue.slice(0, maxPages);
          parallelQueue = null;
          let blocked = false;
          for (const u of batch) {
            if (!u || visited.has(u)) continue;
            visited.add(u);
            const html = rt.prefetcher.getSync(u, { method: 'GET' });
            if (!html) { blocked = true; continue; }
            const p = parsePage(html, u);
            pageUrls.push(u);
            pageTexts.push(p.text);
            if (!firstPage) firstPage = p;
          }
          if (blocked) return null; // 本轮有 miss，返回值会被外层丢弃并重跑
          break;
        }

        const cur = serialNext;
        if (!cur || visited.has(cur)) break;
        visited.add(cur);
        const html = rt.prefetcher.getSync(cur, { method: 'GET' });
        if (!html) return null;
        const p = parsePage(html, cur);
        if (!firstPage) firstPage = p;
        pageUrls.push(cur);
        pageTexts.push(p.text);

        if (!p.nextUrls.length) break;
        if (p.nextUrls.length === 1) {
          const nx = p.nextUrls[0];
          if (nextChapterAbs && nx === nextChapterAbs) { tailNext = nx; break; }
          serialNext = nx;
        } else {
          parallelQueue = p.nextUrls;
        }
      }

      if (!pageTexts.length) return null;

      // 章节标题（可选，正文之后再取，与 Legado 顺序一致）
      let title = '';
      if (rc.title && firstPage) {
        try {
          title = String(R.evalRule(rc.title, firstPage.$, firstPage.ctx, {}).text || '').trim();
        } catch (_) { title = ''; }
      }

      // subContent：规则文本；形如 http 开头则再取一次该 URL 的正文
      if (rc.subContent && firstPage) {
        const st = String(R.evalRule(rc.subContent, firstPage.$, firstPage.ctx, {}).text || '').trim();
        if (st) {
          if (/^https?:/i.test(st)) {
            let sub = rt.prefetcher.getSync(st, { method: 'GET' });
            if (!sub) return null; // 需要额外请求，等下一轮
            pageTexts.push(sub);
          } else {
            pageTexts.push(st);
          }
        }
      }

      return {
        text: cleanContent(pageTexts.join('\n\n')),
        url,
        pageCount: pageTexts.length,
        pageUrls,
        title,
        nextContentUrl: tailNext,
      };
    }, {});
  }

  /* ---------------- 发现（explore） ---------------- */

  async explore(exploreUrl, page = 1) {
    if (!exploreUrl) throw new Error('exploreUrl 为空');
    const vars = { page: String(page), baseUrl: this.baseUrl };
    const rawRule = String(exploreUrl);

    return this._runWithPrefetch((rt) => {
      const evalJs = (code, res) => rt.runRaw
        ? rt.runRaw(code, { ...vars, result: res, cookie: this.jar, source: this.source, baseUrl: this.baseUrl })
        : rt.run(code, { ...vars, result: res, cookie: this.jar, source: this.source, baseUrl: this.baseUrl });
      const { urlRaw, options, jsErrors } = resolveUrlRule(rawRule, evalJs, vars);
      if (jsErrors.length) this.lastDiagnostics.errors.push(...jsErrors);

      const url = this._abs(urlRaw);
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`exploreUrl 解析结果不是合法 URL（${String(urlRaw).slice(0, 60)}…）`);
      }
      const method = String(options.method || (options.body != null && options.body !== '' ? 'POST' : 'GET')).toUpperCase();
      const headers = {};
      for (const [k, v] of Object.entries(options.headers || {})) {
        headers[k] = typeof v === 'string' ? expandTemplate(v, vars) : v;
      }
      const body = options.body == null ? undefined : expandTemplate(String(options.body), vars);

      const html = rt.prefetcher.getSync(url, { method, body, headers, charset: options.charset });
      if (!html) return [];
      const $ = loadDoc(html);
      const ctx = { baseUrl: url, source: this.source, js: rt };
      const ri = this.source.ruleSearch || {};
      const listRes = R.evalRule(ri.bookList || '', $, ctx, {});
      const targets = R.listTargets($, listRes);
      const out = [];
      for (const target of targets) {
        const f = (rule, dflt) => evalFieldOn(rule == null || rule === '' ? dflt : rule, $, ctx, target, rt);
        const name = f(ri.name, '').trim();
        const bookUrl = f(ri.bookUrl, '').trim();
        if (!name && !bookUrl) continue;
        out.push({
          name,
          author: f(ri.author, '').trim(),
          kind: f(ri.kind, '').trim(),
          intro: f(ri.intro, '').trim(),
          coverUrl: this._abs(f(ri.coverUrl, '').trim()),
          bookUrl: this._abs(bookUrl),
          lastChapter: f(ri.lastChapter, '').trim(),
          sourceName: this.name,
        });
      }
      return out;
    }, vars);
  }
}

/** 找出 `url,{json}` 形式里分隔 URL 与 options 的逗号位置 */
function findOptionsComma(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ',') continue;
    const rest = s.slice(i + 1).trim();
    if (rest.startsWith('{')) return i;
  }
  return -1;
}

/**
 * 正文清洗：统一换行、合并空行、去行尾空白。
 *
 * ⚠️ 不能用 `String.trim()` 逐行清 —— `\u3000`（全角空格）在 Unicode 里属于空白，
 * 会被一并吃掉，而 `H.formatContent` 刚给每段补的段首缩进正是两个 `\u3000`。
 * 这里只清「行尾空白」与 ASCII 缩进，行首的 `\u3000` 原样保留。
 */
function cleanContent(text) {
  if (!text) return '';
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''));
  const out = [];
  for (const line of lines) {
    // 纯空白行（含只有全角空格的行）视为空行
    const blank = line.replace(/[\s\u3000]/g, '') === '';
    if (blank) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

module.exports = {
  SourceEngine,
  parseHeader,
  expandTemplate,
  resolveUrlRule,
  cleanContent,
  findOptionsComma,
  evalFieldOn,
  MAX_ROUNDS,
};
