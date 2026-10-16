'use strict';
/**
 * 懒加载滑动窗口单测（不联网）。
 *
 * 覆盖三块纯逻辑：
 *   1. windowFor 的窗口计算（加入书架 / 读到第 N 章 / 边界与跳章）
 *   2. Downloader.downloadWindow 的「已下载即跳过」与「全跳过 → empty」
 *   3. App.downloadWindow 的防重入（同书并发只跑一个）
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { windowFor, INITIAL_WINDOW, READAHEAD_WINDOW } = require('../src/store/downloader');
const { App } = require('../src/app');

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('异步用例请用 at()');
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    fail++;
  }
}
async function at(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

console.log('\n[1] windowFor 窗口计算');

t('常量符合需求：初始 10 章 / 预读 10 章', () => {
  assert.strictEqual(INITIAL_WINDOW, 10, 'INITIAL_WINDOW 应为 10');
  assert.strictEqual(READAHEAD_WINDOW, 10, 'READAHEAD_WINDOW 应为 10');
});

t('加入书架（index=0）→ 第 1-10 章', () => {
  assert.deepStrictEqual(windowFor(0, 100), { from: 0, to: 9 });
});

t('读到第 21 章（index=20）→ 补第 22-31 章', () => {
  assert.deepStrictEqual(windowFor(20, 100), { from: 21, to: 30 });
});

t('读到第 1 章（index=1）→ 补第 2-11 章', () => {
  assert.deepStrictEqual(windowFor(1, 100), { from: 2, to: 11 });
});

t('短篇：总章数 5 < 初始窗口 → 只到末章，不越界', () => {
  assert.deepStrictEqual(windowFor(0, 5), { from: 0, to: 4 });
});

t('读到末章 → from > to（空区间）', () => {
  const w = windowFor(99, 100);
  assert.ok(w.from > w.to, `期望空区间，实得 ${JSON.stringify(w)}`);
});

t('接近末章时窗口被裁剪到末章', () => {
  assert.deepStrictEqual(windowFor(95, 100), { from: 96, to: 99 });
});

t('空书（total=0）→ 空区间', () => {
  const w = windowFor(0, 0);
  assert.ok(w.from > w.to);
});

t('总章数 1 → 只有第 1 章', () => {
  assert.deepStrictEqual(windowFor(0, 1), { from: 0, to: 0 });
});

t('跳章不补前面（index=500 → 只补 501 起，不回填 10..499）', () => {
  const w = windowFor(500, 1000);
  assert.strictEqual(w.from, 501, '不应回填前面缺的章');
  assert.strictEqual(w.to, 510);
});

t('非法入参（NaN / 负数）不抛异常', () => {
  assert.ok(windowFor(NaN, 100).from >= 0);
  assert.ok(windowFor(-5, 100).from >= 0);
  assert.ok(windowFor(0, NaN).from > windowFor(0, NaN).to);
});

t('可覆盖窗口大小', () => {
  assert.deepStrictEqual(windowFor(0, 100, { initial: 3 }), { from: 0, to: 2 });
  assert.deepStrictEqual(windowFor(10, 100, { window: 5 }), { from: 11, to: 15 });
});

console.log('\n[2] Downloader.downloadWindow 跳过已下载');

/** 往临时 dataDir 里塞一个书源（SourceStore 是纯 JSON 文件，直接写最快） */
function seedSource(dir, url) {
  const sdir = path.join(dir, 'sources');
  fs.mkdirSync(sdir, { recursive: true });
  const file = path.join(sdir, 'sources.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  list.push({ bookSourceName: '测试源', bookSourceUrl: url, searchUrl: '/s?q={{key}}' });
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
}

/** 造一本假书：toc 有 total 章，chapter 文件按 holes 决定哪些已存在 */
function mkFake(total, holes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-unit-'));
  const app = new App({ dataDir: dir });
  seedSource(dir, 'http://x.test');
  const book = { name: '测试书', author: 't', bookUrl: 'http://x.test/book/1', sourceKey: 'http://x.test' };
  const r = app.library.add(book);
  const toc = Array.from({ length: total }, (_, i) => ({ name: `第 ${i + 1} 章`, url: `http://x.test/c/${i}` }));
  app.library.saveToc(r.id, toc);
  for (let i = 0; i < total; i++) {
    if (!holes.includes(i)) app.library.saveChapter(r.id, i, `第 ${i + 1} 章\n正文 ${i + 1}`);
  }
  return { app, dir, bookId: r.id, total };
}

(async () => {
  await at('整段已下载 → empty=true 且不发网络请求', async () => {
    const { app, dir, bookId } = mkFake(20, []);
    let called = 0;
    app.downloader.downloadChapters = async () => { called++; return {}; };
    const r = await app.downloadWindow(bookId, 0, {});
    assert.strictEqual(r.empty, true, '应报告 empty');
    assert.strictEqual(called, 0, '全已下载时不应触发任何下载');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('部分缺口 → 只下缺的那几章', async () => {
    // 前 10 章里第 3、5 章缺失
    const { app, dir, bookId } = mkFake(30, [2, 4]);
    let seen = null;
    app.downloader.downloadChapters = async (src, id, opts) => {
      seen = opts; return { done: 2, skipped: 8, failed: 0, from: opts.from, to: opts.to };
    };
    const r = await app.downloadWindow(bookId, 0, {});
    assert.strictEqual(seen.from, 0);
    assert.strictEqual(seen.to, 9);
    assert.strictEqual(r.done, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('并发调用同一本书 → 第二次被防重入拦下', async () => {
    const { app, dir, bookId } = mkFake(50, []);
    let release;
    const gate = new Promise((res) => { release = res; });
    app.downloader.downloadChapters = async (src, id, opts) => {
      await gate;
      return { done: 1, skipped: 0, failed: 0, from: opts.from, to: opts.to };
    };
    const p1 = app.downloadWindow(bookId, 0, {});
    const p2 = app.downloadWindow(bookId, 0, {});
    const r2 = await p2;
    assert.strictEqual(r2.skipped, true, '第二个调用应被跳过');
    release();
    const r1 = await p1;
    // 第一个调用拿到了任务本身（不是被跳过的那份）
    assert.notStrictEqual(r1.skipped, true, '第一个调用不应被当成重入');
    assert.strictEqual(typeof r1.done, 'number', '第一个调用应返回真实下载结果');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('任务结束后可再次调用（_windowPending 已清理）', async () => {
    const { app, dir, bookId } = mkFake(50, []);
    app.downloader.downloadChapters = async (src, id, opts) => ({ done: 0, skipped: 0, failed: 0, from: opts.from, to: opts.to });
    await app.downloadWindow(bookId, 0, {});
    assert.strictEqual(app.windowBusy(bookId), false, '完成后不应仍标记为 busy');
    const r = await app.downloadWindow(bookId, 0, {});
    assert.notStrictEqual(r.skipped, true, '第二次不应被拦');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('书不存在 → 明确报错', async () => {
    const { app, dir } = mkFake(5, []);
    await assert.rejects(() => app.downloadWindow('no-such-book', 0, {}), /书架里没有这本书/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('addToShelf({download:true}) 只下前 10 章，不下全书', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-unit-'));
    const app = new App({ dataDir: dir });
    // 造一个假书源 + 假目录
    seedSource(dir, 'http://fake.test');
    const key = 'http://fake.test';
    const total = 200;
    app.downloader.addBook = async (src, book) => {
      const r = app.library.add({ ...book, sourceKey: key });
      const toc = Array.from({ length: total }, (_, i) => ({ name: `第 ${i + 1} 章`, url: `http://fake.test/c/${i}` }));
      app.library.saveToc(r.id, toc);
      return { id: r.id, name: book.name, chapterCount: total };
    };
    let asked = null;
    app.downloader.downloadChapters = async (src, id, opts) => {
      asked = opts;
      return { done: 10, skipped: 0, failed: 0, from: opts.from, to: opts.to };
    };
    const r = await app.addToShelf(key, { name: '长篇', author: 'a', bookUrl: 'http://fake.test/b/1' }, { download: true });
    assert.ok(asked, '应触发下载');
    assert.deepStrictEqual(
      { from: asked.from, to: asked.to },
      { from: 0, to: 9 },
      `加书架应只下前 10 章，实得 ${asked.from}-${asked.to}`
    );
    assert.strictEqual(r.download.done, 10);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await at('addToShelf({download:"full"}) 仍可整本下载（导出用）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-unit-'));
    const app = new App({ dataDir: dir });
    seedSource(dir, 'http://fake2.test');
    const key = 'http://fake2.test';
    app.downloader.addBook = async (src, book) => {
      const r = app.library.add({ ...book, sourceKey: key });
      app.library.saveToc(r.id, [{ name: '第 1 章', url: 'u' }, { name: '第 2 章', url: 'u2' }]);
      return { id: r.id, name: book.name, chapterCount: 2 };
    };
    let asked = null;
    app.downloader.downloadChapters = async (src, id, opts) => {
      asked = opts; return { done: 2, skipped: 0, failed: 0 };
    };
    await app.addToShelf(key, { name: '短篇', author: 'a', bookUrl: 'http://fake2.test/b/1' }, { download: 'full' });
    assert.ok(asked, 'full 模式应走 downloadChapters');
    assert.notStrictEqual(asked.from, 0, 'full 模式不该被窗口裁剪');
    assert.notStrictEqual(asked.to, 9, 'full 模式不该被窗口裁剪');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\n[5] 站点错误 stub 页守卫（获取章节内容失败 等）');

  const { looksLikeStubPage } = require('../src/store/downloader');
  const { SourceEngine } = require('../src/engine/source');

  t('stub 判据：错误页文本命中、正常正文不误伤', () => {
    assert.strictEqual(looksLikeStubPage('　　获取章节内容失败'), true, '「获取章节内容失败」应判为 stub');
    assert.strictEqual(looksLikeStubPage('请勿开启浏览器阅读模式，否则将导致章节内容缺失及无法阅读下一章。'), true, '阅读模式提示应判为 stub');
    assert.strictEqual(looksLikeStubPage('{"code":1,"msg":"搜索太频繁，请在 3 秒后再重新搜索","data":""}'), true, '限流提示应判为 stub');
    assert.strictEqual(looksLikeStubPage(''), false, '空串交给空正文分支，不算 stub');
    assert.strictEqual(looksLikeStubPage('这一战之后，他终于明白，所谓失败，不过是重新开始。'), false, '正常短正文不得误伤');
    const long = '他低声说：获取章节内容失败。'.repeat(10); // >120 字 → 不再当 stub
    assert.strictEqual(looksLikeStubPage(long), false, '超长文本不误伤');
  });

  await at('downloadChapters：stub 不落盘、记失败；重试成功才落盘', async () => {
    const { app, dir, bookId } = mkFake(12, [3]);
    const src = app.sources.get('http://x.test');
    const orig = SourceEngine.prototype.content;
    try {
      SourceEngine.prototype.content = async () => ({ text: '　　获取章节内容失败' });
      let r = await app.downloader.downloadChapters(src, bookId, { from: 3, to: 3 });
      assert.strictEqual(r.failed, 1, 'stub 应记为失败');
      assert.strictEqual(r.done, 0);
      assert.strictEqual(app.library.chapter(bookId, 3), null, 'stub 不得写盘');

      SourceEngine.prototype.content = async () => ({ text: '这是真正的正文，长度足够，不会被守卫拦下。' + '句子。'.repeat(30) });
      r = await app.downloader.downloadChapters(src, bookId, { from: 3, to: 3 });
      assert.strictEqual(r.done, 1, '正常正文应成功落盘');
      assert.ok(/真正的正文/.test(app.library.chapter(bookId, 3) || ''));

      // force 重下时站点又回 stub → 记失败且不覆盖已有好正文
      SourceEngine.prototype.content = async () => ({ text: '获取章节内容失败' });
      r = await app.downloader.downloadChapters(src, bookId, { from: 3, to: 3, force: true });
      assert.strictEqual(r.failed, 1, 'force+stub 应记失败');
      assert.ok(/真正的正文/.test(app.library.chapter(bookId, 3) || ''), '旧好正文不能被 stub 覆盖');

      // force + 正常正文 → 覆盖成功（这就是「重新下载」的正路）
      SourceEngine.prototype.content = async () => ({ text: '重下后的新正文。' + '内容。'.repeat(30) });
      r = await app.downloader.downloadChapters(src, bookId, { from: 3, to: 3, force: true });
      assert.strictEqual(r.done, 1);
      assert.ok(/重下后的新正文/.test(app.library.chapter(bookId, 3) || ''), 'force 应覆盖旧文件');

      // 「清洗后只剩标题」的空壳章：首行与目录名一致、剥掉后为空 → 记失败不落盘
      SourceEngine.prototype.content = async () => ({ text: '第 4 章\n\n' });
      r = await app.downloader.downloadChapters(src, bookId, { from: 3, to: 3, force: true });
      assert.strictEqual(r.failed, 1, '只剩标题的空壳章应记失败');
      assert.ok(/重下后的新正文/.test(app.library.chapter(bookId, 3) || ''), '空壳不得覆盖已有好正文');
    } finally {
      SourceEngine.prototype.content = orig;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\n懒加载窗口单测：通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
