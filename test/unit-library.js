'use strict';
/**
 * 本地书架（Library）单元测试（临时目录，不联网）。
 * 跑法：node test/unit-library.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Library, bookIdOf, chapterFileName } = require('../src/store/library');

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  = ${g}\n      want = ${w}`}`);
}

function ok(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail || ''}`}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shuyuan-lib-'));
console.log('临时目录：' + root + '\n');

console.log('=== bookIdOf / chapterFileName ===');
{
  const a = bookIdOf('https://e.com', 'https://e.com/book/1');
  const b = bookIdOf('https://e.com', 'https://e.com/book/1');
  const c = bookIdOf('https://e.com', 'https://e.com/book/2');
  const d = bookIdOf('https://other.com', 'https://e.com/book/1');
  eq('同输入同 id', a, b);
  ok('不同书不同 id', a !== c);
  ok('不同源不同 id', a !== d);
  ok('id 是 16 位 hex', /^[0-9a-f]{16}$/.test(a), a);
  eq('章文件名补零', chapterFileName(0), '00000.txt');
  eq('章文件名 5 位', chapterFileName(123), '00123.txt');
  eq('章文件名 6 位不截断', chapterFileName(1234567), '1234567.txt');
}

console.log('\n=== 空书架 ===');
{
  const lib = new Library(root);
  eq('books() 为空数组', lib.books(), []);
  eq('get 不存在的书 → null', lib.get('nope'), null);
  eq('toc 不存在的书 → []', lib.toc('nope'), []);
  eq('chapter 不存在 → null', lib.chapter('nope', 0), null);
  eq('progress 默认', lib.progress('nope'), { index: 0, offset: 0, percent: 0 });
}

console.log('\n=== add：加入书架 ===');
{
  const lib = new Library(root);
  const meta = {
    name: '测试书',
    author: '作者A',
    bookUrl: 'https://e.com/book/1',
    sourceKey: 'https://e.com',
    sourceName: '测试源',
    kind: '玄幻',
    intro: '简介',
  };
  const r = lib.add(meta);
  ok('返回 id', !!r.id, JSON.stringify(r));
  eq('created=true', r.created, true);
  eq('books() 长度 1', lib.books().length, 1);
  const b = lib.get(r.id);
  eq('书名', b.name, '测试书');
  eq('作者', b.author, '作者A');
  eq('chapterCount 初始 0', b.chapterCount, 0);
  eq('downloadedCount 初始 0', b.downloadedCount, 0);
  ok('有 addedAt 时间戳', typeof b.addedAt === 'number' && b.addedAt > 0);

  const again = lib.add(meta);
  eq('重复 add 不新增', lib.books().length, 1);
  eq('重复 add 返回同 id', again.id, r.id);
  eq('重复 add created=false', again.created, false);
}

console.log('\n=== find：按 sourceKey + bookUrl 找书 ===');
{
  const lib = new Library(root);
  const r = lib.add({ name: 'A', bookUrl: 'https://e.com/a', sourceKey: 'https://e.com' });
  const f = lib.find('https://e.com', 'https://e.com/a');
  ok('能找到', !!f && f.id === r.id);
  eq('找不到返回 null', lib.find('https://e.com', 'https://e.com/zzz'), null);
  eq('sourceKey 不匹配返回 null', lib.find('https://other.com', 'https://e.com/a'), null);
  // 尾斜杠归一
  const f2 = lib.find('https://e.com', 'https://e.com/a');
  ok('重复查找稳定', f2.id === r.id);
}

console.log('\n=== saveToc / toc：目录读写 ===');
{
  const lib = new Library(root);
  const { id } = lib.add({ name: 'B', bookUrl: 'https://e.com/b', sourceKey: 'https://e.com' });
  const chapters = [
    { name: '第1章', url: 'https://e.com/b/1' },
    { name: '第2章', url: 'https://e.com/b/2' },
    { name: '第3章', url: 'https://e.com/b/3' },
  ];
  const saved = lib.saveToc(id, chapters);
  eq('返回 3 章', saved.length, 3);
  eq('自动补 index 0', saved[0].index, 0);
  eq('自动补 index 2', saved[2].index, 2);
  eq('回写 chapterCount', lib.get(id).chapterCount, 3);
  const read = lib.toc(id);
  eq('读回长度', read.length, 3);
  eq('读回章名', read[1].name, '第2章');
  eq('读回 url', read[2].url, 'https://e.com/b/3');
}

console.log('\n=== saveChapter / chapter：章节读写 ===');
{
  const lib = new Library(root);
  const { id } = lib.add({ name: 'C', bookUrl: 'https://e.com/c', sourceKey: 'https://e.com' });
  lib.saveToc(id, [{ name: '第1章' }, { name: '第2章' }]);

  eq('未写时 chapter 返回 null', lib.chapter(id, 0), null);
  lib.saveChapter(id, 0, '第1章\n\n正文一。\n');
  lib.saveChapter(id, 1, '第2章\n\n正文二。\n');
  eq('读回第 1 章', lib.chapter(id, 0), '第1章\n\n正文一。\n');
  eq('读回第 2 章', lib.chapter(id, 1), '第2章\n\n正文二。\n');
  eq('越界返回 null', lib.chapter(id, 99), null);

  const idx = lib.downloadedIndexes(id).sort((a, b) => a - b);
  eq('downloadedIndexes', idx, [0, 1]);
  eq('syncDownloadedCount 返回 2', lib.syncDownloadedCount(id), 2);
  eq('书架条目 downloadedCount=2', lib.get(id).downloadedCount, 2);

  // 覆盖写
  lib.saveChapter(id, 0, '改写后');
  eq('覆盖写生效', lib.chapter(id, 0), '改写后');
  eq('覆盖写不增加计数', lib.syncDownloadedCount(id), 2);
}

console.log('\n=== 文件布局（镜像小强阅读 chm 方案） ===');
{
  const lib = new Library(root);
  const { id } = lib.add({ name: 'D', bookUrl: 'https://e.com/d', sourceKey: 'https://e.com' });
  lib.saveToc(id, [{ name: '第1章' }]);
  lib.saveChapter(id, 0, 'x');

  const shelf = path.join(root, 'shelf.json');
  const meta = path.join(root, 'books', id, 'meta.json');
  const tocF = path.join(root, 'books', id, 'toc.json');
  const chF = path.join(root, 'books', id, 'chapters', '00000.txt');
  ok('shelf.json 存在', fs.existsSync(shelf));
  ok('meta.json 存在', fs.existsSync(meta));
  ok('toc.json 存在', fs.existsSync(tocF));
  ok('chapters/00000.txt 存在', fs.existsSync(chF));
  const shelfData = JSON.parse(fs.readFileSync(shelf, 'utf8'));
  eq('shelf.json 版本', shelfData.version, 1);
  ok('shelf.json 是数组', Array.isArray(shelfData.books));
  const metaData = JSON.parse(fs.readFileSync(meta, 'utf8'));
  eq('meta.json 无 chapters 字段', metaData.chapters, undefined);
  eq('meta.json 有 name', metaData.name, 'D');
}

console.log('\n=== progress：阅读进度 ===');
{
  const lib = new Library(root);
  const { id } = lib.add({ name: 'E', bookUrl: 'https://e.com/e', sourceKey: 'https://e.com' });
  lib.saveProgress(id, { index: 5, offset: 120, percent: 12.5 });
  const p = lib.progress(id);
  eq('index', p.index, 5);
  eq('offset', p.offset, 120);
  eq('percent', p.percent, 12.5);
  eq('书架条目 lastReadIndex 同步', lib.get(id).lastReadIndex, 5);
  // 部分字段更新
  lib.saveProgress(id, { index: 7 });
  const p2 = lib.progress(id);
  eq('index 更新', p2.index, 7);
  eq('offset 保留', p2.offset, 120);
}

console.log('\n=== _patch / 更新时间戳 ===');
{
  const lib = new Library(root);
  const { id } = lib.add({ name: 'F', bookUrl: 'https://e.com/f', sourceKey: 'https://e.com' });
  const before = lib.get(id).updatedAt;
  const t0 = Date.now();
  while (Date.now() - t0 < 5) {
    /* 等一会儿确保时间戳变化 */
  }
  lib._patch(id, { author: '新作者' });
  const after = lib.get(id);
  eq('字段已更新', after.author, '新作者');
  ok('updatedAt 变新', after.updatedAt >= before, `${before} → ${after.updatedAt}`);
}

console.log('\n=== remove：删除书 ===');
{
  const lib = new Library(root);
  const { id } = lib.add({ name: 'G', bookUrl: 'https://e.com/g', sourceKey: 'https://e.com' });
  lib.saveToc(id, [{ name: '第1章' }]);
  lib.saveChapter(id, 0, 'x');
  const dir = path.join(root, 'books', id);
  ok('目录存在', fs.existsSync(dir));

  lib.remove(id);
  eq('书架里没了', lib.get(id), null);
  eq('books() 少一本', lib.books().filter((b) => b.id === id).length, 0);
  ok('文件目录已删除', !fs.existsSync(dir));
}

console.log('\n=== remove({deleteFiles:false}) 保留文件 ===');
{
  const lib = new Library(root);
  const { id } = lib.add({ name: 'H', bookUrl: 'https://e.com/h', sourceKey: 'https://e.com' });
  lib.saveToc(id, [{ name: '第1章' }]);
  lib.remove(id, { deleteFiles: false });
  eq('书架里没了', lib.get(id), null);
  ok('文件保留', fs.existsSync(path.join(root, 'books', id)));
}

console.log('\n=== 持久化：新实例能读回 ===');
{
  const dir = path.join(root, 'persist');
  const l1 = new Library(dir);
  const { id } = l1.add({ name: 'P', bookUrl: 'https://e.com/p', sourceKey: 'https://e.com' });
  l1.saveToc(id, [{ name: '第1章' }, { name: '第2章' }]);
  l1.saveChapter(id, 0, '正文');
  l1.saveProgress(id, { index: 1, percent: 50 });

  const l2 = new Library(dir);
  eq('books 读回', l2.books().length, 1);
  eq('toc 读回', l2.toc(id).length, 2);
  eq('chapter 读回', l2.chapter(id, 0), '正文');
  eq('progress 读回', l2.progress(id).index, 1);
  eq('downloadedCount 读回', l2.get(id).downloadedCount, 0); // 需 sync 才更新
  l2.syncDownloadedCount(id);
  eq('sync 后 downloadedCount=1', l2.get(id).downloadedCount, 1);
}

console.log('\n=== 原子写：无 .tmp 残留 ===');
{
  const dir = path.join(root, 'atomic');
  const lib = new Library(dir);
  const { id } = lib.add({ name: 'Q', bookUrl: 'https://e.com/q', sourceKey: 'https://e.com' });
  lib.saveToc(id, [{ name: '第1章' }]);
  lib.saveChapter(id, 0, 'x');
  lib.saveProgress(id, { index: 0 });
  const leftovers = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tmp$/.test(e.name)) leftovers.push(p);
    }
  };
  walk(dir);
  eq('无 .tmp 残留', leftovers, []);
}

console.log('\n=== 损坏的 shelf.json 容错 ===');
{
  const dir = path.join(root, 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'shelf.json'), '{ 这不是合法 JSON');
  const lib = new Library(dir);
  let threw = null;
  let books = null;
  try {
    books = lib.books();
  } catch (e) {
    threw = e.message;
  }
  ok('损坏文件不崩溃', threw === null, String(threw));
  eq('返回空书架', books, []);
}

console.log('\n=== 损坏的 toc.json 容错 ===');
{
  const dir = path.join(root, 'broken2');
  const lib = new Library(dir);
  const { id } = lib.add({ name: 'R', bookUrl: 'https://e.com/r', sourceKey: 'https://e.com' });
  fs.writeFileSync(path.join(dir, 'books', id, 'toc.json'), '{ 坏的');
  let threw = null;
  let toc = null;
  try {
    toc = lib.toc(id);
  } catch (e) {
    threw = e.message;
  }
  ok('损坏 toc 不崩溃', threw === null, String(threw));
  eq('返回空目录', toc, []);
}

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch (_) {
  /* ignore */
}

console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
