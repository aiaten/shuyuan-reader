'use strict';
/**
 * 书源可读性探测（交付点 ③ 的核心校验）。
 *
 * 需求原文：「自定义书源是能够解析是否读取网站，不能读取的网站不能添加」
 *
 * 分 4 个阶段递进验证，任一致命阶段失败即判定「不可添加」：
 *
 *   1. `reach`     站点可达性     — baseUrl 能连上、不是 404/502、不是 DNS 失败
 *   2. `search`    搜索规则可用   — searchUrl 能取回内容（或 ruleExplore 至少一条能取回）
 *   3. `bookInfo`  详情规则可用   — 用搜索到的第一本书验证书名/作者能解出
 *   4. `toc`       目录规则可用   — 能解出 >=1 章
 *   5.（可选）`content` 正文规则可用 — 能解出非空正文
 *
 * 评分把「硬失败」和「软扣分」分开：
 *  - 硬失败（不可添加）：站点连不上、搜索与发现都无结果、目录 0 章。
 *  - 软扣分（仍可添加，但降级告警）：字段缺失、正文较短、响应慢、有 unsupported 诊断。
 */

const { SourceEngine } = require('../engine/source');
const http = require('../net/http');
const { CookieJar } = require('../net/cookiejar');

/** 阶段权重的总分（用于把扣分归一化成 0-100 分） */
const STAGES = ['reach', 'search', 'bookInfo', 'toc', 'content'];

const DEFAULTS = {
  /** 探测用的关键词，默认一个通用词 */
  keyword: '剑',
  /** 单阶段超时（毫秒） */
  stageTimeout: 30000,
  /** 是否继续验证正文（较慢） */
  checkContent: true,
  /** 只验证前 N 章正文 */
  contentSamples: 1,
  logger: null,
};

class ProbeResult {
  constructor() {
    this.ok = false;
    this.score = 0;
    this.stages = {};
    this.errors = [];
    this.warnings = [];
    this.details = {};
    this.elapsed = 0;
  }
  stage(name, ok, data = {}, weight = 1) {
    this.stages[name] = { ok, weight, ...data };
    if (!ok && data.fatal) this.errors.push(data.message || `${name} 失败`);
    return this;
  }
}

/** 给 Promise 套超时 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_res, rej) => {
      timer = setTimeout(() => rej(new Error(`${label} 超时（${ms}ms）`)), ms);
    }),
  ]);
}

/**
 * 探测一个书源是否可用。
 *
 * @param {object} source 书源 JSON
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, score:number, stages:object, errors:string[], warnings:string[], details:object, elapsed:number}>}
 */
async function probe(source, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const t0 = Date.now();
  const r = new ProbeResult();
  const log = o.logger || (() => {});

  if (!source || typeof source !== 'object') {
    r.errors.push('书源不是合法的 JSON 对象');
    r.elapsed = Date.now() - t0;
    return r;
  }
  const name = source.bookSourceName || '(未命名)';
  const rawUrl = String(source.bookSourceUrl || '').trim();
  if (!rawUrl) {
    r.errors.push('缺少 bookSourceUrl（书源必须声明站点地址）');
    r.elapsed = Date.now() - t0;
    return r;
  }
  if (!/^https?:\/\//i.test(rawUrl)) {
    // 部分书源用自定义 scheme（如 moyue:// 本地解析器），本引擎无法处理
    r.errors.push(`不支持的站点协议：${rawUrl.slice(0, 40)}（本引擎只支持 http/https）`);
    r.elapsed = Date.now() - t0;
    return r;
  }

  const jar = new CookieJar();
  const engine = new SourceEngine(source, {
    jar,
    logger: o.logger,
    httpOptions: { timeout: Math.min(o.stageTimeout, 25000) },
  });

  log(`探测 ${name} — ${rawUrl}`);

  /* ---- 1. 站点可达性 ---- */
  let reachUrl = rawUrl.replace(/\/+$/, '') + '/';
  let reachOk = false;
  let reachStatus = 0;
  let reachLen = 0;
  let reachErr = '';
  try {
    const res = await withTimeout(http.get(reachUrl, { jar, timeout: 20000 }), o.stageTimeout, '站点可达性');
    reachStatus = res.status;
    reachLen = res.text ? res.text.length : 0;
    reachOk = res.status >= 200 && res.status < 400 && reachLen > 0;
    if (!reachOk) reachErr = `HTTP ${res.status}，返回 ${reachLen} 字节`;
  } catch (e) {
    reachErr = e.message || String(e);
  }
  r.stage('reach', reachOk, {
    fatal: true,
    message: reachOk ? '' : `站点无法访问：${reachErr}`,
    url: reachUrl,
    status: reachStatus,
    length: reachLen,
    error: reachErr,
  }, 1);
  r.details.reach = { url: reachUrl, status: reachStatus, length: reachLen };
  if (!reachOk) {
    r.errors.push(`站点无法访问（${reachErr}）→ 不允许添加`);
    r.elapsed = Date.now() - t0;
    return r;
  }
  log(`  ✓ 可达 HTTP ${reachStatus}，${reachLen} 字节`);

  /* ---- 2. 搜索规则 ---- */
  const hasSearch = !!(source.searchUrl && String(source.searchUrl).trim());
  const exploreRules = Array.isArray(source.ruleExplore) ? source.ruleExplore : [];
  let searchItems = [];
  let searchErr = '';
  if (hasSearch) {
    try {
      searchItems = await withTimeout(engine.search(o.keyword, 1), o.stageTimeout, '搜索规则') || [];
    } catch (e) {
      searchErr = e.message || String(e);
    }
  }
  const searchOk = searchItems.length > 0;
  if (hasSearch) {
    r.stage('search', searchOk, {
      fatal: false,
      message: searchOk ? '' : `搜索「${o.keyword}」无结果${searchErr ? `：${searchErr}` : ''}`,
      keyword: o.keyword,
      count: searchItems.length,
      error: searchErr,
    }, 1);
  } else {
    r.stage('search', false, {
      fatal: false,
      message: '书源未声明 searchUrl（仅支持发现/explore）',
      skipped: true,
      count: 0,
    }, 0);
  }
  if (searchOk) log(`  ✓ 搜索命中 ${searchItems.length} 条`);
  else if (hasSearch) log(`  ✗ 搜索无结果 ${searchErr}`);

  /* ---- 2b. 发现规则（搜索不可用时的替代路径） ---- */
  let exploreItems = [];
  let exploreErr = '';
  if (!searchOk && exploreRules.length) {
    for (const ex of exploreRules.slice(0, 3)) {
      const u = ex && (ex.url || ex.exploreUrl);
      if (!u) continue;
      try {
        const items = await withTimeout(engine.explore(u, 1), o.stageTimeout, '发现规则') || [];
        if (items.length) { exploreItems = items; break; }
      } catch (e) {
        exploreErr = e.message || String(e);
      }
    }
    r.stage('explore', exploreItems.length > 0, {
      fatal: false,
      message: exploreItems.length ? '' : `发现规则无结果${exploreErr ? `：${exploreErr}` : ''}`,
      count: exploreItems.length,
      tried: Math.min(exploreRules.length, 3),
      error: exploreErr,
    }, 1);
    if (exploreItems.length) log(`  ✓ 发现命中 ${exploreItems.length} 条`);
  }

  const listOk = searchOk || exploreItems.length > 0;
  if (!listOk) {
    r.errors.push(
      hasSearch
        ? `搜索与发现均无法取回书籍列表 → 不允许添加`
        : `书源既无可用 searchUrl 也无可用 ruleExplore → 不允许添加`
    );
    // 站点点得通但规则读不出书 → 视为「不能读取」的典型情形
    r.score = 25;
    r.elapsed = Date.now() - t0;
    return r;
  }

  /* ---- 3. 详情规则 ---- */
  const first = (searchOk ? searchItems : exploreItems)[0];
  if (!first || !first.bookUrl) {
    r.errors.push('列表结果缺少 bookUrl，无法继续验证详情/目录规则 → 不允许添加');
    r.score = 35;
    r.elapsed = Date.now() - t0;
    return r;
  }
  let info = null;
  let infoErr = '';
  try {
    info = await withTimeout(engine.bookInfo(first.bookUrl), o.stageTimeout, '详情规则');
  } catch (e) {
    infoErr = e.message || String(e);
  }
  const infoOk = !!(info && (info.name || info.author));
  r.stage('bookInfo', infoOk, {
    fatal: false,
    message: infoOk ? '' : `详情规则解不出书名/作者${infoErr ? `：${infoErr}` : ''}`,
    bookUrl: first.bookUrl,
    name: info ? info.name : '',
    author: info ? info.author : '',
    error: infoErr,
  }, 1);
  r.details.book = first;
  if (infoOk) log(`  ✓ 详情《${info.name}》/ ${info.author || '无作者'}`);
  else log(`  ✗ 详情失败 ${infoErr}`);

  /* ---- 4. 目录规则 ---- */
  // 先按书源给的 tocUrl 试，失败再回退到详情页 bookUrl。
  // 回退是必要的：不少书源的 tocUrl 指向「分页目录页」，而 chapterList 规则实际只对
  // 详情页生效（例如 7941 的 `.info_dv3.1` 需要页面里有 2 个 .info_dv3）。只要其中
  // 任一路径能解出章节，就说明该站点「读得出来」。
  let toc = null;
  let tocErr = '';
  let tocUrl = (info && info.tocUrl) || first.bookUrl;
  let tocFallback = false;
  const tryToc = async (u) => {
    try {
      const res = await withTimeout(engine.toc(u), o.stageTimeout, '目录规则');
      return { list: Array.isArray(res) ? res : [], err: '' };
    } catch (e) {
      return { list: [], err: e.message || String(e) };
    }
  };
  {
    const r1 = await tryToc(tocUrl);
    toc = r1.list;
    tocErr = r1.err;
    if (!toc.length && first.bookUrl && first.bookUrl !== tocUrl) {
      log(`  · tocUrl 解不出章节，回退详情页重试`);
      const r2 = await tryToc(first.bookUrl);
      if (r2.list.length) {
        toc = r2.list;
        tocErr = '';
        tocFallback = true;
        tocUrl = first.bookUrl;
      } else if (r2.err) {
        tocErr = r2.err;
      }
    }
  }
  const tocOk = toc.length > 0;
  r.stage('toc', tocOk, {
    fatal: true,
    message: !tocOk
      ? `目录规则解不出章节${tocErr ? `：${tocErr}` : ''}`
      : tocFallback
        ? '书源 tocUrl 指向的页面解不出章节，已回退详情页（可能只覆盖部分章节）'
        : '',
    tocUrl,
    fallback: tocFallback,
    count: toc.length,
    first: toc.length ? toc[0].name : '',
    last: toc.length ? toc[toc.length - 1].name : '',
    error: tocErr,
  }, 1);
  r.details.toc = { url: tocUrl, count: toc.length, fallback: tocFallback };
  if (!tocOk) {
    r.errors.push(`目录为空或解析失败 → 不允许添加`);
    r.elapsed = Date.now() - t0;
    return r;
  }
  if (tocFallback) r.warnings.push(r.stages.toc.message);
  log(`  ✓ 目录 ${toc.length} 章（${toc[0].name} … ${toc[toc.length - 1].name}）${tocFallback ? ' [回退详情页]' : ''}`);

  /* ---- 5. 正文规则（可选） ---- */
  if (o.checkContent) {
    const samples = toc.slice(0, Math.max(1, o.contentSamples));
    let best = 0;
    let contentErr = '';
    let title = '';
    for (let i = 0; i < samples.length; i++) {
      const ch = samples[i];
      const next = toc[i + 1];
      try {
        const res = await withTimeout(
          engine.content(ch.url, next ? { nextChapterUrl: next.url } : {}),
          o.stageTimeout,
          '正文规则'
        );
        const len = res && res.text ? res.text.length : 0;
        if (len > best) {
          best = len;
          title = `${ch.name}（${res.pageCount} 页）`;
        }
        if (best >= 200) break;
      } catch (e) {
        contentErr = e.message || String(e);
      }
    }
    const contentOk = best >= 50;
    r.stage('content', contentOk, {
      fatal: false,
      message: contentOk ? '' : `正文为空或过短（${best} 字）${contentErr ? `：${contentErr}` : ''}`,
      chars: best,
      title,
      error: contentErr,
    }, 1);
    r.details.content = { chars: best, title };
    if (contentOk) log(`  ✓ 正文 ${best} 字`);
    else log(`  ✗ 正文仅 ${best} 字 ${contentErr}`);
  }

  /* ---- 6. 运行时诊断（unsupported API） ---- */
  const diag = engine.lastDiagnostics || { unsupported: [], errors: [] };
  const unsup = [...new Set(diag.unsupported || [])];
  r.details.diagnostics = { unsupported: unsup, errors: (diag.errors || []).slice(0, 10) };
  if (unsup.length) {
    r.stage('diagnostics', false, {
      fatal: false,
      message: `使用了本引擎不支持的 API：${unsup.join(', ')}（相关字段可能为空）`,
      unsupported: unsup,
    }, 0);
    log(`  ⚠ 不支持的 API: ${unsup.join(', ')}`);
  }

  /* ---- 评分 ---- */
  // 硬门槛：reach + toc 必须过（已在上面提前 return）；list 必须过
  // 软分：search/explore、bookInfo、content 按 1 分计
  let got = 1; // reach
  let total = 1;
  for (const s of ['search', 'explore', 'bookInfo', 'toc', 'content']) {
    const st = r.stages[s];
    if (!st || st.skipped) continue;
    total += 1;
    if (st.ok) got += 1;
  }
  // diagnostics 的扣分：每个未支持 API 扣 0.5，最多扣 3
  let penalty = Math.min(unsup.length * 0.5, 3);
  // 正文过短也轻扣（已由 content 阶段计过，这里只补极端情况）
  let score = ((got - penalty) / total) * 100;
  score = Math.max(0, Math.min(100, Math.round(score)));

  r.ok = true;
  r.score = score;
  r.elapsed = Date.now() - t0;
  return r;
}

/**
 * 判断探测结果是否允许添加。
 * 规则：硬阶段（reach / list / toc）必须通过。
 * @param {ProbeResult} res
 * @returns {{allowed:boolean, reason:string}}
 */
function canAdd(res) {
  if (!res) return { allowed: false, reason: '未探测' };
  if (!res.stages.reach || !res.stages.reach.ok) {
    return { allowed: false, reason: '站点无法访问' };
  }
  const listOk = (res.stages.search && res.stages.search.ok) || (res.stages.explore && res.stages.explore.ok);
  if (!listOk) return { allowed: false, reason: '无法取回书籍列表（搜索/发现规则不可用）' };
  if (!res.stages.toc || !res.stages.toc.ok) return { allowed: false, reason: '目录无法解析' };
  return { allowed: true, reason: '' };
}

module.exports = { probe, canAdd, ProbeResult, withTimeout, DEFAULTS, STAGES };
