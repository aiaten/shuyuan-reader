'use strict';
/**
 * yck 系在线书源/订阅源库（yck2026.fun 书源 + yckceo.com 订阅源）。
 *
 * 站点结构（2026-01 实测）：
 *  - 书源列表：`https://www.yck2026.fun/yuedu/shuyuan/index.html?page=N&keys=关键词&order1=time|down`
 *  - 书源详情：`/yuedu/shuyuan/content/id/<id>.html`
 *  - 书源 JSON：`/yuedu/shuyuan/json/id/<id>.json`（**直接返回 Legado 书源 JSON 数组**）
 *  - 书源合集：`/yuedu/shuyuans/index.html`
 *  - 订阅源列表：`https://www.yckceo.com/yuedu/rss/index.html?page=N`（结构与书源列表完全同构）
 *  - 订阅源 JSON：`/yuedu/rss/json/id/<id>.json`（返回 Legado **订阅源** JSON 数组，字段 source*）
 *
 * 列表卡片结构（div.ylist）：
 * ```html
 * <div class="ylist">
 *   <p class="checkboxclass"><input class="class_one" name="ids[]" value="7931"></p>
 *   <h2><a href="/yuedu/shuyuan/content/id/7931.html">纸间 https://www.zjread.cc</a>
 *       <p class="m-right">1分钟前</p></h2>
 *   <span class="...layui-font-black">3.X</span>
 *   <span class="...layui-font-orange">搜 </span>
 *   <span class="...layui-font-red" title="UID:15127">用户: khalil0425</span>
 *   <span class="...layui-font-purple">下载:6</span>
 * </div>
 * ```
 */

const cheerio = require('cheerio');
const http = require('../net/http');

/**
 * 两类资源的端点差异全部收敛在这里：
 *  - shuyuan：Legado 书源（bookSourceName / bookSourceUrl）
 *  - rss    ：Legado 订阅源（sourceName / sourceUrl，yckceo.com 域）
 */
const KINDS = {
  shuyuan: {
    base: 'https://www.yck2026.fun',
    listPath: '/yuedu/shuyuan/index.html',
    jsonPath: (id) => `/yuedu/shuyuan/json/id/${id}.json`,
    contentPath: (id) => `/yuedu/shuyuan/content/id/${id}.html`,
    /** JSON 数组里识别「有效对象」的字段 */
    nameField: 'bookSourceName',
    urlField: 'bookSourceUrl',
  },
  rss: {
    base: 'https://www.yckceo.com',
    listPath: '/yuedu/rss/index.html',
    jsonPath: (id) => `/yuedu/rss/json/id/${id}.json`,
    contentPath: (id) => `/yuedu/rss/content/id/${id}.html`,
    nameField: 'sourceName',
    urlField: 'sourceUrl',
  },
};

/**
 * 备用站点（镜像站）。在线书源站随时可能被墙/被 ban，所以每个 kind 都配一份
 * 「同构镜像」列表；请求时按顺序尝试，任一站点成功即返回，并记住该站点优先。
 *
 * 实测（2026-01）：`www.yckceo.com` 与 `www.yck2026.fun` 路径结构**完全同构**，
 * 同样的 `/yuedu/shuyuan/index.html`、`/yuedu/shuyuan/json/id/<id>.json`、
 * `/yuedu/rss/...` 全部可用，且书源 id 一致（同一个源仓库换了域名而已）。
 *
 * 注意 `yckceo.vip`：它是挂在 GitHub Pages 上的**「最新地址发布页」**，只有根路径 `/`
 * 返回 200，所有 `/yuedu/**` 路径都是 GitHub Pages 的 404 页。
 * 它不能作为镜像参与业务请求，只用来告诉用户「主站换域名了」。
 *   - 放进 MIRRORS 会让每次故障转移多花一次请求（且它永远失败），
 *     更糟的是当它排在末尾时，最终报错会变成误导性的「最后错误：HTTP 404」，
 *     掩盖真正的失败原因（例如前两个站点超时）。
 *   - 因此单列到 PUBLISH_PAGE，并在全部镜像失败时把它拼进错误信息里提示用户去查新域名。
 */
const MIRRORS = {
  shuyuan: [
    'https://www.yck2026.fun',
    'https://www.yckceo.com',
  ],
  rss: [
    'https://www.yckceo.com',
    'https://www.yck2026.fun',
  ],
};

/** 地址发布页（非镜像）：全部业务请求失败时，提示用户到这里查最新域名 */
const PUBLISH_PAGE = 'http://yckceo.vip';

/** 已探明可用的站点（kind -> base），进程内缓存，避免每次请求都重新试探 */
const _liveBase = Object.create(null);

/** 某 kind 的候选站点列表（主站优先；已探明的站点提到最前） */
function candidateBases(kind) {
  const all = MIRRORS[kind] || MIRRORS.shuyuan;
  const live = _liveBase[kind];
  if (live && all.includes(live)) return [live, ...all.filter((b) => b !== live)];
  return all.slice();
}

/** 记录/查询当前可用站点（供界面显示「当前线路」） */
function activeBase(kind) {
  return _liveBase[kind || 'shuyuan'] || (MIRRORS[kind || 'shuyuan'] || MIRRORS.shuyuan)[0];
}

function setActiveBase(kind, base) {
  _liveBase[kind || 'shuyuan'] = base;
}

/** 清空线路缓存（测试用；界面「重试」时也可调用以强制重新探测） */
function resetBaseCache() {
  for (const k of Object.keys(_liveBase)) delete _liveBase[k];
}

/**
 * 依次尝试候选站点发请求，返回第一个「HTTP 200 且通过校验」的结果。
 * 校验函数返回 falsy 视为该站点不可用，继续试下一个（避免镜像站返回空页被当成成功）。
 *
 * @param {'shuyuan'|'rss'} kind
 * @param {(base:string)=>string} urlOf 由 base 生成完整 URL
 * @param {object} [opts] { headers, timeout, validate:(res)=>boolean, onError:(base,err)=>void }
 * @returns {Promise<{res:object, base:string, tried:string[]}>}
 */
async function fetchWithFailover(kind, urlOf, opts = {}) {
  const bases = candidateBases(kind);
  const tried = [];
  let lastErr = null;
  // 单轮里每个站点都试一遍；全挂时再给一次机会（多为瞬时超时/连接被掐），
  // 仍然全挂才报错。站点本身很快（失败一般 <1s），重试一次不至于让用户等太久。
  const rounds = opts.rounds || 2;
  for (let round = 0; round < rounds; round++) {
    for (const base of bases) {
      const url = urlOf(base);
      if (round === 0) tried.push(base);
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await http.get(url, {
          timeout: opts.timeout || 20000,
          headers: { Referer: `${base}${KINDS[kind] ? KINDS[kind].listPath : '/yuedu/shuyuan/index.html'}`, ...(opts.headers || {}) },
        });
        if (res.status !== 200) {
          lastErr = new Error(`HTTP ${res.status}`);
          if (opts.onError) opts.onError(base, lastErr);
          continue;
        }
        if (opts.validate && !opts.validate(res)) {
          lastErr = new Error('响应内容校验失败（可能被墙/跳转到错误页）');
          if (opts.onError) opts.onError(base, lastErr);
          continue;
        }
        setActiveBase(kind, base);
        return { res, base, tried };
      } catch (e) {
        lastErr = e;
        if (opts.onError) opts.onError(base, e);
      }
    }
  }
  const err = new Error(
    `所有线路均不可用（已尝试 ${tried.length} 个站点：${tried.join('、')}）` +
    (lastErr ? `；最后错误：${lastErr.message}` : '') +
    `。可到地址发布页 ${PUBLISH_PAGE} 查看最新域名`
  );
  err.tried = tried;
  err.cause = lastErr;
  err.publishPage = PUBLISH_PAGE;
  throw err;
}

const BASE = KINDS.shuyuan.base;
const LIST_URL = `${BASE}${KINDS.shuyuan.listPath}`;
const JSON_URL = (id) => `${BASE}${KINDS.shuyuan.jsonPath(id)}`;

/** 列表页可用性校验：必须能解析出 div.ylist 卡片 */
function looksLikeList(res) {
  const t = String(res.text || '');
  return t.includes('ylist') || t.includes('content/id/');
}

/**
 * 列表页短缓存：站点单页响应 2.5–10s，而界面里翻页/切排序/返回上一页都会重复拉同一页。
 * TTL 很短（默认 60s），只用来消掉「来回点」的重复请求，不牺牲新鲜度。
 * 键 = kind + 完整 query，所以不同页码/排序/关键词互不干扰。
 */
const LIST_TTL = 60e3;
const _listCache = new Map();

function cacheGet(key) {
  const hit = _listCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > (hit.ttl || LIST_TTL)) {
    _listCache.delete(key);
    return null;
  }
  return hit.val;
}

function cacheSet(key, val, ttl) {
  // 只留最近 32 条，避免长期运行把内存撑起来
  if (_listCache.size > 32) {
    const oldest = [..._listCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _listCache.delete(oldest[0]);
  }
  _listCache.set(key, { at: Date.now(), val, ttl: ttl || LIST_TTL });
}

/** 清空列表缓存（测试 / 界面「刷新」用） */
function resetListCache() {
  _listCache.clear();
}

/** JSON 端点校验：必须是能 parse 的 JSON */
function looksLikeJson(res) {
  try {
    JSON.parse(String(res.text || ''));
    return true;
  } catch (_) {
    return false;
  }
}

function kindOf(kind) {
  const k = KINDS[kind || 'shuyuan'];
  if (!k) throw new Error(`未知资源类型：${kind}（可选 shuyuan|rss）`);
  return k;
}

/** 中文相对时间 → 大致的时间戳（站点只给「1分钟前」这类文本） */
/**
 * 解析列表页上的「更新时间」文本为时间戳。
 *
 * 站点实际会给出两种形态（实测 100 条样本）：
 *   1. 相对时间：「刚刚」「1分钟前」「49分钟前」「2小时前」「12小时前」「3天前」「7天前」
 *   2. 绝对时间：「10/03 10:12」「09/30 18:48」（月/日 时:分，**不带年份**）
 *
 * 无法识别时返回 null（而不是 now），避免把不认识的文本错误地当成「刚刚更新」。
 * 绝对时间按「当年」解析；若算出来的时间比现在晚 2 天以上，说明跨年了，往前推一年。
 */
function parseAgo(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;

  if (s === '刚刚') return Date.now();

  const rel = s.match(/^(\d+)\s*(分钟|小时|个月|天|秒|月)前$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2] === '个月' ? '月' : rel[2];
    const mult = { 秒: 1000, 分钟: 60e3, 小时: 3600e3, 天: 86400e3, 月: 30 * 86400e3 }[unit] || 0;
    return Date.now() - n * mult;
  }

  // 绝对时间：MM/DD HH:MM（也接受 YYYY/MM/DD HH:MM）
  const abs = s.match(/^(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (abs) {
    const now = new Date();
    const year = abs[1] ? parseInt(abs[1], 10) : now.getFullYear();
    const month = parseInt(abs[2], 10) - 1;
    const day = parseInt(abs[3], 10);
    const hour = abs[4] ? parseInt(abs[4], 10) : 0;
    const min = abs[5] ? parseInt(abs[5], 10) : 0;
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    let t = new Date(year, month, day, hour, min).getTime();
    if (!abs[1] && t - now > 2 * 86400e3) {
      // 无年份且「未来」超过 2 天 → 是去年的日期
      t = new Date(year - 1, month, day, hour, min).getTime();
    }
    return t;
  }

  return null;
}

/**
 * 解析列表页。
 * @param {string} html 列表页 HTML（null/undefined 视为空页面）
 * @param {object} [opts] { kind: 'shuyuan'|'rss' }
 * @returns {{items: Array, page: number, totalPages: number, total: number}}
 */
function parseList(html, opts = {}) {
  const k = kindOf(opts.kind);
  const $ = cheerio.load(String(html == null ? '' : html));
  const items = [];
  $('div.ylist').each((_i, el) => {
    const $el = $(el);
    const $a = $el.find('h2 a').first();
    const href = $a.attr('href') || '';
    const mid = href.match(/content\/id\/(\d+)\.html/);
    if (!mid) return;
    const id = parseInt(mid[1], 10);

    // 链接文本形如 `纸间 https://www.zjread.cc`
    const rawTitle = $a.text().trim();
    const um = rawTitle.match(/^(.*?)\s+(https?:\/\/\S+|data:[^\s]*)\s*$/);
    const name = um ? um[1].trim() : rawTitle;
    const url = um ? um[2].trim() : '';
    if (!name) return;

    const badges = [];
    $el.find('span.layui-badge-rim').each((_j, s) => {
      const t = $(s).text().trim();
      if (t) badges.push(t);
    });

    let group = '';
    const tags = [];
    let author = '';
    let downloads = 0;
    for (const b of badges) {
      const dm = b.match(/^下载[:：]\s*(\d+)/);
      if (dm) { downloads = parseInt(dm[1], 10); continue; }
      const am = b.match(/^(?:用户|作者)[:：]\s*(.+)$/);
      if (am) { author = am[1].trim(); continue; }
      if (/^3\.\d|^\d+X$/i.test(b)) { group = b; continue; }
      // 「发 搜 图 声」这类能力标签可能在一个 span 里连着写
      for (const t of b.split(/\s+/)) if (t) tags.push(t);
    }

    items.push({
      id,
      kind: opts.kind === 'rss' ? 'rss' : 'shuyuan',
      name,
      url,
      author,
      downloads,
      group,
      tags,
      updatedAt: parseAgo($el.find('h2 p.m-right').first().text()),
      updatedText: $el.find('h2 p.m-right').first().text().trim(),
      detailUrl: `${k.base}${href}`,
      jsonUrl: `${k.base}${k.jsonPath(id)}`,
      hasExplore: tags.includes('发'),
      hasSearch: tags.includes('搜'),
      hasImage: tags.includes('图'),
      hasAudio: tags.includes('声'),
    });
  });

  // 分页：/yuedu/shuyuan/index.html?page=57
  let totalPages = 1;
  $('a').each((_i, el) => {
    const h = $(el).attr('href') || '';
    const m = h.match(/[?&]page=(\d+)/);
    if (m) totalPages = Math.max(totalPages, parseInt(m[1], 10));
  });

  return { items, page: 1, totalPages, total: items.length };
}

/**
 * 拉取列表（可翻页 / 搜索 / 排序）。
 * 自动在多个镜像站点间故障转移；返回里带 `base` 供界面显示当前线路。
 * @param {object} [opts] { page, keys, order1: 'time'|'down', order2: 1|2, kind: 'shuyuan'|'rss', cache: false 强制不走缓存 }
 */
async function list(opts = {}) {
  const k = kindOf(opts.kind);
  const q = [];
  if (opts.page && opts.page > 1) q.push(`page=${opts.page}`);
  if (opts.keys) q.push(`keys=${encodeURIComponent(opts.keys)}`);
  if (opts.order1) q.push(`order1=${encodeURIComponent(opts.order1)}`);
  if (opts.order2) q.push(`order2=${encodeURIComponent(opts.order2)}`);
  const qs = q.length ? `?${q.join('&')}` : '';
  const ck = `${opts.kind || 'shuyuan'}|${qs}`;
  if (opts.cache !== false) {
    const hit = cacheGet(ck);
    // 命中缓存直接返回，省掉 2.5–10s 的网络往返
    if (hit) return { ...hit, cached: true };
  }
  const { res, base, tried } = await fetchWithFailover(
    opts.kind || 'shuyuan',
    (b) => `${b}${k.listPath}${qs}`,
    { validate: looksLikeList, onError: opts.onError }
  );
  const parsed = parseList(res.text, { kind: opts.kind });
  parsed.page = opts.page || 1;
  parsed.url = `${base}${k.listPath}${qs}`;
  parsed.base = base;
  parsed.tried = tried;
  if (opts.cache !== false) cacheSet(ck, parsed, opts.ttl);
  return parsed;
}

/** 订阅源列表（yckceo.com /yuedu/rss/）。参数同 list()。 */
function listRss(opts = {}) {
  return list({ ...opts, kind: 'rss' });
}

/**
 * 下载单个书源/订阅源的 JSON（返回数组）。
 * 自动在多个镜像站点间故障转移。
 * @param {number|string} id
 * @param {object} [opts] { kind: 'shuyuan'|'rss' }
 * @returns {Promise<Array<object>>}
 */
async function download(id, opts = {}) {
  const k = kindOf(opts.kind);
  const { res } = await fetchWithFailover(
    opts.kind || 'shuyuan',
    (b) => `${b}${k.jsonPath(id)}`,
    {
      headers: { Accept: 'application/json,*/*' },
      validate: looksLikeJson,
      onError: opts.onError,
    }
  );
  let data;
  try {
    data = JSON.parse(res.text);
  } catch (e) {
    throw new Error(`资源 ${id} 返回的不是合法 JSON：${e.message}`);
  }
  const arr = Array.isArray(data) ? data : [data];
  const valid = arr.filter(
    (s) => s && typeof s === 'object' && (s[k.nameField] || s[k.urlField])
  );
  if (!valid.length) throw new Error(`资源 ${id} JSON 里没有有效的对象`);
  return valid;
}

/** 下载订阅源 JSON（/yuedu/rss/json/id/<id>.json）。 */
function downloadRss(id) {
  return download(id, { kind: 'rss' });
}

/**
 * 同步「最近更新」：拉取某类资源第 1..N 页，返回全部条目（含 updatedAt 时间戳）。
 * 这是「更新书源」按钮的后端：先列出最近更新的条目，调用方再挑出需要重新下载安装的。
 *
 * 性能：站点单页响应 2.5–10s（纯网络），串行翻页会线性变慢。
 * 因此这里**先并发拉前若干页**，再按「整页都旧于 since」的规则截断。
 * 实测串行 3 页 11.2s → 并发 0.5s（keep-alive 连接池已预热时几乎不额外付费）。
 *
 * @param {object} [opts] { kind: 'shuyuan'|'rss', pages: 1, since: number, days, onItem }
 * @returns {Promise<{items: Array, fresh: Array, pages: number}>}
 *   fresh = updatedAt >= since 的条目（since 缺省 = 7 天前）
 */
async function syncLatest(opts = {}) {
  const maxPages = Math.max(1, Math.min(opts.pages || 10, 10));
  const days = typeof opts.days === 'number' && opts.days > 0 ? opts.days : 7;
  const since = typeof opts.since === 'number' ? opts.since : Date.now() - days * 86400e3;
  const fanout = Math.max(1, Math.min(opts.fanout || 4, maxPages));

  /** 已拿到的页结果（按页号索引），value = {items, totalPages} | {error} */
  const byPage = new Map();
  let firstError = null;
  /** 是否需要继续翻页：整页都旧于 since → 后面的页只会更旧 */
  let reachedOld = false;
  /** 站点声明的总页数（以第一页为准） */
  let totalPages = 1;

  async function pull(page) {
    try {
      const r = await list({ ...opts, page });
      byPage.set(page, r);
      for (const it of r.items) if (opts.onItem) opts.onItem(it);
      return r;
    } catch (e) {
      byPage.set(page, { error: e, items: [], totalPages: 0 });
      if (!firstError) firstError = e;
      return null;
    }
  }

  // 第 1 页单独先拉：它决定「总页数」和「是不是整页都旧了」，
  // 必须先拿到这两个结论，才能决定后面到底要并发拉几页（否则会多拉 fanout-1 页）。
  const p1 = await pull(1);
  if (p1) {
    totalPages = p1.totalPages || 1;
    reachedOld = !p1.items.some((it) => it.updatedAt && it.updatedAt >= since);
  } else if (firstError) {
    throw firstError; // 首页就失败 → 别让调用方以为「没有更新」
  }

  // 从第 2 页起并发拉：只要「还没遇到旧页」就继续。
  // 每批并发 fanout 页；批内如果有任何一页整页都旧，说明已到边界，本批之后停止
  // （本批里多拉的页不算浪费：它们本来就要被检查，且并发几乎不额外耗时）。
  let page = 2;
  while (!reachedOld && page <= maxPages && page <= totalPages) {
    const batch = [];
    for (let i = 0; i < fanout && page <= maxPages && page <= totalPages; i++) batch.push(pull(page++));
    if (!batch.length) break;
    // eslint-disable-next-line no-await-in-loop
    const rs = await Promise.all(batch);
    // 只让「最新的那页」的结论生效：一旦某页整页都旧，更后面的页只会更旧
    for (const r of rs) {
      if (r && !r.items.some((it) => it.updatedAt && it.updatedAt >= since)) { reachedOld = true; break; }
    }
  }

  // 按页号顺序拼结果（保证 items 顺序稳定），跳过失败页
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const all = [];
  const fresh = [];
  let scanned = 0;
  for (const p of pages) {
    const r = byPage.get(p);
    if (!r || r.error) continue; // 单页失败不该让整个「更新」失败
    // 遇到边界页之后拿到的页不再计入（避免把多拉的页塞进结果里）
    if (reachedOld && p > 1 && !r.items.some((it) => it.updatedAt && it.updatedAt >= since)) {
      scanned = Math.max(scanned, p);
      continue;
    }
    all.push(...r.items);
    for (const it of r.items) if (it.updatedAt && it.updatedAt >= since) fresh.push(it);
    scanned = Math.max(scanned, p);
  }
  return { items: all, fresh, pages: scanned };
}

/**
 * 下载书源合集页里的全部书源（`/yuedu/shuyuans/index.html`）。
 * 合集本身也是列表，逐条走 download。
 */
async function downloadCollection(id, opts = {}) {
  const { res } = await fetchWithFailover(
    'shuyuan',
    (b) => `${b}/yuedu/shuyuans/content/id/${id}.html`,
    { validate: looksLikeList, onError: opts.onError }
  );
  const $ = cheerio.load(res.text);
  const ids = new Set();
  $('a[href*="content/id/"]').each((_i, el) => {
    const m = ($(el).attr('href') || '').match(/content\/id\/(\d+)\.html/);
    if (m) ids.add(parseInt(m[1], 10));
  });
  const out = [];
  for (const sid of ids) {
    try {
      const arr = await download(sid);
      out.push(...arr);
    } catch (e) {
      if (opts.onError) opts.onError(sid, e);
    }
  }
  return out;
}

module.exports = {
  BASE, LIST_URL, JSON_URL,
  KINDS, MIRRORS, PUBLISH_PAGE,
  list, download, downloadCollection,
  listRss, downloadRss, syncLatest,
  parseList, parseAgo,
  // 线路（镜像故障转移）
  activeBase, setActiveBase, resetBaseCache, candidateBases, fetchWithFailover,
  // 列表缓存
  resetListCache, LIST_TTL,
};
