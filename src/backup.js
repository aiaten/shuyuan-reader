'use strict';
/**
 * 备份 / 恢复：把「书源 + 订阅源 + 书架（含阅读进度与目录）」打包成一个 JSON 文件。
 *
 * 为什么不含正文：正文按「每章一个 txt」存在 books/<id>/chapters/ 下，一本书动辄
 * 几 MB，整个书架能到几百 MB，塞进 JSON 备份会既慢又难传。正文请用「导出 TXT」。
 * 目录（toc.json）只有章节名 + 地址，几百章也就几十 KB，带上它才能在没网/换源后
 * 直接看到目录，所以默认包含。
 *
 * 备份文件格式（format = 'shuyuan-reader-backup'）：
 * ```json
 * {
 *   "format": "shuyuan-reader-backup",
 *   "version": 1,
 *   "scope": "all" | "sources",
 *   "createdAt": 1793431719031,
 *   "counts": { "sources": 8, "rss": 2, "books": 3 },
 *   "sources": [ ...Legado 书源... ],
 *   "rss": [ ...Legado 订阅源... ],
 *   "books": [ { ...书架行..., "progress": {...}, "toc": [...] } ]
 * }
 * ```
 *
 * 恢复语义（重要，别让用户吃亏）：
 * - 书源/订阅源按 key 合并：同名默认跳过，opts.force 时才覆盖（备份是旧的，可能不如现在）。
 * - 书架按「来源 + 书地址」生成 id 合并：已存在的书只补元信息，不动本地已有目录/进度
 *   （本地可能读得更远、目录更新）；新书才写目录与进度。
 * - 全程只增不删：恢复是「把备份里的东西补回来」，绝不清理本地现有数据。
 */

const { bookIdOf } = require('./store/library');
const { keyOf } = require('./source/store');

const FORMAT = 'shuyuan-reader-backup';
const VERSION = 1;

/** 书架行里需要备份的字段（id 由恢复端重算，不依赖备份里的 id） */
const BOOK_FIELDS = [
  'name',
  'author',
  'kind',
  'intro',
  'coverUrl',
  'bookUrl',
  'sourceKey',
  'sourceName',
  'addedAt',
  'lastReadIndex',
  'lastCheckAt',
  'updateStatus',
  'updateCount',
  'latestChapter',
  'latestChapterCount',
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 备份文件默认名：shuyuan-backup-20261031-1537.json */
function defaultName(date = new Date()) {
  const d = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
  return `shuyuan-backup-${d}-${pad2(date.getHours())}${pad2(date.getMinutes())}.json`;
}

/**
 * 生成备份对象。
 * @param {import('./app').App} app
 * @param {object} [opts] { scope: 'all'|'sources', includeToc=true, includeProgress=true }
 */
function create(app, opts = {}) {
  const scope = opts.scope === 'sources' ? 'sources' : 'all';
  const includeToc = opts.includeToc !== false;
  const includeProgress = opts.includeProgress !== false;

  const sources = app.sources.all();
  const rss = app.rss.all();
  const books = scope === 'all' ? app.library.books() : [];

  const booksOut = books.map((b) => {
    const row = {};
    for (const f of BOOK_FIELDS) if (b[f] !== undefined) row[f] = b[f];
    // 下载数量在恢复端会按本地实际文件重算，不备份（换机后旧值没意义）
    if (includeProgress) {
      const p = app.library.progress(b.id);
      if (p && (p.index > 0 || p.offset > 0 || p.percent > 0)) row.progress = p;
    }
    if (includeToc) {
      const toc = app.library.toc(b.id);
      if (Array.isArray(toc) && toc.length) {
        row.tocCount = toc.length;
        row.toc = toc.map((c) => ({ name: c.name, url: c.url, isVolume: !!c.isVolume, isVip: !!c.isVip }));
      }
    }
    return row;
  });

  return {
    format: FORMAT,
    version: VERSION,
    scope,
    createdAt: Date.now(),
    counts: { sources: sources.length, rss: rss.length, books: booksOut.length },
    sources,
    rss,
    books: booksOut,
  };
}

/** 序列化成文件文本（2 空格缩进，方便人工检视/手工改） */
function serialize(payload) {
  return JSON.stringify(payload, null, 2);
}

/**
 * 解析备份文本。兼容三种输入：
 *  1. 本模块生成的备份对象
 *  2. 裸书源数组 / 单个书源对象（老的「导出书源」文件）
 *  3. 裸订阅源数组
 * @returns {{format:string, version:number, scope:string, createdAt:number, counts:object, sources:Array, rss:Array, books:Array, legacy:boolean}}
 */
function parse(text) {
  const cleaned = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
  if (!cleaned) throw new Error('文件是空的');
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('不是合法 JSON：' + e.message);
  }

  if (data && typeof data === 'object' && data.format === FORMAT) {
    if (Number(data.version) > VERSION) {
      throw new Error(`备份版本过新（v${data.version}），当前程序只认到 v${VERSION}，请先升级软件`);
    }
    const sources = Array.isArray(data.sources) ? data.sources : [];
    const rss = Array.isArray(data.rss) ? data.rss : [];
    const books = Array.isArray(data.books) ? data.books : [];
    return {
      format: FORMAT,
      version: Number(data.version) || VERSION,
      scope: data.scope === 'sources' ? 'sources' : 'all',
      createdAt: Number(data.createdAt) || 0,
      counts: { sources: sources.length, rss: rss.length, books: books.length },
      sources,
      rss,
      books,
      legacy: false,
    };
  }

  // 老格式：一个数组或单个对象。按字段猜是书源还是订阅源。
  const arr = Array.isArray(data) ? data : [data];
  const isSource = (s) => s && typeof s === 'object' && (s.bookSourceUrl || s.bookSourceName);
  const isRss = (s) => s && typeof s === 'object' && (s.sourceUrl || s.sourceName);
  const sources = arr.filter(isSource);
  const rss = arr.filter((s) => !isSource(s) && isRss(s));
  if (!sources.length && !rss.length) {
    throw new Error('这个文件里没有识别到书源或订阅源');
  }
  return {
    format: 'legado-json',
    version: 0,
    scope: 'sources',
    createdAt: 0,
    counts: { sources: sources.length, rss: rss.length, books: 0 },
    sources,
    rss,
    books: [],
    legacy: true,
  };
}

/** 只读预览：给界面确认弹窗用，不落盘 */
function inspect(text) {
  const p = parse(text);
  return {
    format: p.format,
    version: p.version,
    scope: p.scope,
    createdAt: p.createdAt,
    legacy: p.legacy,
    counts: p.counts,
    bookNames: p.books.slice(0, 8).map((b) => b.name || '(未命名)'),
    sourceNames: p.sources.slice(0, 8).map((s) => s.bookSourceName || '(未命名)'),
  };
}

/** 书架行 → library.add 需要的元信息 */
function metaOf(row) {
  return {
    name: row.name || '',
    author: row.author || '',
    kind: row.kind || '',
    intro: row.intro || '',
    coverUrl: row.coverUrl || '',
    bookUrl: row.bookUrl || '',
    sourceKey: row.sourceKey || '',
    sourceName: row.sourceName || '',
  };
}

/**
 * 恢复备份。
 * @param {import('./app').App} app
 * @param {string} text 备份文件内容
 * @param {object} [opts]
 *   { force=false, sources=true, rss=true, books=true, progress=true, toc=true }
 *   force: 覆盖已存在的书源/订阅源（默认跳过，避免用旧备份冲掉新书源）
 *   progress/toc: 是否恢复阅读进度 / 目录（只对**新加入**的书生效）
 * @returns {Promise<object>} 各部分的统计
 */
async function restore(app, text, opts = {}) {
  const payload = parse(text);
  const wantSources = opts.sources !== false;
  const wantRss = opts.rss !== false;
  const wantBooks = opts.books !== false;
  const wantProgress = opts.progress !== false;
  const wantToc = opts.toc !== false;
  const force = !!opts.force;

  const out = {
    format: payload.format,
    sources: { added: 0, updated: 0, skipped: 0, failed: 0, items: [] },
    rss: { added: 0, updated: 0, skipped: 0, failed: 0 },
    books: { added: 0, updated: 0, skipped: 0, tocRestored: 0, progressRestored: 0, warnings: [] },
  };

  /* ---- 1. 书源：直接落盘，不做可读性探测（备份即信任，恢复不联网） ---- */
  if (wantSources && payload.sources.length) {
    for (const s of payload.sources) {
      const name = s.bookSourceName || '(未命名)';
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await app.sources.add(s, { probe: false, force });
        if (r.added) {
          if (r.reason === '已更新') out.sources.updated++;
          else out.sources.added++;
          out.sources.items.push({ name, ok: true, reason: r.reason });
        } else {
          out.sources.skipped++;
          out.sources.items.push({ name, ok: false, reason: r.reason });
        }
      } catch (e) {
        out.sources.failed++;
        out.sources.items.push({ name, ok: false, reason: e.message || String(e) });
      }
    }
  }

  /* ---- 2. 订阅源 ---- */
  if (wantRss && payload.rss.length) {
    const r = app.rss.addMany(payload.rss, { force });
    out.rss.added = r.added;
    out.rss.updated = r.updated;
    out.rss.skipped = r.skipped;
  }

  /* ---- 3. 书架（含目录 / 进度） ---- */
  if (wantBooks && payload.books.length) {
    for (const row of payload.books) {
      if (!row || !row.bookUrl || !row.sourceKey) {
        out.books.skipped++;
        out.books.warnings.push(`跳过一条没有来源或书地址的记录：${row && row.name ? row.name : '(未命名)'}`);
        continue;
      }
      const id = bookIdOf(row.sourceKey, row.bookUrl);
      const existed = !!app.library.get(id);
      try {
        app.library.add(metaOf(row));
        if (existed) out.books.updated++;
        else out.books.added++;

        // 目录：只在新书或本地还没有目录时写入（本地目录可能已经更新到更多章）
        if (wantToc && Array.isArray(row.toc) && row.toc.length) {
          const localToc = app.library.toc(id);
          if (!localToc.length) {
            app.library.saveToc(id, row.toc);
            out.books.tocRestored++;
          }
        }
        // 进度：本地没有进度记录时才补（恢复旧备份不应该把读到第 300 章退回第 10 章）
        if (wantProgress && row.progress) {
          const lp = app.library.progress(id);
          const localEmpty = !(lp.index > 0 || lp.offset > 0 || lp.percent > 0);
          if (localEmpty) {
            app.library.saveProgress(id, row.progress);
            out.books.progressRestored++;
          }
        }
        // 已下载数量按本地实际文件重算
        app.library.syncDownloadedCount(id);
      } catch (e) {
        out.books.skipped++;
        out.books.warnings.push(`《${row.name || '未命名'}》恢复失败：${e.message || e}`);
      }
    }
  }

  return out;
}

module.exports = {
  FORMAT,
  VERSION,
  BOOK_FIELDS,
  create,
  serialize,
  parse,
  inspect,
  restore,
  defaultName,
};
