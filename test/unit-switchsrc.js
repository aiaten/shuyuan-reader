'use strict';
/**
 * 换源单测（不联网）。
 *
 * 覆盖 App.changeSource / App.sourceCandidates 的纯编排逻辑：
 *   1. sourceCandidates 的候选筛选、排除当前源、字段形状
 *   2. changeSource 的定位、进度迁移、旧条目去留、正文迁移开关
 *   3. 失败路径必须「要么全成、要么保持原样」（半成品回滚）
 *
 * 网络全部用桩替换：SourceEngine 的 search 与 downloader.addBook。
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * `src/app.js` 是**模块加载时**就 `const { SourceEngine } = require('./engine/source')` 解构的
 * （src/app.js:12），之后在 332/635/777 行直接用那个局部绑定。所以运行时改
 * `require('../src/engine/source').SourceEngine` 对已经加载的 app 没有任何影响——
 * 桩必须在 app 被 require **之前**装好。
 *
 * 做法：先 require engine 模块，把它导出的 SourceEngine 换成可编程的桩，再 require app。
 * 这样 app 在第 12 行解构到的就是桩。
 */
const engineMod = require('../src/engine/source');

/** 当前生效的桩配置 */
const _stub = { list: [], calls: 0, lastKeyword: null };

function StubSourceEngine(source, opts) {
  this.source = source;
  this.opts = opts;
}
StubSourceEngine.prototype.search = async function (kw) {
  _stub.calls++;
  _stub.lastKeyword = kw;
  return _stub.list;
};
StubSourceEngine.prototype.bookInfo = async function () { return { tocUrl: '' }; };
StubSourceEngine.prototype.toc = async function () { return []; };

engineMod.SourceEngine = StubSourceEngine;

const { App } = require('../src/app');

let pass = 0, fail = 0;
async function at(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

/** 往临时 dataDir 里塞书源 */
function seedSources(dir, urls) {
  const sdir = path.join(dir, 'sources');
  fs.mkdirSync(sdir, { recursive: true });
  const list = urls.map((u, i) => ({
    bookSourceName: `源${i + 1}`,
    bookSourceUrl: u,
    searchUrl: '/s?q={{key}}',
  }));
  fs.writeFileSync(path.join(sdir, 'sources.json'), JSON.stringify(list, null, 2), 'utf8');
}

/**
 * 造一个确定性的假世界：
 *   - 旧源 old.test 上有《测试书》100 章，已下载若干章，进度停在第 6 章
 *   - 新源 new.test 上有同名书 1430 章
 */
function mkWorld({ oldTotal = 100, newTotal = 1430, downloaded = [], progress = { index: 5, offset: 123, percent: 4.2 } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-unit-'));
  const app = new App({ dataDir: dir });
  seedSources(dir, ['http://old.test', 'http://new.test']);

  const oldBook = { name: '测试书', author: '作者甲', bookUrl: 'http://old.test/book/1', sourceKey: 'http://old.test' };
  const added = app.library.add(oldBook);
  const oldId = added.id;
  app.library.saveToc(oldId, Array.from({ length: oldTotal }, (_, i) => ({ name: `第 ${i + 1} 章`, url: `http://old.test/c/${i}` })));
  for (const i of downloaded) app.library.saveChapter(oldId, i, `第 ${i + 1} 章\n正文 ${i + 1}`);
  app.library.syncDownloadedCount(oldId);
  if (progress) app.library.saveProgress(oldId, progress);

  return { app, dir, oldId, oldTotal, newTotal };
}

/** 设定桩：换源时新源搜索会返回这些条目 */
function setSearchList(list) {
  _stub.list = list;
  _stub.calls = 0;
  return () => { _stub.list = []; };
}

/** 桩掉 downloader.addBook，模拟「新源抓目录成功/失败」 */
function patchAddBook(app, { total, fail = false, name = '测试书' }) {
  app.downloader.addBook = async (source, book) => {
    if (fail) throw new Error('目录页解析为空');
    const r = app.library.add({ ...book, sourceKey: source.bookSourceUrl });
    app.library.saveToc(r.id, Array.from({ length: total }, (_, i) => ({ name: `第 ${i + 1} 章`, url: `${source.bookSourceUrl}/c/${i}` })));
    return { id: r.id, name, chapterCount: total };
  };
}

/** 新源上的同名书（changeSource 用它来定位） */
const MATCH_NEW = [{ name: '测试书', author: '作者甲', bookUrl: 'http://new.test/book/9' }];

(async () => {
  console.log('\n[1] sourceCandidates 候选筛选');

  await at('返回候选且排除当前源', async () => {
    const { app, dir, oldId } = mkWorld();
    const origEvery = app.searchEverywhere.bind(app);
    app.searchEverywhere = async (kw, opts) => ({
      total: (opts.keys || []).length,
      ran: (opts.keys || []).length,
      failed: 0,
      elapsed: 12,
      el: 12,
      sources: (opts.keys || []).map((k) => ({
        key: k, name: k, url: k, ok: true, count: 1, ms: 5, error: '',
        list: [{ name: '测试书', author: '作者甲', bookUrl: `${k}/book/1` }],
      })),
    });
    const r = await app.sourceCandidates(oldId, {});
    assert.ok(Array.isArray(r.candidates), '应有 candidates 数组');
    assert.strictEqual(r.candidates.length, 1, '应只留下新源（当前源被排除）');
    const c = r.candidates[0];
    assert.strictEqual(c.sourceKey, 'http://new.test');
    assert.strictEqual(c.name, '测试书');
    assert.ok(!('chapterCount' in c), '候选不应带 chapterCount（后端刻意不填）');
    assert.ok(c.score >= 100, `书名+作者完全一致应为满分，实得 ${c.score}`);
    assert.strictEqual(c.matchedBy, 'name+author');
    app.searchEverywhere = origEvery;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('excludeCurrent=false 时把当前源也搜进去', async () => {
    const { app, dir, oldId } = mkWorld();
    const origEvery = app.searchEverywhere.bind(app);
    let seenKeys = null;
    app.searchEverywhere = async (kw, opts) => {
      seenKeys = opts.keys;
      return { total: 0, ran: 0, failed: 0, elapsed: 1, el: 1, sources: [] };
    };
    await app.sourceCandidates(oldId, { excludeCurrent: false });
    assert.ok(seenKeys.includes('http://old.test'), '应包含当前源');
    assert.ok(seenKeys.includes('http://new.test'), '也应包含新源');
    app.searchEverywhere = origEvery;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('书不存在 → 明确报错', async () => {
    const { app, dir } = mkWorld();
    await assert.rejects(() => app.sourceCandidates('no-such-book', {}), /书架里没有这本书/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('畸形 bookUrl 被标记为可疑（速读谷式路径段重复）', async () => {
    const { app, dir, oldId } = mkWorld();
    const origEvery = app.searchEverywhere.bind(app);
    app.searchEverywhere = async (kw, opts) => ({
      total: 2, ran: 2, failed: 0, elapsed: 5, el: 5,
      sources: [
        // 实测样本：路径段 /13/ 重复出现
        { key: 'http://suduguu.com', name: '速读谷', url: 'http://suduguu.com', ok: true, count: 1, ms: 5, error: '', list: [{ name: '测试书', author: '作者甲', bookUrl: 'https://suduguu.com/13/211991/13/211991.html' }] },
        { key: 'http://good.test', name: '正常源', url: 'http://good.test', ok: true, count: 1, ms: 5, error: '', list: [{ name: '测试书', author: '作者甲', bookUrl: 'http://good.test/book/9' }] },
      ],
    });
    const r = await app.sourceCandidates(oldId, {});
    assert.strictEqual(r.candidates.length, 2);
    const bad = r.candidates.find((c) => /suduguu/.test(c.sourceKey));
    const good = r.candidates.find((c) => /good\.test/.test(c.sourceKey));
    assert.strictEqual(bad.suspicious, true, '畸形地址应标记可疑');
    assert.ok(bad.suspiciousReason, '应给出人话原因');
    assert.strictEqual(good.suspicious, false, '正常地址不应被误标');
    assert.strictEqual(good.suspiciousReason, '');
    // 同分时可疑项应排到后面
    assert.strictEqual(r.candidates[0].sourceKey, good.sourceKey, '正常源应排在可疑源之前');
    app.searchEverywhere = origEvery;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('urlLooksBroken 各形态判定', async () => {
    const { app, dir } = mkWorld();
    const yes = [
      ['', '空地址'],
      ['not-a-url', '非 http'],
      ['http:///book/1', '缺域名'],
      ['https://s.com/a/a/x.html', '路径段连续重复'],
      ['https://s.com/13/2/13/x.html', '数字段重复'],
      ['https://s.com/' + 'a/'.repeat(9) + 'x.html', '层级过深'],
      ['http://s.com/a b/x.html', '含空白'],
      // 搜索页冒充书籍详情页：实测「得奇小说」对《诡秘之主》就返回这种 bookUrl
      ['https://www.deqixss.com/modules/article/search.php', '路径末段是搜索脚本'],
      ['https://www.88xiaoshuo.net/search.html', '路径末段是搜索页'],
      ['https://s.com/book/search', '末段 search'],
      ['https://x.com/list.php?wd=test', '查询串带搜索词 wd'],
      ['https://x.com/book/1.html?keyword=foo', '查询串带搜索词 keyword'],
      ['https://x.com/s.php?q=abc', '查询串带搜索词 q'],
    ];
    for (const [u, why] of yes) {
      assert.ok(app.urlLooksBroken(u) !== '', `应判为可疑：${why} (${u})`);
    }
    const no = [
      'http://good.test/book/9',
      'https://www.zuizhong.net/shu13542/',
      'https://m.zdzn.net/book/12345.html',
      'http://a.b/c/d/e/f',
      // 不能把正常的详情页/阅读页误判成搜索页
      'https://www.biquge78.cc/go/8814/',
      'http://www.biquge.site/book/85322/',
      'https://www.deqixss.com/modules/article/reader.php?aid=1',
      'https://www.noveltri.com/zh-cn/book/f1721fd949cb2a13.html',
    ];
    for (const u of no) {
      assert.strictEqual(app.urlLooksBroken(u), '', `不应误判：${u}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\n[2] changeSource 正常路径');

  await at('换源成功：进度保留 + 旧条目默认替换 + 章数取自新源', async () => {
    const { app, dir, oldId, newTotal } = mkWorld({ downloaded: [0, 1, 2], progress: { index: 5, offset: 123, percent: 4.2 } });
    const off = setSearchList(MATCH_NEW);
    patchAddBook(app, { total: newTotal });

    const r = await app.changeSource(oldId, 'http://new.test', {});
    assert.strictEqual(r.oldBookId, oldId);
    assert.notStrictEqual(r.bookId, oldId, '新 bookId 应不同');
    assert.strictEqual(r.chapterCount, newTotal, `章数应取新源 ${newTotal}`);
    assert.strictEqual(r.progressKept, true, '原有进度应被保留');
    assert.deepStrictEqual(r.progress, { index: 5, offset: 123, percent: 4.2 }, '进度应原样搬迁');
    assert.strictEqual(r.migratedChapters, 0, '默认不迁移正文');
    assert.strictEqual(r.oldRemoved, true, '默认应替换旧条目');
    assert.strictEqual(r.matchedBy, 'name+author');
    assert.strictEqual(app.library.get(oldId), null, '旧条目应已移除');
    assert.ok(app.library.get(r.bookId), '新条目应存在');
    assert.strictEqual(app.library.progress(r.bookId).index, 5, '新书进度应回读一致');
    off(); fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('keepOld=true 时新旧条目都在', async () => {
    const { app, dir, oldId, newTotal } = mkWorld();
    const off = setSearchList(MATCH_NEW);
    patchAddBook(app, { total: newTotal });
    const r = await app.changeSource(oldId, 'http://new.test', { keepOld: true });
    assert.strictEqual(r.oldRemoved, false);
    assert.ok(app.library.get(oldId), '旧条目应保留');
    assert.ok(app.library.get(r.bookId), '新条目应存在');
    off(); fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('keepChapters=true 按序号搬正文，且报告迁移章数', async () => {
    const { app, dir, oldId } = mkWorld({ downloaded: [0, 1, 2, 3] });
    const off = setSearchList(MATCH_NEW);
    patchAddBook(app, { total: 1430 });
    const r = await app.changeSource(oldId, 'http://new.test', { keepChapters: true });
    assert.strictEqual(r.migratedChapters, 4, '应迁移 4 章');
    assert.strictEqual(app.library.chapter(r.bookId, 0), '第 1 章\n正文 1', '迁移的正文应逐字节一致');
    assert.ok(r.migrationRisk.includes('串章'), '应提示串章风险');
    off(); fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('新源章数更少时，迁移不越界且进度被夹住', async () => {
    const { app, dir, oldId } = mkWorld({ downloaded: [0, 1, 2, 3, 4], progress: { index: 90, offset: 0, percent: 90 } });
    const off = setSearchList(MATCH_NEW);
    patchAddBook(app, { total: 3 });
    const r = await app.changeSource(oldId, 'http://new.test', { keepChapters: true });
    assert.strictEqual(r.chapterCount, 3);
    assert.strictEqual(r.migratedChapters, 3, '只搬得下 3 章');
    assert.strictEqual(r.progress.index, 2, '进度应夹到末章 index=2');
    off(); fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\n[3] changeSource 失败路径（必须保持原样）');

  await at('新源搜不到 → 报错且旧书完好', async () => {
    const { app, dir, oldId } = mkWorld({ downloaded: [0, 1] });
    const off = setSearchList([{ name: '完全不相干的书', author: '别人', bookUrl: 'http://new.test/x' }]);
    patchAddBook(app, { total: 10 });
    await assert.rejects(() => app.changeSource(oldId, 'http://new.test', {}), /没有找到《测试书》/);
    assert.ok(app.library.get(oldId), '旧书应完好');
    assert.strictEqual(app.library.books().length, 1, '不应留下任何新条目');
    off(); fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('抓目录失败 → 回滚半成品，旧书完好', async () => {
    const { app, dir, oldId } = mkWorld({ downloaded: [0, 1] });
    const off = setSearchList(MATCH_NEW);
    patchAddBook(app, { total: 0, fail: true });
    await assert.rejects(() => app.changeSource(oldId, 'http://new.test', {}), /抓不到目录/);
    assert.ok(app.library.get(oldId), '旧书应完好');
    assert.strictEqual(app.library.books().length, 1, '半成品条目必须被回滚，书架上不能多出一条打不开的书');
    off(); fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('源不存在 → 明确报错', async () => {
    const { app, dir, oldId } = mkWorld();
    await assert.rejects(() => app.changeSource(oldId, 'http://nope.test', {}), /找不到书源/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('换到当前已在的源 → 明确报错', async () => {
    const { app, dir, oldId } = mkWorld();
    await assert.rejects(() => app.changeSource(oldId, 'http://old.test', {}), /已经在「源1」上了/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('旧书不存在 → 明确报错', async () => {
    const { app, dir } = mkWorld();
    await assert.rejects(() => app.changeSource('no-such-book', 'http://new.test', {}), /书架里没有这本书/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\n[4] 与懒加载窗口的衔接');

  await at('download 为真时从保留的进度位置往后补，而不是从第 0 章开始', async () => {
    const { app, dir, oldId } = mkWorld({ progress: { index: 5, offset: 0, percent: 4.2 } });
    const off = setSearchList(MATCH_NEW);
    patchAddBook(app, { total: 1430 });
    let askedIndex = null;
    app.downloadWindow = async (id, index, opts) => { askedIndex = index; return { done: 10, skipped: 0, failed: 0 }; };
    const r = await app.changeSource(oldId, 'http://new.test', { download: true });
    assert.strictEqual(askedIndex, 5, `补下应从进度 index=5 继续，实得 ${askedIndex}`);
    assert.ok(r.download, '应返回下载结果');
    off(); fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('download="full" 走整本下载', async () => {
    const { app, dir, oldId } = mkWorld();
    const off = setSearchList(MATCH_NEW);
    patchAddBook(app, { total: 1430 });
    let full = false;
    app.downloader.downloadChapters = async (src, id, opts) => { full = true; return { done: 1430 }; };
    const r = await app.changeSource(oldId, 'http://new.test', { download: 'full' });
    assert.strictEqual(full, true, '应走 downloadChapters');
    assert.strictEqual(r.download.done, 1430);
    off(); fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n换源单测：通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
