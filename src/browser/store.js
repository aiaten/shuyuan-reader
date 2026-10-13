'use strict';
/**
 * 内置浏览器——本地存储层（书签 / 浏览历史 / 上次的标签会话）。
 *
 * 抄 src/source/store.js 的「纯 JSON 落盘」方案：免依赖、可人工检视、
 * 脏数据一律吞掉当空用（用户手改坏了文件不能让整个软件起不来）。
 *
 * ```
 * <dataDir>/browser/bookmarks.json  书签（数组）
 * <dataDir>/browser/history.json    浏览历史（数组，最近在前）
 * <dataDir>/browser/session.json    上次打开的标签（重启后还能接上）
 * ```
 *
 * 注意：这里**只存条目元数据**（标题/地址/时间），不存网页正文。
 */

const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 300; // 历史是「翻回去找」用的，留太多只是累赘
const MAX_TITLE = 200; // 页面标题超长（有的站塞满关键词）落盘前截断

/**
 * 单调递增的排序序号。
 *
 * 不能只靠 Date.now()：同一毫秒内连加两条时间戳完全相同，排序就退化成
 * 「看运气」——用户连开几个标签收藏，顺序会乱。这里用「时间戳 + 同毫秒内
 * 自增计数」保证后写的一定排在前面；历史里已有的值会喂进来续上，
 * 避免重启后序号从头开始又把老记录顶到前面。
 */
let seqCounter = 0;

/** 下一个排序号；never 小于 alreadySeen+1 */
function nextSeq(alreadySeen) {
  const seen = num(alreadySeen);
  seqCounter = Math.max(seqCounter, seen) + 1;
  return seqCounter;
}

/** 绝对时间戳，读不出返回 0（排序时自然沉底） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 归一化地址：只接受 http/https，去掉首尾空白。
 * @returns {string} 合法返回归一化后的串，否则返回 ''
 */
function normUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

/**
 * 把用户随手敲的东西补成可访问的地址：
 *   `www.qidian.com`    → `https://www.qidian.com`
 *   `起点中文网`         → 交给搜索？不，这里只做补协议，中文交回调用方
 *   空白                 → ''
 * 带协议时只放行 http/https/about，其余（javascript:/file:/data: 等）返回 ''，
 */
function normalizeInput(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  // 明确带协议时：只放行 http/https/about；javascript:/file:/data:/chrome: 等一律拒绝
  const m = s.match(/^([a-z][a-z0-9+.-]*):/i);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https' || scheme === 'about') return s;
    return '';
  }
  // 像是域名或 IP：没有空格、含点、且不是中文
  if (!/\s/.test(s) && /[.:]/.test(s) && !/[\u4e00-\u9fa5]/.test(s)) {
    return 'https://' + s.replace(/^\/+/, '');
  }
  return s;
}

/** 是否为「外部可打开」的普通网页地址（决定要不要给系统浏览器入口） */
function isHttpUrl(u) {
  return !!normUrl(u);
}

/** 地址唯一键：去尾斜杠 + 小写，`https://a.com` 与 `https://a.com/` 视为同一个 */
function urlKey(u) {
  const s = normUrl(u).toLowerCase();
  return s.replace(/\/+$/, '');
}

/** 标题清洗：换行压平、超长截断 */
function cleanTitle(t) {
  const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE) : s;
}

/** 默认标题：站点名 / 主机名，标题还没拿到时先用它顶着 */
function fallbackTitle(u) {
  const s = normUrl(u);
  if (!s) return '新标签页';
  try {
    return new URL(s).hostname.replace(/^www\./, '') || s;
  } catch (_) {
    return s;
  }
}

/** 一个 JSON 数组文件的读写小工具（三个文件共用，避免三份重复代码） */
class JsonList {
  constructor(file) {
    this.file = file;
    this.dir = path.dirname(file);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 读；文件不存在/不是合法 JSON/顶层不是数组 → 一律返回 [] */
  read() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : [];
    } catch (_) {
      return [];
    }
  }

  /** 原子写：先写 .tmp 再 rename，中途断电不会留下半个文件 */
  write(list) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    return list;
  }
}

/**
 * 浏览器的持久化存储。
 *
 * 与 src/source/store.js 一样是纯 Node（不 require electron），
 * 所以可以直接在 test/unit-browser.js 里单测。
 */
class BrowserStore {
  /**
   * @param {string} dataDir 数据根目录（与 App 的 dataDir 同一个）
   */
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'browser');
    this.bookmarkFile = new JsonList(path.join(this.dir, 'bookmarks.json'));
    this.historyFile = new JsonList(path.join(this.dir, 'history.json'));
    this.sessionFile = new JsonList(path.join(this.dir, 'session.json'));
  }

  /* ---------------- 书签 ---------------- */

  /**
   * 内部读：带排序号 seq 的原始行（给排序/去重/续号用）。
   * seq 是存储实现细节，不往渲染进程透，见下面 bookmarks()。
   */
  _bookmarkRows() {
    return this.bookmarkFile
      .read()
      .map((b) => {
        const url = normUrl(b.url);
        return {
          url,
          // 老版本/手改的条目可能没有 title，读的时候用主机名补上，
          // 界面上不会出现一排空白按钮
          title: cleanTitle(b.title) || fallbackTitle(url),
          site: String(b.site || '').trim(),
          addedAt: num(b.addedAt),
          seq: num(b.seq),
        };
      })
      .filter((b) => b.url)
      // 同毫秒按 seq 兜底，保证「后加的在前」永远成立
      .sort((a, b) => b.addedAt - a.addedAt || b.seq - a.seq);
  }

  /** 全部书签（按加入时间倒序，最近加的在前）；对外只有 4 个字段 */
  bookmarks() {
    return this._bookmarkRows().map(({ url, title, site, addedAt }) => ({ url, title, site, addedAt }));
  }

  /** 该书签是否已存在（按去掉尾斜杠的地址比） */
  hasBookmark(url) {
    const k = urlKey(url);
    if (!k) return false;
    return this.bookmarks().some((b) => urlKey(b.url) === k);
  }

  /**
   * 加书签。同一个地址重复加视为「已收藏」，不重复入库。
   * @returns {{added:boolean, bookmark?:object, reason?:string}}
   */
  addBookmark(raw) {
    const { url, title, site } = raw && typeof raw === 'object' ? raw : {};
    const u = normUrl(url);
    if (!u) return { added: false, reason: '只能收藏 http/https 地址' };
    const list = this._bookmarkRows();
    const k = urlKey(u);
    const old = list.find((b) => urlKey(b.url) === k);
    if (old) {
      const { url: ou, title: ot, site: os, addedAt } = old;
      return { added: false, reason: '该页面已在书签里', bookmark: { url: ou, title: ot, site: os, addedAt } };
    }
    const row = {
      url: u,
      title: cleanTitle(title) || fallbackTitle(u),
      site: String(site || '').trim(),
      addedAt: Date.now(),
      seq: nextSeq(list.reduce((m, b) => Math.max(m, num(b.seq)), 0)),
    };
    list.push(row);
    this.bookmarkFile.write(list);
    const { url: bu, title: bt, site: bs, addedAt: bat } = row;
    return { added: true, bookmark: { url: bu, title: bt, site: bs, addedAt: bat } };
  }

  /**
   * 改书签标题（用户手动重命名）。空标题视为无效，保持原样。
   * @returns {boolean} 是否改到了
   */
  renameBookmark(url, title) {
    const k = urlKey(url);
    const t = cleanTitle(title);
    if (!k || !t) return false;
    const list = this.bookmarkFile.read();
    let hit = false;
    for (const b of list) {
      if (urlKey(b.url) === k) {
        b.title = t;
        hit = true;
      }
    }
    if (hit) this.bookmarkFile.write(list);
    return hit;
  }

  /** 删书签；地址对不上返回 false */
  removeBookmark(url) {
    const k = urlKey(url);
    if (!k) return false;
    const list = this.bookmarkFile.read();
    const next = list.filter((b) => urlKey(b.url) !== k);
    if (next.length === list.length) return false;
    this.bookmarkFile.write(next);
    return true;
  }

  /** 清空书签 */
  clearBookmarks() {
    const n = this.bookmarkFile.read().length;
    this.bookmarkFile.write([]);
    return n;
  }

  /* ---------------- 历史 ---------------- */

  /** 浏览历史（最近在前）。seq 是排序用的存储细节，对外剥离。 */
  history(limit) {
    const list = this.historyFile
      .read()
      .map((h) => {
        const url = normUrl(h.url);
        return {
          url,
          title: cleanTitle(h.title) || fallbackTitle(url),
          site: String(h.site || '').trim(),
          visitedAt: num(h.visitedAt),
          seq: num(h.seq),
        };
      })
      .filter((h) => h.url)
      .sort((a, b) => b.visitedAt - a.visitedAt || b.seq - a.seq);
    const n = Number(limit);
    const out = Number.isFinite(n) && n > 0 ? list.slice(0, n) : list;
    return out.map(({ url, title, site, visitedAt }) => ({ url, title, site, visitedAt }));
  }

  /**
   * 记一条浏览历史。
   * 同一地址只保留最近一条（把时间顶上去），这样「地址栏下拉」里不会
   * 出现一屏同一个 URL。
   */
  pushHistory(raw) {
    const { url, title, site } = raw && typeof raw === 'object' ? raw : {};
    const u = normUrl(url);
    if (!u) return null;
    const k = urlKey(u);
    const list = this.historyFile.read().filter((h) => urlKey(h.url) !== k);
    const item = {
      url: u,
      title: cleanTitle(title) || fallbackTitle(u),
      site: String(site || '').trim(),
      visitedAt: Date.now(),
      seq: nextSeq(list.reduce((m, h) => Math.max(m, num(h.seq)), 0)),
    };
    list.push(item);
    // 保留最近 MAX_HISTORY 条（按时间倒序裁掉尾巴）
    list.sort((a, b) => num(b.visitedAt) - num(a.visitedAt) || num(b.seq) - num(a.seq));
    this.historyFile.write(list.slice(0, MAX_HISTORY));
    return item;
  }

  clearHistory() {
    const n = this.historyFile.read().length;
    this.historyFile.write([]);
    return n;
  }

  /* ---------------- 会话（上次开的标签） ---------------- */

  /** 上次的标签列表；结构坏掉的条目直接丢掉 */
  session() {
    return this.sessionFile
      .read()
      .map((t) => ({
        id: String(t.id || '').trim(),
        url: normUrl(t.url),
        title: cleanTitle(t.title),
      }))
      .filter((t) => t.url)
      .slice(0, 20); // 标签页上限，防止脏数据撑爆界面
  }

  saveSession(tabs) {
    const list = (Array.isArray(tabs) ? tabs : [])
      .map((t) => ({
        id: String((t && t.id) || '').trim(),
        url: normUrl(t && t.url),
        title: cleanTitle(t && t.title),
      }))
      .filter((t) => t.url)
      .slice(0, 20);
    this.sessionFile.write(list);
    return list;
  }

  clearSession() {
    this.sessionFile.write([]);
  }

  /** 概览统计（界面上的「书签 N 条 · 历史 M 条」） */
  stats() {
    return {
      bookmarks: this.bookmarks().length,
      history: this.historyFile.read().length,
    };
  }
}

module.exports = {
  BrowserStore,
  MAX_HISTORY,
  normUrl,
  urlKey,
  normalizeInput,
  isHttpUrl,
  cleanTitle,
  fallbackTitle,
};
