'use strict';
/**
 * TXT 打包导出（交付点④）。
 *
 * 支持三种布局：
 *  - `single`  全书合并为一个 txt（默认）
 *  - `chapter` 每章一个 txt，放进以书名命名的目录
 *  - `volume`  按卷合并（书源目录里 isVolume 的条目作为分卷标志）
 *
 * 可配置：编码（utf-8 / gbk / gb18030 / utf-16le）、换行（CRLF / LF）、
 * 是否输出目录、是否输出书籍信息头、文件名模板、单章标题格式。
 *
 * 落盘用「临时文件 + rename」原子写，中途失败不会留下半截文件。
 */

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const EOL_MAP = { crlf: '\r\n', lf: '\n', cr: '\r' };

const DEFAULTS = {
  layout: 'single', // single | chapter | volume
  encoding: 'utf-8', // utf-8 | gbk | gb18030 | utf-16le | utf-16be
  eol: 'crlf', // crlf | lf | cr
  includeToc: true, // 是否输出目录
  includeHeader: true, // 是否输出书名/作者/简介等信息头
  includeIntro: true,
  chapterTitle: '{name}', // 章标题模板；{name} 为目录里的章名，{index} 从 1 开始，{i} 从 0 开始
  fileName: '{name}', // 单文件模式的文件名模板（不含扩展名）
  dirName: '{name}', // 分章/分卷模式的目录名模板
  fileNameTemplate: '{index}-{name}', // 分章/分卷模式的文件名模板
  pad: 4, // 分章文件名序号补零位数
  onlyDownloaded: true, // 只导出本地已下载的章节
  bom: false, // utf-8 是否加 BOM
};

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 去掉文件名里的非法字符 */
function sanitize(name, fallback = 'untitled') {
  const s = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const cut = s.length > 80 ? s.slice(0, 80).trim() : s;
  return cut || fallback;
}

function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? String(vars[k]) : ''));
}

function normalizeOptions(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  o.layout = String(o.layout).toLowerCase();
  if (!['single', 'chapter', 'volume'].includes(o.layout)) o.layout = 'single';
  o.encoding = String(o.encoding).toLowerCase();
  if (!iconv.encodingExists(o.encoding)) o.encoding = 'utf-8';
  o.eol = EOL_MAP[String(o.eol).toLowerCase()] || EOL_MAP.crlf;
  o.pad = Math.max(0, Math.min(8, parseInt(o.pad, 10) || 0));
  return o;
}

/** 统一换行 + 去行尾空白 + 压缩三个以上连续空行 */
function normalizeText(text, eol) {
  let s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+$/, ''))
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 写文件（原子 + 目标编码） */
function writeEncoded(file, text, o) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = o.eol === '\n' ? text : text.replace(/\n/g, o.eol);
  let buf;
  if (o.encoding === 'utf-8') {
    buf = o.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]) : Buffer.from(body, 'utf8');
  } else {
    buf = iconv.encode(body, o.encoding);
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return buf.length;
}

/* ------------------------------------------------------------------ *
 * 内容组装
 * ------------------------------------------------------------------ */

/** 书籍信息头 */
function buildHeader(book, o) {
  if (!o.includeHeader) return '';
  const lines = [];
  lines.push(book.name || '(未命名)');
  if (book.author) lines.push(`作者：${book.author}`);
  // kind 规则常命中多个 meta（分类/状态/更新时间），Legado 用换行拼接，这里换成「 / 」更好读
  if (book.kind) lines.push(`分类：${String(book.kind).split('\n').map((s) => s.trim()).filter(Boolean).join(' / ')}`);
  if (book.sourceName) lines.push(`来源：${book.sourceName}`);
  if (book.bookUrl) lines.push(`原书地址：${book.bookUrl}`);
  let s = lines.join('\n');
  if (o.includeIntro && book.intro) {
    s += `\n\n【简介】\n${normalizeText(book.intro, '\n')}`;
  }
  return s;
}

/** 目录文本 */
function buildToc(entries, o) {
  if (!o.includeToc) return '';
  const lines = entries.map((e) => {
    const title = fillTemplate(o.chapterTitle, { index: e.index + 1, name: e.name, i: e.index });
    return e.isVolume ? `\n${e.name}` : `  ${title}`;
  });
  return `【目录】\n${lines.join('\n')}`;
}

/**
 * 去掉正文首行的重复章名。
 * 下载器把章节名写在章节文件第一行（便于人工检视），导出时标题由模板生成，
 * 若不剔除就会出现「第1章 第1章」。
 */
function stripLeadingTitle(body, name) {
  if (!name) return body;
  const nl = body.indexOf('\n');
  const first = (nl < 0 ? body : body.slice(0, nl)).trim();
  if (!first) return body;
  if (first === String(name).trim()) {
    return nl < 0 ? '' : body.slice(nl + 1).replace(/^\n+/, '');
  }
  return body;
}

/**
 * 把 storage 读出的章节组装成一本书的文本。
 * @param {object} book 书架条目
 * @param {Array} toc 目录数组
 * @param {(index:number)=>string|null} getChapter
 * @param {object} o 已归一化的选项
 * @returns {{info:string, chapters:Array<{index,name,isVolume,title,body}>, volumeGroups:Array}}
 */
function assemble(book, toc, getChapter, o) {
  const chapters = [];
  for (const ch of toc) {
    const raw = getChapter(ch.index);
    // 卷条目标题（「第一卷 xxx」）在书源目录里通常没有自己的正文，它只提供卷名，
    // 必须保留，否则 volume 布局永远分不出卷。
    if (raw == null) {
      if (ch.isVolume) {
        chapters.push({
          index: ch.index,
          name: ch.name || '',
          isVolume: true,
          title: '',
          body: '',
        });
      }
      continue;
    }
    let body = normalizeText(raw, '\n');
    if (!body) {
      if (ch.isVolume) chapters.push({ index: ch.index, name: ch.name || '', isVolume: true, title: '', body: '' });
      continue;
    }
    body = stripLeadingTitle(body, ch.name);
    if (!body) {
      if (ch.isVolume) chapters.push({ index: ch.index, name: ch.name || '', isVolume: true, title: '', body: '' });
      continue;
    }
    const title = fillTemplate(o.chapterTitle, {
      index: ch.index + 1,
      name: ch.name || '',
      i: ch.index,
    });
    chapters.push({ index: ch.index, name: ch.name || '', isVolume: !!ch.isVolume, title, body });
  }

  // 按卷分组：isVolume 的条目作为其后章节的卷名
  const volumeGroups = [];
  let cur = { name: '', items: [] };
  for (const c of chapters) {
    if (c.isVolume) {
      if (cur.items.length || cur.name) volumeGroups.push(cur);
      cur = { name: c.name, items: [] };
    } else {
      cur.items.push(c);
    }
  }
  if (cur.items.length || cur.name) volumeGroups.push(cur);

  const info = [buildHeader(book, o), buildToc(chapters, o)].filter(Boolean).join('\n\n');
  return { info, chapters, volumeGroups };
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

/**
 * 导出为 TXT。
 *
 * @param {object} args
 * @param {object} args.book      书架条目（需含 name/bookId 等）
 * @param {Array}  args.toc       目录数组
 * @param {(index:number)=>string|null} args.getChapter 读章节正文
 * @param {string} args.outDir    输出目录
 * @param {object} [args.options] 见 DEFAULTS
 * @returns {{files:Array<{path:string,bytes:number,chapters:number}>, chapters:number, missing:number, bytes:number, layout:string}}
 */
function exportTxt(args) {
  const { book, toc, getChapter, outDir } = args;
  if (!outDir) throw new Error('exportTxt 需要 outDir');
  const o = normalizeOptions(args.options || {});
  const { info, chapters, volumeGroups } = assemble(book, toc, getChapter, o);
  const realChapters = chapters.filter((c) => !c.isVolume);
  if (!realChapters.length) throw new Error('没有可导出的章节（可能都未下载）');

  const missing = toc.filter((c) => !c.isVolume).length - realChapters.length;
  const files = [];
  const emit = (file, text, n) => {
    const bytes = writeEncoded(file, text, o);
    files.push({ path: file, bytes, chapters: n });
  };
  const bookName = sanitize(book.name || '未命名');

  if (o.layout === 'single') {
    // 全书一个文件：卷标作为分隔行，章与章之间空两行
    const parts = [info];
    for (const c of chapters) {
      if (c.isVolume) {
        if (c.name) parts.push(`【${c.name}】`);
        continue;
      }
      parts.push(`${c.title}\n\n${c.body}`);
    }
    const text = parts.filter(Boolean).join('\n\n\n');
    const fileName = `${sanitize(fillTemplate(o.fileName, { name: bookName }))}.txt`;
    emit(path.join(outDir, fileName), text, realChapters.length);
  } else if (o.layout === 'chapter') {
    const sub = path.join(outDir, sanitize(fillTemplate(o.dirName, { name: bookName })));
    if (o.includeHeader || o.includeToc) {
      emit(path.join(sub, '__书籍信息.txt'), info || bookName, 0);
    }
    for (const c of realChapters) {
      const num = String(c.index + 1).padStart(o.pad, '0');
      const fn = `${sanitize(fillTemplate(o.fileNameTemplate, { index: num, name: c.name || c.title, i: c.index }))}.txt`;
      emit(path.join(sub, fn), `${c.title}\n\n${c.body}`, 1);
    }
  } else {
    const sub = path.join(outDir, sanitize(fillTemplate(o.dirName, { name: bookName })));
    if (o.includeHeader || o.includeToc) {
      emit(path.join(sub, '__书籍信息.txt'), info || bookName, 0);
    }
    const named = volumeGroups.filter((g) => g.items.length);
    if (named.length <= 1) {
      // 没有真正的分卷，退化成单文件（与 single 同构，但写进书名目录）
      const parts = [info];
      for (const c of realChapters) parts.push(`${c.title}\n\n${c.body}`);
      emit(path.join(sub, `${bookName}.txt`), parts.filter(Boolean).join('\n\n\n'), realChapters.length);
    } else {
      named.forEach((g, gi) => {
        const volName = g.name ? `${String(gi + 1).padStart(2, '0')}-${sanitize(g.name)}` : String(gi + 1).padStart(2, '0');
        const parts = [`${bookName}\n${g.name || `第 ${gi + 1} 卷`}`];
        for (const c of g.items) parts.push(`${c.title}\n\n${c.body}`);
        emit(path.join(sub, `${sanitize(volName)}.txt`), parts.join('\n\n\n'), g.items.length);
      });
    }
  }

  return {
    files,
    chapters: realChapters.length,
    missing,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    layout: o.layout,
  };
}

/**
 * 批量导出整本书架。
 * @returns {Promise<Array<{bookId, name, ok, error?, result?}>>}
 */
async function exportLibrary(library, outDir, options = {}, { onlyBookIds = null } = {}) {
  const out = [];
  for (const book of library.books()) {
    if (onlyBookIds && !onlyBookIds.includes(book.id)) continue;
    try {
      const toc = library.toc(book.id);
      if (!toc.length) {
        out.push({ bookId: book.id, name: book.name, ok: false, error: '没有目录' });
        continue;
      }
      const getChapter = (i) => library.chapter(book.id, i);
      const res = exportTxt({
        book: { ...book, sourceName: book.sourceName },
        toc,
        getChapter,
        outDir: path.join(outDir, sanitize(book.name || '未命名')),
        options,
      });
      out.push({ bookId: book.id, name: book.name, ok: true, result: res });
    } catch (e) {
      out.push({ bookId: book.id, name: book.name, ok: false, error: e.message });
    }
  }
  return out;
}

module.exports = { exportTxt, exportLibrary, normalizeOptions, normalizeText, sanitize, DEFAULTS, EOL_MAP };
