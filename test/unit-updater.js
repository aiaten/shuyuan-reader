'use strict';
/**
 * 书架「检查更新」单元测试（不联网）。
 *
 * 覆盖：
 *  1. compareToc 的纯比对语义（追加 / 相同 / 中间插入 / 删章 / 重排 / 空目录）
 *  2. checkBook 的成功路径：追加更新写回 toc.json + 书架状态字段
 *  3. checkBook 的「目录有变动」路径：只标记，不覆盖本地目录
 *  4. checkBook 的失败路径：书源缺失 / 抓取异常  记 updateError，不抛
 *  5. checkShelfUpdates 的汇总与并发（只查指定 bookIds）
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Library } = require('../src/store/library');
const { compareToc, checkBook, checkShelfUpdates } = require('../src/store/updater');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('异步用例请用 at()');
    console.log(`  [OK] ${name}`);
    pass++;
  } catch (e) {
    console.log(`  [FAIL] ${name}\n      ${e.message}`);
    fail++;
  }
}
async function at(name, fn) {
  try {
    await fn();
    console.log(`  [OK] ${name}`);
    pass++;
  } catch (e) {
    console.log(`  [FAIL] ${name}\n      ${e.message}`);
    fail++;
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shuyuan-upd-'));
console.log('临时目录：' + root);

/** 造一章 */
const ch = (i, name) => ({ name: name || `第${i}章`, url: `http://x.test/c/${i}` });
const toc = (n, from = 1) => Array.from({ length: n }, (_v, i) => ch(from + i));

console.log('\n[1] compareToc 纯比对');

t('完全相同  latest 语义（changed=false）', () => {
  const d = compareToc(toc(3), toc(3));
  assert.strictEqual(d.changed, false);
  assert.strictEqual(d.appended, false);
  assert.strictEqual(d.addedCount, 0);
  assert.strictEqual(d.latestChapter, '第3章');
});

t('远端纯追加 2 章  appended，addedCount=2', () => {
  const d = compareToc(toc(3), toc(5));
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.appended, true);
  assert.strictEqual(d.addedCount, 2);
  assert.strictEqual(d.latestChapter, '第5章');
});

t('中间插入（本地不是前缀） changed 但非 appended', () => {
  const a = [ch(1), ch(2), ch(3)];
  const b = [ch(1), ch(99), ch(2), ch(3), ch(4)];
  const d = compareToc(a, b);
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.appended, false);
});

t('远端删章  removed', () => {
  const d = compareToc(toc(5), toc(3));
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.removed, true);
  assert.strictEqual(d.removedCount, 2);
});

t('同章数但章节地址/标题变了  changed', () => {
  const a = toc(3);
  const b = toc(3).map((c, i) => (i === 1 ? { name: '第2章（改）', url: c.url } : c));
  const d = compareToc(a, b);
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.appended, false);
});

t('本地空目录 + 远端有目录  appended（首次建目录）', () => {
  const d = compareToc([], toc(4));
  assert.strictEqual(d.appended, true);
  assert.strictEqual(d.addedCount, 4);
});

t('非法入参不抛异常', () => {
  assert.strictEqual(compareToc(null, undefined).changed, false);
  assert.strictEqual(compareToc('x', 3).newCount, 0);
});

/** 造一个数据目录：一个书源 + 一本带 3 章目录的书 */
function mkWorld({ source = true, oldToc = toc(3), name = '测试书' } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'w-'));
  const lib = new Library(dir);
  const added = lib.add({
    name,
    author: '作者甲',
    bookUrl: 'http://x.test/book/1',
    sourceKey: 'http://x.test',
    sourceName: '测试源',
  });
  lib.saveToc(added.id, oldToc);
  if (source) {
    const sdir = path.join(dir, 'sources');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(
      path.join(sdir, 'sources.json'),
      JSON.stringify([{
        bookSourceName: '测试源',
        bookSourceUrl: 'http://x.test',
        searchUrl: '/s?q={{key}}',
        ruleToc: { chapterList: '#list a' },
        ruleContent: { content: '#content' },
      }], null, 2),
      'utf8'
    );
  }
  return { dir, lib, id: added.id };
}

/** 假书源存储：只实现 get() */
function fakeSources(source) {
  return { get: (key) => (String(key || '').toLowerCase() === 'http://x.test' ? source || { bookSourceUrl: 'http://x.test' } : null) };
}

/** 假引擎：toc 返回给定目录，bookInfo 返回空 tocUrl */
function fakeEngine(chapters, { fail = false, failInfo = false } = {}) {
  return () => ({
    bookInfo: async () => {
      if (failInfo) throw new Error('详情页 500');
      return { tocUrl: '' };
    },
    toc: async () => {
      if (fail) throw new Error('目录页解析为空');
      return chapters;
    },
  });
}

(async () => {
  console.log('\n[2] checkBook 成功：纯追加写回目录与状态');

  await at('远端多 2 章  status=updated，toc.json 变 5 章，书架字段写回', async () => {
    const { lib, id } = mkWorld({ oldToc: toc(3) });
    const r = await checkBook({ library: lib, sources: fakeSources(), book: lib.get(id), makeEngine: fakeEngine(toc(5)) });
    assert.strictEqual(r.status, 'updated');
    assert.strictEqual(r.addedCount, 2);
    assert.strictEqual(r.tocApplied, true);
    assert.strictEqual(lib.toc(id).length, 5);
    assert.strictEqual(lib.get(id).chapterCount, 5);
    const b = lib.get(id);
    assert.strictEqual(b.updateStatus, 'updated');
    assert.strictEqual(b.updateCount, 2);
    assert.strictEqual(b.latestChapter, '第5章');
    assert.strictEqual(b.latestChapterCount, 5);
    assert.ok(b.lastCheckAt > 0);
    assert.strictEqual(b.updateError, '');
  });

  await at('远端目录一致  status=latest，目录不变', async () => {
    const { lib, id } = mkWorld({ oldToc: toc(3) });
    const before = fs.readFileSync(path.join(lib.bookDir(id), 'toc.json'), 'utf8');
    const r = await checkBook({ library: lib, sources: fakeSources(), book: lib.get(id), makeEngine: fakeEngine(toc(3)) });
    assert.strictEqual(r.status, 'latest');
    assert.strictEqual(lib.get(id).updateStatus, 'latest');
    assert.strictEqual(fs.readFileSync(path.join(lib.bookDir(id), 'toc.json'), 'utf8'), before);
  });

  await at('目录中间插入  status=changed，本地目录不被覆盖', async () => {
    const { lib, id } = mkWorld({ oldToc: toc(3) });
    const before = lib.toc(id).map((c) => c.url);
    const remote = [ch(1), ch(99), ch(2), ch(3), ch(4)];
    const r = await checkBook({ library: lib, sources: fakeSources(), book: lib.get(id), makeEngine: fakeEngine(remote) });
    assert.strictEqual(r.status, 'changed');
    assert.strictEqual(r.tocApplied, false);
    assert.deepStrictEqual(lib.toc(id).map((c) => c.url), before);
    assert.strictEqual(lib.get(id).updateTocChanged, true);
  });

  await at('applyToc=false 时即使纯追加也不写目录（dryRun 语义）', async () => {
    const { lib, id } = mkWorld({ oldToc: toc(3) });
    const r = await checkBook({
      library: lib, sources: fakeSources(), book: lib.get(id),
      makeEngine: fakeEngine(toc(6)), applyToc: false,
    });
    assert.strictEqual(r.status, 'updated');
    assert.strictEqual(r.tocApplied, false);
    assert.strictEqual(lib.toc(id).length, 3);
  });

  console.log('\n[3] checkBook 失败路径：只记错误，不抛');

  await at('书源已不存在  missing-source', async () => {
    const { lib, id } = mkWorld({ source: false });
    const noSources = { get: () => null };
    const r = await checkBook({ library: lib, sources: noSources, book: lib.get(id), makeEngine: fakeEngine(toc(5)) });
    assert.strictEqual(r.status, 'missing-source');
    assert.ok(/书源已不存在/.test(r.error));
    assert.strictEqual(lib.get(id).updateStatus, 'missing-source');
  });

  await at('目录抓取抛异常  error + updateError', async () => {
    const { lib, id } = mkWorld({ oldToc: toc(3) });
    const r = await checkBook({ library: lib, sources: fakeSources(), book: lib.get(id), makeEngine: fakeEngine([], { fail: true }) });
    assert.strictEqual(r.status, 'error');
    assert.ok(/目录页解析为空/.test(r.error));
    assert.strictEqual(lib.get(id).updateStatus, 'error');
    assert.ok(/目录页解析为空/.test(lib.get(id).updateError));
    assert.strictEqual(lib.toc(id).length, 3, '失败时不能动本地目录');
  });

  await at('详情页失败但目录页可用  仍能检查（回退 bookUrl）', async () => {
    const { lib, id } = mkWorld({ oldToc: toc(3) });
    const r = await checkBook({
      library: lib, sources: fakeSources(), book: lib.get(id),
      makeEngine: fakeEngine(toc(4), { failInfo: true }),
    });
    assert.strictEqual(r.status, 'updated');
    assert.strictEqual(r.addedCount, 1);
  });

  console.log('\n[4] checkShelfUpdates 汇总与筛选');

  await at('两本书：一本有更新一本最新  汇总 updated=1/latest=1', async () => {
    const { lib, id } = mkWorld({ oldToc: toc(3), name: '书A' });
    const b2 = lib.add({ name: '书B', bookUrl: 'http://x.test/book/2', sourceKey: 'http://x.test' });
    lib.saveToc(b2.id, toc(10));
    const r = await checkShelfUpdates({
      library: lib,
      sources: fakeSources(),
      concurrency: 2,
      makeEngine: (() => {
        let n = 0;
        return () => {
          n++;
          const chapters = n === 1 ? toc(5) : toc(10);
          return { bookInfo: async () => ({ tocUrl: '' }), toc: async () => chapters };
        };
      })(),
    });
    assert.strictEqual(r.total, 2);
    assert.strictEqual(r.updated, 1);
    assert.strictEqual(r.latest, 1);
    assert.strictEqual(r.failed, 0);
    assert.strictEqual(r.items.length, 2);
    assert.strictEqual(lib.get(id).updateStatus, 'updated');
    assert.strictEqual(lib.get(b2.id).updateStatus, 'latest');
  });

  await at('bookIds 只查指定的一本', async () => {
    const { lib, id } = mkWorld({ oldToc: toc(3), name: '书A' });
    const b2 = lib.add({ name: '书B', bookUrl: 'http://x.test/book/2', sourceKey: 'http://x.test' });
    const r = await checkShelfUpdates({
      library: lib, sources: fakeSources(), bookIds: [id], makeEngine: fakeEngine(toc(3)),
    });
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.items[0].bookId, id);
    assert.strictEqual(lib.get(b2.id).updateStatus, '');
  });

  await at('空书架  total=0，不报错', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'empty-'));
    const lib = new Library(dir);
    const r = await checkShelfUpdates({ library: lib, sources: fakeSources(), makeEngine: fakeEngine([]) });
    assert.strictEqual(r.total, 0);
    assert.strictEqual(r.items.length, 0);
  });

  console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})();