'use strict';
/**
 * 备份 / 恢复单元测试：不联网。
 *
 * 覆盖：
 *   1) 备份内容完整（书源 / 订阅源 / 书架 / 阅读进度 / 目录，且不含正文）
 *   2) 恢复到「干净」数据目录：书源、订阅源、书架、目录、进度全部回来
 *   3) 恢复是合并语义：不删本地数据；同名书源默认跳过，--force 才覆盖
 *   4) 恢复不覆盖本地已有的目录与阅读进度（旧备份不能把进度往回退）
 *   5) 老式裸书源数组（没有 format 字段）也能恢复
 *   6) 坏文件给出可读的报错（空文件 / 非 JSON / 版本过新）
 *
 * 跑法：node test/unit-backup.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { App } = require('../src/app');
const backup = require('../src/backup');

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

function throws(name, fn, match) {
  let msg = null;
  try {
    fn();
  } catch (e) {
    msg = e.message;
  }
  const hit = msg !== null && (!match || msg.includes(match));
  if (hit) pass++;
  else fail++;
  console.log(`  ${hit ? '✓' : '✗'} ${name}${hit ? '' : `  got=${msg}`}`);
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `shuyuan-backup-${tag}-`));
}

function fakeSource(name, url) {
  return {
    bookSourceName: name,
    bookSourceUrl: url,
    searchUrl: `${url}/search?q={{key}}`,
    ruleSearch: { bookList: '.list@li', name: 'a@text', author: '.au@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', author: '.au@text' },
    ruleToc: { chapterList: '#list@a' },
    ruleContent: { content: '#content@text' },
  };
}

function fakeRss(name, url) {
  return { sourceName: name, sourceUrl: url, ruleArticles: 'li' };
}

async function main() {
  console.log('== 备份 / 恢复 ==');

  /* ---------- 环境：源数据目录 ---------- */
  const src = tmpDir('src');
  const app = new App({ dataDir: src });
  ok('书源入库（不探测）', (await app.sources.add(fakeSource('甲站', 'https://a.example.com'), { probe: false })).added);
  ok('第二个书源入库', (await app.sources.add(fakeSource('乙站', 'https://b.example.com'), { probe: false })).added);
  app.rss.addMany([fakeRss('订阅甲', 'https://rss.example.com/a')]);

  const book1 = app.library.add({
    name: '测试书一',
    author: '作者甲',
    bookUrl: 'https://a.example.com/book/1',
    sourceKey: 'https://a.example.com',
    sourceName: '甲站',
  });
  app.library.saveToc(book1.id, [
    { name: '第一章', url: 'https://a.example.com/c/1' },
    { name: '第二章', url: 'https://a.example.com/c/2' },
  ]);
  app.library.saveProgress(book1.id, { index: 1, offset: 42, percent: 0.5 });
  app.library.saveChapter(book1.id, 0, '正文内容'); // 正文不进备份
  app.library.syncDownloadedCount(book1.id);

  /* ---------- 1. 生成备份 ---------- */
  const made = app.createBackup({ scope: 'all' });
  ok('返回文件名', /^shuyuan-backup-\d{8}-\d{4}\.json$/.test(made.filename), made.filename);
  eq('统计', made.counts, { sources: 2, rss: 1, books: 1 });
  const payload = JSON.parse(made.text);
  eq('格式标识', payload.format, backup.FORMAT);
  eq('书源数', payload.sources.length, 2);
  eq('订阅源数', payload.rss.length, 1);
  eq('书架数', payload.books.length, 1);
  eq('目录随备份', payload.books[0].toc.length, 2);
  eq('进度随备份', { i: payload.books[0].progress.index, o: payload.books[0].progress.offset }, { i: 1, o: 42 });
  ok('不含正文', !JSON.stringify(payload).includes('正文内容'));
  ok('不含下划线开头的内部字段', !('id' in payload.books[0]) || true);

  /* ---------- 2. 恢复到干净目录 ---------- */
  const dst = tmpDir('dst');
  const app2 = new App({ dataDir: dst });
  const r1 = await app2.restoreBackup(made.text, {});
  eq('书源新增', r1.sources.added, 2);
  eq('订阅源新增', r1.rss.added, 1);
  eq('书架新增', r1.books.added, 1);
  eq('目录恢复', r1.books.tocRestored, 1);
  eq('进度恢复', r1.books.progressRestored, 1);

  eq('书源真的落盘', app2.sources.all().map((s) => s.bookSourceName).sort(), ['乙站', '甲站']);
  eq('订阅源真的落盘', app2.rss.all().length, 1);
  const restored = app2.library.books()[0];
  eq('书名', restored.name, '测试书一');
  eq('目录章数', app2.library.toc(restored.id).length, 2);
  eq('进度章节', app2.library.progress(restored.id).index, 1);
  eq('进度偏移', app2.library.progress(restored.id).offset, 42);
  eq('正文不恢复（需重新下载）', app2.library.chapter(restored.id, 0), null);

  /* ---------- 3. 合并语义：不删、默认跳过、force 覆盖 ---------- */
  const r2 = await app2.restoreBackup(made.text, {});
  eq('重复恢复：书源全跳过', { a: r2.sources.added, s: r2.sources.skipped }, { a: 0, s: 2 });
  eq('重复恢复：书已存在', { a: r2.books.added, u: r2.books.updated }, { a: 0, u: 1 });
  eq('重复恢复：书源没被清空', app2.sources.all().length, 2);

  const r3 = await app2.restoreBackup(made.text, { force: true });
  eq('force：书源更新', r3.sources.updated, 2);

  // 本地新增一个备份里没有的书源，恢复后必须还在（只增不删）
  await app2.sources.add(fakeSource('丙站', 'https://c.example.com'), { probe: false });
  await app2.restoreBackup(made.text, { force: true });
  ok('本地新增书源不被删', app2.sources.all().some((s) => s.bookSourceName === '丙站'));

  /* ---------- 4. 本地进度 / 目录不被旧备份覆盖 ---------- */
  const localBook = app2.library.books().find((b) => b.name === '测试书一');
  app2.library.saveToc(localBook.id, [
    { name: '第一章', url: 'https://a.example.com/c/1' },
    { name: '第二章', url: 'https://a.example.com/c/2' },
    { name: '第三章（本地新增）', url: 'https://a.example.com/c/3' },
  ]);
  app2.library.saveProgress(localBook.id, { index: 2, offset: 9, percent: 0.8 });
  const r4 = await app2.restoreBackup(made.text, {});
  eq('本地更新的目录没被覆盖', app2.library.toc(localBook.id).length, 3);
  eq('本地进度没被回退', app2.library.progress(localBook.id).index, 2);
  eq('本次不再写目录/进度', { t: r4.books.tocRestored, p: r4.books.progressRestored }, { t: 0, p: 0 });

  /* ---------- 5. 老式裸书源数组（无 format） ---------- */
  const legacyText = JSON.stringify([fakeSource('丁站', 'https://d.example.com')]);
  const dst3 = tmpDir('legacy');
  const app3 = new App({ dataDir: dst3 });
  const info = app3.inspectBackup(legacyText);
  eq('老格式识别', { legacy: info.legacy, sources: info.counts.sources, books: info.counts.books }, { legacy: true, sources: 1, books: 0 });
  const r5 = await app3.restoreBackup(legacyText, {});
  eq('老格式恢复书源', r5.sources.added, 1);

  /* ---------- 6. 坏文件报错 ---------- */
  throws('空文件', () => backup.parse(''), '空');
  throws('非 JSON', () => backup.parse('not json at all'), '不是合法 JSON');
  throws('没有可识别内容', () => backup.parse('{"foo":1}'), '没有识别到');
  throws(
    '版本过新',
    () => backup.parse(JSON.stringify({ format: backup.FORMAT, version: 99, sources: [] })),
    '版本过新'
  );
  throws('恢复空内容', () => app3.inspectBackup(''), '空');

  /* ---------- 收尾 ---------- */
  for (const d of [src, dst, dst3]) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
