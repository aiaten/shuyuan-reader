'use strict';
/**
 * 下载编排：把书源引擎取回的目录 / 正文写进本地书架。
 *
 * 对齐 Legado 的下载语义：
 *  - 正文按章并发下载（默认 4 并发，与 Legado `maxNextPageConcurrency` 同量级），
 *    但**书源自带 concurrentRate（如 `1/1000`）时必须串行**并遵守间隔，否则会被封。
 *  - 章节内容为空 → 记失败、不写文件，便于下次续传。
 *  - 支持断点续传：已存在的章节文件默认跳过。
 *
 * 深度控制：
 *  - `toc`      只取目录
 *  - `chars`    取目录 + 全部正文
 *  - `all`      同 chars（预留：封面 / 简介补全）
 *
 * 懒加载（滑动窗口）：
 *  全书一次下完对长篇小说极慢（上千章 × 单章 1~3s）。因此改成「按需下载」：
 *  加入书架时先下前 `INITIAL_WINDOW` 章，之后读到第 N 章就只保证第 N+1..N+`READAHEAD_WINDOW`
 *  章在手。见 `downloadWindow` / `windowFor`。
 */

const { SourceEngine } = require('../engine/source');
const { Library, bookIdOf } = require('./library');
const { SourceStore, keyOf } = require('../source/store');

/** 加入书架时预下载的章数（够开篇连续阅读，不必等全书） */
const INITIAL_WINDOW = 10;
/** 读到第 N 章时，向后保证已下载的章数（N+1 .. N+READAHEAD_WINDOW） */
const READAHEAD_WINDOW = 10;

/** 解析书源的 concurrentRate，如 "1/1000" → { count:1, intervalMs:1000 } */
function parseConcurrentRate(rate) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(rate || ''));
  if (!m) return null;
  const count = Math.max(1, parseInt(m[1], 10));
  const intervalMs = Math.max(0, parseInt(m[2], 10));
  return { count, intervalMs };
}

/**
 * 计算「读到第 index 章时该下载哪一段」。
 *
 * 规则：加入书架下前 INITIAL_WINDOW 章（0..9）；读到第 N 章时补 N+1 .. N+READAHEAD_WINDOW。
 * 已经读到的章（index 及之前）不重下，因为它们必然在更早的窗口里下过了；
 * 但如果用户跳章（直接翻到第 500 章），前面的空缺也不补——那是用户自己的选择，
 * 强行补会把「跳读」变成「全下」，正是要避免的慢。
 *
 * @param {number} index 当前阅读到的章序号（0 基）
 * @param {number} total 总章数
 * @param {object} [opts] { initial, window }
 * @returns {{from:number, to:number}} 闭区间；无待下载章时 from > to
 */
function windowFor(index, total, opts = {}) {
  const initial = Math.max(1, opts.initial == null ? INITIAL_WINDOW : opts.initial);
  const window = Math.max(1, opts.window == null ? READAHEAD_WINDOW : opts.window);
  const n = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (!n) return { from: 0, to: -1 };
  const cur = Math.max(0, Math.floor(Number.isFinite(index) ? index : 0));
  // 尚未开始阅读（还没读过任何章）→ 初始窗口：0..initial-1
  if (cur === 0) return { from: 0, to: Math.min(n - 1, initial - 1) };
  // 读到第 cur 章 → 补 cur+1 .. cur+window，一律不含已读的 cur 本身
  const from = cur + 1;
  const to = Math.min(n - 1, cur + window);
  if (from > to) return { from: 0, to: -1 };
  return { from, to };
}

/** 并发执行，保持结果顺序 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Downloader {
  /**
   * @param {object} opts
   * @param {Library} opts.library
   * @param {SourceStore} opts.sourceStore
   * @param {string} [opts.dataDir]
   * @param {number} [opts.concurrency=4]
   * @param {(msg:string)=>void} [opts.logger]
   */
  constructor(opts = {}) {
    if (!opts.library) throw new Error('Downloader 需要 library');
    this.lib = opts.library;
    this.sources = opts.sourceStore || null;
    this.dataDir = opts.dataDir || this.lib.dir;
    this.concurrency = Math.max(1, opts.concurrency || 4);
    this.logger = opts.logger || null;
    this.jar = opts.jar || null;
  }

  _log(msg) {
    if (this.logger) this.logger(msg);
  }

  /** 取书源并构造引擎 */
  _engine(source) {
    return new SourceEngine(source, {
      jar: this.jar || undefined,
      logger: null,
      httpOptions: { timeout: 30000 },
    });
  }

  /**
   * 把一本搜索结果加入书架并抓目录。
   * @param {object} source 书源 JSON
   * @param {object} book { name, author, intro, kind, coverUrl, bookUrl }
   * @returns {Promise<{id, name, chapterCount, chapters}>}
   */
  async addBook(source, book) {
    const sk = keyOf(source);
    const { id } = this.lib.add({
      name: book.name,
      author: book.author,
      intro: book.intro,
      kind: book.kind,
      coverUrl: book.coverUrl,
      bookUrl: book.bookUrl,
      sourceKey: sk,
      sourceName: source.bookSourceName,
    });

    const engine = this._engine(source);
    const info = await engine.bookInfo(book.bookUrl);
    if (info) {
      this.lib.add({
        name: info.name || book.name,
        author: info.author || book.author,
        intro: info.intro || book.intro,
        kind: info.kind || book.kind,
        coverUrl: info.coverUrl || book.coverUrl,
        bookUrl: book.bookUrl,
        sourceKey: sk,
        sourceName: source.bookSourceName,
      });
    }

    const tocUrl = (info && info.tocUrl) || book.bookUrl;
    let chapters = await engine.toc(tocUrl);
    // 回退：书源给的 tocUrl 解不出章节时改用详情页（与 probe 的策略一致）
    if ((!chapters || !chapters.length) && tocUrl !== book.bookUrl) {
      chapters = await engine.toc(book.bookUrl);
    }
    if (!chapters || !chapters.length) throw new Error(`目录为空，无法加入书架：${book.name}`);

    this.lib.saveToc(id, chapters);
    this._log(`目录 ${chapters.length} 章`);
    return { id, name: info && info.name ? info.name : book.name, chapterCount: chapters.length, chapters };
  }

  /**
   * 下载正文。
   * @param {object} source 书源 JSON
   * @param {string} bookId
   * @param {object} [opts] { from, to, force, onProgress }
   * @returns {Promise<{total, done, skipped, failed, failedIndexes}>}
   */
  async downloadChapters(source, bookId, opts = {}) {
    const toc = this.lib.toc(bookId);
    if (!toc.length) throw new Error(`本地没有目录，请先抓取目录：${bookId}`);

    const from = Math.max(0, opts.from == null ? 0 : opts.from);
    const to = Math.min(toc.length - 1, opts.to == null ? toc.length - 1 : opts.to);
    const targets = [];
    for (let i = from; i <= to; i++) targets.push(toc[i]);

    const rate = parseConcurrentRate(source.concurrentRate);
    // concurrentRate 存在时保守串行 + 遵守间隔；否则用配置并发
    const limit = rate ? 1 : this.concurrency;
    const gap = rate ? rate.intervalMs : 0;

    let done = 0;
    let skipped = 0;
    const failedIndexes = [];

    const engine = this._engine(source);

    await mapLimit(targets, limit, async (ch) => {
      const idx = ch.index;
      if (!opts.force && this.lib.chapter(bookId, idx) != null) {
        skipped++;
        if (opts.onProgress) opts.onProgress({ index: idx, total: targets.length, status: 'skip' });
        return;
      }
      try {
        const next = toc[idx + 1];
        const res = await engine.content(ch.url, next ? { nextChapterUrl: next.url } : {});
        const text = res && res.text ? res.text : '';
        if (!text.trim()) {
          failedIndexes.push(idx);
          if (opts.onProgress) opts.onProgress({ index: idx, total: targets.length, status: 'empty' });
          return;
        }
        // 落盘格式：首行章节名 + 空行 + 正文。
        // 章节名取自书源目录（如「第1章」），导出时会被识别并去掉，避免标题重复。
        this.lib.saveChapter(bookId, idx, `${ch.name || ''}\n\n${text}\n`);
        done++;
        if (opts.onProgress) opts.onProgress({ index: idx, total: targets.length, status: 'ok' });
      } catch (e) {
        failedIndexes.push(idx);
        this._log(`第 ${idx + 1} 章失败：${e.message}`);
        if (opts.onProgress) opts.onProgress({ index: idx, total: targets.length, status: 'fail', error: e.message });
      }
      if (gap) await sleep(gap);
    });

    this.lib.syncDownloadedCount(bookId);
    return { total: targets.length, done, skipped, failed: failedIndexes.length, failedIndexes };
  }

  /**
   * 懒加载：保证「读到第 index 章」时该有的那一小段正文已下载。
   *
   * 与 downloadChapters 的分工：downloadChapters 是「下载指定区间」的通用原语，
   * 本方法负责按阅读位置**算出**该下哪一段，并跳过已下载的、避免重复请求。
   *
   * 并发防重入由调用方（App）负责：同一本书同时只跑一个窗口任务，
   * 否则用户快速连翻几章会并发拉同一段，反而更慢。
   *
   * @param {object} source 书源 JSON
   * @param {string} bookId
   * @param {number} index 当前阅读到的章序号（0 基）
   * @param {object} [opts] { initial, window, force, onProgress }
   * @returns {Promise<{from, to, total, done, skipped, failed, failedIndexes, empty}>}
   */
  async downloadWindow(source, bookId, index, opts = {}) {
    const toc = this.lib.toc(bookId);
    if (!toc.length) throw new Error(`本地没有目录，请先抓取目录：${bookId}`);

    const { from, to } = windowFor(index, toc.length, opts);
    if (from > to) {
      return { from, to, total: 0, done: 0, skipped: 0, failed: 0, failedIndexes: [], empty: true };
    }

    // 先看这一段里哪些是真的没有文件（downloadChapters 内部也会 skip，但这里先筛掉
    // 「整段都已下载」的常见情况，省掉一次引擎构造与整段遍历）
    const have = new Set(this.lib.downloadedIndexes(bookId));
    if (!opts.force && have.size) {
      let allHave = true;
      for (let i = from; i <= to; i++) {
        if (!have.has(i)) { allHave = false; break; }
      }
      if (allHave) {
        return { from, to, total: to - from + 1, done: 0, skipped: to - from + 1, failed: 0, failedIndexes: [], empty: true };
      }
    }

    const r = await this.downloadChapters(source, bookId, { ...opts, from, to });
    return { ...r, from, to, empty: false };
  }

  /**
   * 一步到位：搜索关键词 → 取第一条（或指定序号）→ 加书架 → 抓目录（可选下载正文）。
   * @param {object} source
   * @param {string} keyword
   * @param {object} [opts] { pick=0, download=false, from, to, force, onProgress }
   */
  async searchAndAdd(source, keyword, opts = {}) {
    const engine = this._engine(source);
    const list = await engine.search(keyword, 1);
    if (!list.length) throw new Error(`搜索「${keyword}」无结果`);
    const pick = Math.min(Math.max(0, opts.pick || 0), list.length - 1);
    const book = list[pick];
    const added = await this.addBook(source, book);
    let dl = null;
    if (opts.download) {
      dl = await this.downloadChapters(source, added.id, opts);
    }
    return { ...added, book, list, download: dl };
  }
}

module.exports = {
  Downloader, parseConcurrentRate, mapLimit, bookIdOf,
  windowFor, INITIAL_WINDOW, READAHEAD_WINDOW,
};
