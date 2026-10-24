'use strict';
/**
 * 书架「检查更新」：逐本抓取书源上的最新目录，与本地 toc.json 比对。
 *
 * 为什么单独一个模块（而不是塞进 App）：
 *  - 比对逻辑是纯函数，可离线单测（compareToc）；
 *  - 抓目录要并发限流 + 单本超时，出错只影响这一本，不能拖垮整次检查；
 *  - GUI 启动时自动检查、手动「检查更新」、CLI `check` 三条入口共用同一套语义。
 *
 * 更新判定与落盘策略：
 *  - 远端章数变多、且本地目录是远端目录的**前缀** → 追加更新：
 *    把新章节追加进本地 toc.json（chapterCount 随之更新），状态 `updated`；
 *  - 章数相同但内容/顺序变化，或不是单纯追加（中间插入、删章、重排）
 *    只标记 `changed`，**不改本地 toc**（按序号硬覆盖会让已下载正文串章）；
 *  - 完全一致 → `latest`；
 *  - 书源缺失 / 网络或解析失败 → `error` / `missing-source`，只记录错误，不抛异常。
 */

const { SourceEngine } = require('../engine/source');

/** 章节比对键：地址 + 标题（站点换 CDN 但标题不变时也算变化，宁可多提示一次） */
function chapterKey(c) {
  return `${String((c && c.url) || '').trim()}\n${String((c && c.name) || '').trim()}`;
}

/**
 * 比对本地目录与远端目录。
 * @param {Array} oldToc 本地 toc（可为空）
 * @param {Array} newToc 远端 toc
 * @returns {{changed:boolean, appended:boolean, removed:boolean, prefixSame:boolean,
 *            oldCount:number, newCount:number, addedCount:number, removedCount:number,
 *            latestChapter:string}}
 */
function compareToc(oldToc, newToc) {
  const a = Array.isArray(oldToc) ? oldToc : [];
  const b = Array.isArray(newToc) ? newToc : [];
  const oldCount = a.length;
  const newCount = b.length;
  const n = Math.min(oldCount, newCount);
  let prefixSame = true;
  for (let i = 0; i < n; i++) {
    if (chapterKey(a[i]) !== chapterKey(b[i])) { prefixSame = false; break; }
  }
  const appended = newCount > oldCount && prefixSame;
  const removed = newCount < oldCount && prefixSame;
  const changed = oldCount !== newCount || !prefixSame;
  return {
    changed,
    appended,
    removed,
    prefixSame,
    oldCount,
    newCount,
    addedCount: Math.max(0, newCount - oldCount),
    removedCount: Math.max(0, oldCount - newCount),
    latestChapter: newCount ? String((b[newCount - 1] && b[newCount - 1].name) || '') : '',
  };
}

/** 只保留 toc 需要落盘的字段（与 Library.saveToc 的入参一致） */
function tocRow(c) {
  return {
    name: (c && c.name) || '',
    url: (c && c.url) || '',
    isVolume: !!(c && c.isVolume),
    isVip: !!(c && c.isVip),
    isPay: !!(c && c.isPay),
    tag: (c && c.tag) || '',
  };
}

/** 并发执行，保持结果顺序 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit || 1, items.length || 1))).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 给单本检查套一层超时：底层 socket 可能卡住，整次检查不能因此不返回 */
function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || '操作'}超时（${ms}ms）`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 检查单本书。
 * @param {object} opts
 * @param {import('./library').Library} opts.library
 * @param {import('../source/store').SourceStore} opts.sources
 * @param {object} opts.book 书架条目
 * @param {(source:object)=>object} [opts.makeEngine] 引擎工厂（单测注入桩）
 * @param {number} [opts.timeout=20000] 单本超时
 * @param {boolean} [opts.applyToc=true] 追加更新时是否写入本地目录
 * @param {boolean} [opts.dryRun=false] 只比对不落盘（单测/CLI --dry-run 用）
 */
async function checkBook(opts) {
  const { library, sources, book } = opts;
  const now = Date.now();
  const base = {
    bookId: book.id,
    name: book.name || '',
    oldCount: 0,
    newCount: 0,
    addedCount: 0,
    removedCount: 0,
    latestChapter: '',
    tocApplied: false,
  };

  const src = sources && sources.get(book.sourceKey);
  if (!src) {
    const error = `书源已不存在：${book.sourceKey || '(空)'}`;
    if (!opts.dryRun) {
      library._patch(book.id, {
        lastCheckAt: now,
        updateStatus: 'missing-source',
        updateCount: 0,
        updateTocChanged: false,
        updateError: error,
      });
    }
    return { ...base, status: 'missing-source', changed: false, error };
  }

  const makeEngine = opts.makeEngine || ((source) => new SourceEngine(source, {
    logger: null,
    httpOptions: { timeout: opts.timeout || 20000 },
  }));
  const engine = makeEngine(src);

  try {
    const run = async () => {
      // 详情页只用来拿 tocUrl；失败不致命，直接用 bookUrl 抓目录
      let tocUrl = book.bookUrl;
      try {
        const info = await engine.bookInfo(book.bookUrl);
        if (info && info.tocUrl) tocUrl = info.tocUrl;
      } catch (_) { /* 详情页失败时退回 bookUrl */ }

      const urls = [];
      for (const u of [tocUrl, book.bookUrl]) {
        if (u && !urls.includes(u)) urls.push(u);
      }
      let chapters = [];
      let lastErr = null;
      for (const u of urls) {
        try {
          const list = await engine.toc(u);
          if (Array.isArray(list) && list.length) { chapters = list; break; }
        } catch (e) {
          lastErr = e;
        }
      }
      if (!chapters.length) throw new Error(lastErr ? lastErr.message : '书源返回的目录为空');
      return chapters;
    };

    const chapters = await withTimeout(run(), opts.timeout || 20000, '检查目录');
    const oldToc = library.toc(book.id);
    const diff = compareToc(oldToc, chapters);

    let status = 'latest';
    if (diff.changed) status = diff.appended ? 'updated' : 'changed';

    let tocApplied = false;
    if (status === 'updated' && opts.applyToc !== false && !opts.dryRun) {
      // 只追加，保留本地已有条目的字段（老章节可能带站点标签），新章节按远端补
      const merged = oldToc.map(tocRow).concat(chapters.slice(diff.oldCount).map(tocRow));
      library.saveToc(book.id, merged);
      tocApplied = true;
    }

    if (!opts.dryRun) {
      library._patch(book.id, {
        lastCheckAt: now,
        updateStatus: status,
        updateCount: diff.addedCount,
        latestChapter: diff.latestChapter,
        latestChapterCount: diff.newCount,
        updateTocChanged: status === 'changed',
        updateError: '',
      });
    }

    return {
      ...base,
      status,
      changed: diff.changed,
      oldCount: diff.oldCount,
      newCount: diff.newCount,
      addedCount: diff.addedCount,
      removedCount: diff.removedCount,
      latestChapter: diff.latestChapter,
      tocApplied,
      error: '',
    };
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    if (!opts.dryRun) {
      library._patch(book.id, {
        lastCheckAt: now,
        updateStatus: 'error',
        updateCount: 0,
        updateTocChanged: false,
        updateError: error,
      });
    }
    return { ...base, status: 'error', changed: false, error };
  }
}

/**
 * 检查整个书架（或指定 bookIds）。
 * @param {object} opts { library, sources, bookIds, concurrency=3, timeout=20000, applyToc=true, dryRun=false, onProgress }
 * @returns {Promise<{total, checked, updated, changed, latest, failed, elapsed, items}>}
 */
async function checkShelfUpdates(opts = {}) {
  const { library, sources } = opts;
  if (!library) throw new Error('检查更新缺少 library');
  const all = library.books();
  const wanted = opts.bookIds && opts.bookIds.length ? new Set(opts.bookIds.map(String)) : null;
  const books = wanted ? all.filter((b) => wanted.has(String(b.id))) : all;
  const started = Date.now();
  const concurrency = Math.max(1, Math.min(opts.concurrency || 3, 8));

  const items = await mapLimit(books, concurrency, async (book) => {
    const r = await checkBook({ ...opts, library, sources, book });
    if (opts.onProgress) {
      try { opts.onProgress(r); } catch (_) { /* 回调异常不影响检查 */ }
    }
    return r;
  });

  const updated = items.filter((r) => r.status === 'updated').length;
  const changed = items.filter((r) => r.status === 'changed').length;
  const latest = items.filter((r) => r.status === 'latest').length;
  const failed = items.filter((r) => r.status === 'error' || r.status === 'missing-source').length;
  return {
    total: books.length,
    checked: items.length - failed,
    updated,
    changed,
    latest,
    failed,
    elapsed: Date.now() - started,
    items,
  };
}

module.exports = { compareToc, checkBook, checkShelfUpdates, chapterKey, mapLimit, withTimeout };