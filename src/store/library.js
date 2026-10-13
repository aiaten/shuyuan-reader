'use strict';
/**
 * 本地书架：书籍元信息 / 目录 / 章节正文 / 阅读进度 的落盘存储。
 *
 * 目录结构用可读的 JSON + txt（每章一个文件，便于增量下载与断点续传）：
 * ```
 * <dataDir>/shelf.json                        书架索引（书籍列表）
 * <dataDir>/books/<bookId>/meta.json          书名/作者/简介/封面/来源/书籍URL
 * <dataDir>/books/<bookId>/toc.json            目录（章节数组）
 * <dataDir>/books/<bookId>/chapters/<index>.txt  单章正文（纯文本）
 * <dataDir>/books/<bookId>/progress.json       阅读进度（章节 index + 章内偏移）
 * ```
 * bookId 由 `来源key + bookUrl` 的 md5 前 16 位构成，稳定且可人工对照。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** 书籍 id：来源 + 书地址 的短哈希 */
function bookIdOf(sourceKey, bookUrl) {
  const h = crypto.createHash('md5').update(`${sourceKey || ''}\n${bookUrl || ''}`, 'utf8').digest('hex');
  return h.slice(0, 16);
}

/** 章节文件名：零填充的序号，便于按字典序排序 */
function chapterFileName(index) {
  return `${String(index).padStart(5, '0')}.txt`;
}

function readJSON(file, dflt = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return dflt;
  }
}

function writeJSONAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class Library {
  /** @param {string} dataDir 数据根目录 */
  constructor(dataDir) {
    this.dir = path.resolve(dataDir);
    this.shelfFile = path.join(this.dir, 'shelf.json');
    this.booksDir = path.join(this.dir, 'books');
    fs.mkdirSync(this.booksDir, { recursive: true });
  }

  /* ---------------- 书架索引 ---------------- */

  /** 全部书籍（不含章节正文） */
  books() {
    const s = readJSON(this.shelfFile, { books: [] });
    return Array.isArray(s && s.books) ? s.books : [];
  }

  _writeShelf(books) {
    writeJSONAtomic(this.shelfFile, { version: 1, books });
  }

  get(bookId) {
    return this.books().find((b) => b.id === bookId) || null;
  }

  /** 按来源 + 书地址查找 */
  find(sourceKey, bookUrl) {
    const id = bookIdOf(sourceKey, bookUrl);
    return this.get(id);
  }

  /**
   * 加入书架（已存在则更新元信息）。
   * @param {object} meta { name, author, intro, kind, coverUrl, bookUrl, sourceKey, sourceName }
   * @returns {{id:string, created:boolean}}
   */
  add(meta) {
    const id = bookIdOf(meta.sourceKey, meta.bookUrl);
    const books = this.books();
    const idx = books.findIndex((b) => b.id === id);
    const now = Date.now();
    const row = {
      id,
      name: meta.name || '',
      author: meta.author || '',
      kind: meta.kind || '',
      intro: meta.intro || '',
      coverUrl: meta.coverUrl || '',
      bookUrl: meta.bookUrl || '',
      sourceKey: meta.sourceKey || '',
      sourceName: meta.sourceName || '',
      addedAt: idx >= 0 ? books[idx].addedAt : now,
      updatedAt: now,
      chapterCount: idx >= 0 ? books[idx].chapterCount || 0 : 0,
      downloadedCount: idx >= 0 ? books[idx].downloadedCount || 0 : 0,
      lastReadIndex: idx >= 0 ? books[idx].lastReadIndex : -1,
    };
    if (idx >= 0) books[idx] = row;
    else books.push(row);
    this._writeShelf(books);
    // 元信息单独落盘，便于人工检视
    writeJSONAtomic(path.join(this.bookDir(id), 'meta.json'), row);
    return { id, created: idx < 0 };
  }

  /** 直接按 id 覆盖书架里的一行（如更新下载进度） */
  _patch(bookId, patch) {
    const books = this.books();
    const idx = books.findIndex((b) => b.id === bookId);
    if (idx < 0) return null;
    books[idx] = { ...books[idx], ...patch, updatedAt: Date.now() };
    this._writeShelf(books);
    writeJSONAtomic(path.join(this.bookDir(bookId), 'meta.json'), books[idx]);
    return books[idx];
  }

  /** 从书架移除（同时删除本地文件） */
  remove(bookId, { deleteFiles = true } = {}) {
    const books = this.books();
    const next = books.filter((b) => b.id !== bookId);
    if (next.length === books.length) return false;
    this._writeShelf(next);
    if (deleteFiles) fs.rmSync(this.bookDir(bookId), { recursive: true, force: true });
    return true;
  }

  /* ---------------- 单本书的文件 ---------------- */

  bookDir(bookId) {
    return path.join(this.booksDir, bookId);
  }

  chaptersDir(bookId) {
    return path.join(this.bookDir(bookId), 'chapters');
  }

  /** 目录（章节数组） */
  toc(bookId) {
    return readJSON(path.join(this.bookDir(bookId), 'toc.json'), []);
  }

  saveToc(bookId, chapters) {
    const arr = (chapters || []).map((c, i) => ({
      index: i,
      name: c.name || '',
      url: c.url || '',
      isVolume: !!c.isVolume,
      isVip: !!c.isVip,
      isPay: !!c.isPay,
      tag: c.tag || '',
    }));
    writeJSONAtomic(path.join(this.bookDir(bookId), 'toc.json'), arr);
    this._patch(bookId, { chapterCount: arr.length });
    return arr;
  }

  /** 读取单章正文；返回 null 表示尚未下载 */
  chapter(bookId, index) {
    const f = path.join(this.chaptersDir(bookId), chapterFileName(index));
    try {
      return fs.readFileSync(f, 'utf8');
    } catch (_) {
      return null;
    }
  }

  saveChapter(bookId, index, text) {
    const dir = this.chaptersDir(bookId);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, chapterFileName(index));
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, text == null ? '' : String(text), 'utf8');
    fs.renameSync(tmp, f);
    return f;
  }

  /** 已下载的章节序号集合 */
  downloadedIndexes(bookId) {
    const dir = this.chaptersDir(bookId);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      return [];
    }
    return names
      .filter((n) => /^\d{5}\.txt$/.test(n))
      .map((n) => parseInt(n.slice(0, 5), 10))
      .sort((a, b) => a - b);
  }

  /** 已下载章节数（刷新书架行统计） */
  syncDownloadedCount(bookId) {
    const n = this.downloadedIndexes(bookId).length;
    this._patch(bookId, { downloadedCount: n });
    return n;
  }

  /* ---------------- 阅读进度 ---------------- */

  /**
   * 阅读进度。没有记录时返回全 0 的默认值（而不是 null），
   * 调用方无需到处判空。
   */
  progress(bookId) {
    const p = readJSON(path.join(this.bookDir(bookId), 'progress.json'), null);
    if (!p || typeof p !== 'object') return { index: 0, offset: 0, percent: 0 };
    return {
      index: Number.isFinite(p.index) ? p.index : 0,
      offset: Number.isFinite(p.offset) ? p.offset : 0,
      percent: Number.isFinite(p.percent) ? p.percent : 0,
      ...(p.at ? { at: p.at } : {}),
    };
  }

  /**
   * 保存阅读进度。**未传的字段沿用旧值**（翻章时会只传 index，此时
   * 章节内的滚动位置 offset 不应被清零）。
   */
  saveProgress(bookId, patch = {}) {
    const cur = this.progress(bookId);
    const p = {
      index: patch.index != null ? patch.index : cur.index,
      offset: patch.offset != null ? patch.offset : cur.offset,
      percent: patch.percent != null ? patch.percent : cur.percent,
      at: Date.now(),
    };
    writeJSONAtomic(path.join(this.bookDir(bookId), 'progress.json'), p);
    this._patch(bookId, { lastReadIndex: p.index });
    return p;
  }
}

module.exports = { Library, bookIdOf, chapterFileName };
