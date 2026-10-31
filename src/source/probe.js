'use strict';
/**
 * 书源可读性探测（交付点 ③ 的核心校验）。
 *
 * 需求原文：「自定义书源是能够解析是否读取网站，不能读取的网站不能添加」
 *
 * 分 5 个阶段递进验证，任一致命阶段失败即判定「不可添加」：
 *
 *   1. `reach`     站点可达性     — baseUrl 能连上、不是 404/502、不是 DNS 失败
 *                                   （多变体回退：http/https 互换、www 增减；瞬时网络错误重试）
 *   2. `search`    搜索规则可用   — searchUrl 能取回内容（或 ruleExplore 至少一条能取回）
 *                                   （关键词池逐词回退：默认词搜不到就换词）
 *   3. `bookInfo`  详情规则可用   — 用搜索到的候选书验证书名/作者能解出
 *   4. `toc`       目录规则可用   — 能解出 >=1 章（前 N 本候选逐个试，任一通过即可）
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

/**
 * 探测关键词池。
 *
 * 为什么需要池：单一关键词是探测误杀的大头 —— 「剑」在不少站上恰好无结果
 * （书库小 / 该字被过滤 / 搜索接口对单字不生效），但换成两字词就能搜到。
 * 探测与真实使用无关，这里只求「找出一条能走的路」，所以逐词回退，
 * 任一词命中即停；显式传入的 keyword 排在队首。
 */
const KEYWORD_POOL = [
  '剑',       // 单字，覆盖绝大多数站
  '我',       // 单字备用
  '斗破苍穹', // 4 字：不少站要求关键词 ≥4 字（如七步阁、手机小说），短词直接被拒
  '凡人修仙传', // 5 字备用
  '斗罗大陆',
];

const DEFAULTS = {
  /** 探测用的关键词（显式指定时排在关键词池最前） */
  keyword: '剑',
  /** 搜索阶段最多尝试的关键词个数（含显式 keyword），1 = 只用显式词 */
  maxKeywordTries: 5,
  /** 目录/详情验证的候选书个数（列表前 N 本逐个试，任一通过即可） */
  tocCandidates: 3,
  /** 单阶段超时（毫秒） */
  stageTimeout: 30000,
  /** 是否继续验证正文（较慢） */
  checkContent: true,
  /** 只验证前 N 章正文 */
  contentSamples: 1,
  logger: null,
};

/** 瞬时网络错误（值得重试一次的那种） */
function isTransient(e) {
  const msg = String((e && e.message) || e || '');
  return /超时|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|socket hang up|network|fetch failed/i.test(msg);
}

/** 从 bookSourceUrl 提取干净的 http(s) 地址：在线源常见「https://xxx.com（作者备注）」
 * 这类带中文尾巴的写法，直接当 baseUrl 会 DNS 失败（真实用例 8019 爱丽丝书屋）。 */
function cleanSourceUrl(u) {
  const s = String(u || '').trim();
  const m = /^https?:\/\/[^\s\uFF08\uFF09\u3010\u3011\uFF3B\uFF3D\uFF0C\uFF0E|\uFF5C\uFF03#]+/i.exec(s);
  return m ? m[0] : s;
}

/** 站点可达性的候选地址：原样 → http/https 互换 → www 增减（最多 4 个，去重） */function reachVariants(rawUrl) {
  const urls = [];
  const push = (u) => {
    if (!u) return;
    const v = String(u).trim().replace(/\/+$/, '') + '/';
    if (!urls.includes(v)) urls.push(v);
  };
  push(rawUrl);
  if (/^https:\/\//i.test(rawUrl)) push(rawUrl.replace(/^https:\/\//i, 'http://'));
  else if (/^http:\/\//i.test(rawUrl)) push(rawUrl.replace(/^http:\/\//i, 'https://'));
  const m = rawUrl.match(/^(https?:\/\/)(?:www\.)?(.+)$/i);
  if (m) {
    push(m[1] + m[2]);           // 去 www
    push(m[1] + 'www.' + m[2]);  // 加 www
  }
  return urls.slice(0, 4);
}

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
  const rawUrl = cleanSourceUrl(String(source.bookSourceUrl || '').trim());
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

  log(`探测 ${name} — ${rawUrl}`);

  /* ---- 1. 站点可达性（多变体 + 瞬时错误重试） ---- */
  let reachUrl = rawUrl.replace(/\/+$/, '') + '/';
  let reachOk = false;
  let reachStatus = 0;
  let reachLen = 0;
  let reachErr = '';
  const reachTried = [];
  for (const candidate of reachVariants(rawUrl)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await withTimeout(http.get(candidate, { jar, timeout: 20000 }), o.stageTimeout, '站点可达性');
        reachStatus = res.status;
        reachLen = res.text ? res.text.length : 0;
        // 放宽判活：2xx/3xx 即使空 body 也算活（API 型书源如长佩 webapi.gongzicp.com
        // 根路径就是 200 空 body）；403 但有正文是反爬拦截，站点也活着 —— 都不在这里
        // 判死，交给后面的搜索阶段裁决（搜索能出书就说明真的能读）。
        const alive = (res.status >= 200 && res.status < 400) || (res.status === 403 && reachLen > 0);
        reachTried.push({ url: candidate, status: reachStatus, ok: alive });
        if (alive) {
          reachOk = true;
          reachUrl = candidate;
          break;
        }
        reachErr = `HTTP ${res.status}，返回 ${reachLen} 字节`;
        break; // 干净的非命中响应（404/500 等）重试也没用，只有异常才值得换一次重试
      } catch (e) {
        reachErr = e.message || String(e);
        reachTried.push({ url: candidate, error: reachErr });
        if (!isTransient(e)) break; // DNS 不存在 / 协议错误等换地址也没用
      }
    }
    if (reachOk) break;
  }
  r.stage('reach', reachOk, {
    fatal: true,
    message: reachOk ? '' : `站点无法访问：${reachErr}`,
    url: reachUrl,
    status: reachStatus,
    length: reachLen,
    error: reachErr,
    tried: reachTried,
  }, 1);
  r.details.reach = { url: reachUrl, status: reachStatus, length: reachLen, tried: reachTried };
  if (!reachOk) {
    // 不提前判死：根路径失败可能只是空 body / 反爬 / 根路径 404，而搜索接口完全可用。
    // 继续走搜索阶段，由「能否取回书籍列表」做最终裁决。
    log(`  ✗ 站点可达性未通过（${reachErr}），继续尝试搜索/发现规则…`);
  } else {
    log(`  ✓ 可达 HTTP ${reachStatus}，${reachLen} 字节（${reachUrl}）`);
  }

  /* ---- baseUrl 归一：可达地址若与书源声明不同，后续规则都按可达地址补全相对路径 ---- */
  const reachBase = reachUrl.replace(/\/+$/, '');
  const declaredBase = rawUrl.replace(/\/+$/, '');
  const engineSource =
    reachBase.toLowerCase() === declaredBase.toLowerCase()
      ? source
      : { ...source, bookSourceUrl: reachBase };
  const engine = new SourceEngine(engineSource, {
    jar,
    logger: o.logger,
    httpOptions: { timeout: Math.min(o.stageTimeout, 25000) },
  });

  /* ---- 2. 搜索规则（关键词池逐词回退） ---- */
  const hasSearch = !!(source.searchUrl && String(source.searchUrl).trim());
  const exploreRules = Array.isArray(source.ruleExplore) ? source.ruleExplore : [];
  const kwQueue = [];
  const pushKw = (w) => {
    const k = String(w || '').trim();
    if (k && !kwQueue.includes(k)) kwQueue.push(k);
  };
  pushKw(o.keyword);
  if (kwQueue.length < o.maxKeywordTries) {
    for (const k of KEYWORD_POOL) {
      pushKw(k);
      if (kwQueue.length >= o.maxKeywordTries) break;
    }
  }
  let searchItems = [];
  let searchErr = '';
  let searchKeyword = '';
  const searchTried = [];
  if (hasSearch) {
    for (const kw of kwQueue) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const items = (await withTimeout(engine.search(kw, 1), o.stageTimeout, '搜索规则')) || [];
          searchTried.push({ keyword: kw, count: items.length });
          if (items.length) {
            searchItems = items;
            searchKeyword = kw;
            break;
          }
          searchErr = `搜索「${kw}」无结果`;
          break; // 干净的 0 结果是确定性的，不重试；换下一个关键词
        } catch (e) {
          searchErr = `${kw}: ${e.message || String(e)}`;
          searchTried.push({ keyword: kw, error: searchErr });
          if (!isTransient(e)) break;
        }
      }
      if (searchItems.length) break;
    }
  }
  const searchOk = searchItems.length > 0;
  if (hasSearch) {
    r.stage('search', searchOk, {
      fatal: false,
      message: searchOk ? '' : `${searchErr}（共试过 ${searchTried.length} 个词）`,
      keyword: searchKeyword || o.keyword,
      count: searchItems.length,
      tried: searchTried,
      error: searchOk ? '' : searchErr,
    }, 1);
  } else {
    r.stage('search', false, {
      fatal: false,
      message: '书源未声明 searchUrl（仅支持发现/explore）',
      skipped: true,
      count: 0,
    }, 0);
  }
  if (searchOk) log(`  ✓ 搜索「${searchKeyword}」命中 ${searchItems.length} 条`);
  else if (hasSearch) log(`  ✗ 搜索无结果（${searchTried.length} 个词都空）${searchErr}`);

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
  if (!reachOk) {
    if (listOk) {
      // 搜索/发现能用 → 站点事实上可达，覆盖可达性判定
      reachOk = true;
      r.stages.reach.ok = true;
      r.stages.reach.message = `根路径不可达（${reachErr}），但搜索/发现可用，按可达处理`;
      r.warnings.push(r.stages.reach.message);
      log(`  ✓ 搜索/发现可用，覆盖可达性判定`);
    } else {
      r.errors.push(`站点无法访问（${reachErr}）→ 不允许添加`);
      r.score = 25;
      r.elapsed = Date.now() - t0;
      return r;
    }
  }
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

  /* ---- 3+4. 详情与目录（候选书逐个试，前 N 本任一通过即可） ----
   * 为什么要多本：列表第一本可能恰好是「详情页改版了 / 正文锁 VIP / 偶发 5xx」的坏样本，
   * 只验第一本会误杀整站可用的书源。这里取列表前 tocCandidates 本逐个走
   * 「详情 → 目录」，目录解出即停；书名/作者取第一个成功的详情。
   */
  const items = searchOk ? searchItems : exploreItems;
  const candidates = items.filter((it) => it && it.bookUrl).slice(0, Math.max(1, o.tocCandidates));
  if (!candidates.length) {
    r.errors.push('列表结果缺少 bookUrl，无法继续验证详情/目录规则 → 不允许添加');
    r.score = 35;
    r.elapsed = Date.now() - t0;
    return r;
  }

  const tryToc = async (u) => {
    try {
      const res = await withTimeout(engine.toc(u), o.stageTimeout, '目录规则');
      return { list: Array.isArray(res) ? res : [], err: '' };
    } catch (e) {
      return { list: [], err: e.message || String(e) };
    }
  };

  let info = null;          // 第一个成功的详情
  let infoErrs = [];        // 每本候选的详情失败原因
  let toc = [];
  let tocErr = '';
  let tocUrl = '';
  let tocFallback = false;
  let tocBookIdx = -1;      // 目录来自第几个候选

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];

    /* 详情规则 */
    let ci = null;
    let cie = '';
    try {
      ci = await withTimeout(engine.bookInfo(cand.bookUrl), o.stageTimeout, '详情规则');
    } catch (e) {
      cie = e.message || String(e);
    }
    const ciOk = !!(ci && (ci.name || ci.author));
    if (ciOk && !info) info = ci;
    else if (!ciOk) infoErrs.push(cie || '解不出书名/作者');

    /* 目录规则：先按书源给的 tocUrl 试，失败再回退详情页 bookUrl。
     * 回退是必要的：不少书源的 tocUrl 指向「分页目录页」，而 chapterList 规则
     * 实际只对详情页生效。只要其中任一路径能解出章节，就说明该站点「读得出来」。 */
    const tocUrls = [];
    if (ci && ci.tocUrl) tocUrls.push(ci.tocUrl);
    if (cand.bookUrl && !tocUrls.includes(cand.bookUrl)) tocUrls.push(cand.bookUrl);
    for (const tu of tocUrls) {
      const r1 = await tryToc(tu);
      if (r1.list.length) {
        toc = r1.list;
        tocUrl = tu;
        tocFallback = !!(ci && ci.tocUrl && ci.tocUrl !== tu);
        tocErr = '';
        tocBookIdx = i;
        break;
      }
      if (r1.err) tocErr = r1.err;
      else if (tocUrls.length > 1) tocErr = `${tu} 解出 0 章`;
    }
    if (toc.length) break;
    log(`  · 第 ${i + 1} 本候选《${(ci && ci.name) || cand.name || ''}》解不出目录，换下一本${i + 1 < candidates.length ? '' : '（已试完）'}`);
  }

  const infoOk = !!info;
  r.stage('bookInfo', infoOk, {
    fatal: false,
    message: infoOk ? '' : `详情规则解不出书名/作者（试了 ${candidates.length} 本：${infoErrs.join('；').slice(0, 200) || '无响应'}）`,
    bookUrl: candidates[0].bookUrl,
    name: info ? info.name : '',
    author: info ? info.author : '',
    error: infoOk ? '' : infoErrs.join('; ').slice(0, 300),
    tried: candidates.length,
  }, 1);
  r.details.book = candidates[tocBookIdx >= 0 ? tocBookIdx : 0];
  if (infoOk) log(`  ✓ 详情《${info.name}》/ ${info.author || '无作者'}`);
  else log(`  ✗ 详情失败（${candidates.length} 本都没解出）`);

  const tocOk = toc.length > 0;
  r.stage('toc', tocOk, {
    fatal: true,
    message: !tocOk
      ? `目录规则解不出章节（试了 ${candidates.length} 本候选）${tocErr ? `：${tocErr}` : ''}`
      : tocFallback
        ? '书源 tocUrl 指向的页面解不出章节，已回退详情页（可能只覆盖部分章节）'
        : '',
    tocUrl,
    fallback: tocFallback,
    count: toc.length,
    bookIndex: tocBookIdx,
    first: toc.length ? toc[0].name : '',
    last: toc.length ? toc[toc.length - 1].name : '',
    error: tocOk ? '' : tocErr,
  }, 1);
  r.details.toc = { url: tocUrl, count: toc.length, fallback: tocFallback, bookIndex: tocBookIdx };
  if (!tocOk) {
    r.errors.push(`目录为空或解析失败 → 不允许添加`);
    r.elapsed = Date.now() - t0;
    return r;
  }
  if (tocFallback) r.warnings.push(r.stages.toc.message);
  log(`  ✓ 目录 ${toc.length} 章（${toc[0].name} … ${toc[toc.length - 1].name}）${tocFallback ? ' [回退详情页]' : ''}${tocBookIdx > 0 ? ` [第 ${tocBookIdx + 1} 本候选]` : ''}`);

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

module.exports = { probe, canAdd, ProbeResult, withTimeout, DEFAULTS, STAGES, cleanSourceUrl };
