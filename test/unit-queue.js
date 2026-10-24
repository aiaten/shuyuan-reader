'use strict';
/**
 * 下载队列单元测试（不联网）。
 *
 * 背景：书架点「下载」会整块 await 一个几百章的任务并遮住界面，看起来像卡死。
 * 改成 DownloadQueue 后台串行执行 + 轮询本地章节文件数上报进度。
 *
 * 覆盖：
 *  1. enqueue 同步返回（不阻塞渲染端），状态 queued
 *  2. 同一本书已在排队/运行 → 重复 enqueue 返回同一条，不叠加
 *  3. 多本书串行执行，不并发（maxRunning === 1）
 *  4. 进度：轮询 downloadedIndexes 增量，percent 从 0 涨到 100
 *  5. 一本失败不影响后面的；失败只落到该任务的 error
 *  6. cancel()：排队中的直接 canceled；运行中的打 cancelRequested 让 downloader 收手
 *  7. clearFinished() 只清已结束的，不动排队/运行中的
 *  8. 落盘恢复：downloads.json 里 running/queued 重启后变 interrupted，已完成保留
 *  9. 书架里没有这本书 / 本地没有目录 → enqueue 抛错
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DownloadQueue, STATUS } = require('../src/store/download-queue');

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shuyuan-queue-'));

/** 造一个假书架：每本书有 n 章目录；downloadedIndexes 可写 */
function mkLib(n = 5) {
  const books = new Map();
  const files = new Map();
  let seq = 0;
  return {
    dir: root,
    add(name) {
      const id = 'b' + ++seq;
      books.set(id, { id, name, sourceKey: 'http://src.test' });
      files.set(id, new Set());
      return id;
    },
    get(id) {
      return books.get(id) || null;
    },
    toc() {
      return Array.from({ length: n }, (_, i) => ({ name: '第' + (i + 1) + '章', url: 'u' + i }));
    },
    downloadedIndexes(id) {
      return files.get(id) || new Set();
    },
    syncDownloadedCount() {},
    _files: files,
  };
}

/** 假 downloader：按需完成若干章（模拟写文件），可配置延迟/失败 */
function mkDownloader(lib, opts = {}) {
  return {
    sources: {
      get(key) {
        return key === 'http://src.test' ? { key, name: '测试源' } : null;
      },
    },
    async downloadChapters(src, bookId, o) {
      const set = lib._files.get(bookId);
      const total = o.to - o.from + 1;
      let done = 0;
      let failed = 0;
      let skipped = 0;
      const failedIndexes = [];
      for (let i = o.from; i <= o.to; i++) {
        if (o.shouldStop && o.shouldStop()) break;
        await wait(opts.perChapterMs || 1);
        if (opts.failAt != null && i === opts.failAt) {
          failed++;
          failedIndexes.push(i);
          continue;
        }
        if (!o.force && set.has(i)) {
          skipped++;
          continue;
        }
        set.add(i);
        done++;
        if (o.onProgress) o.onProgress({ done, total });
      }
      return { done, skipped, failed, failedIndexes, from: o.from, to: o.to, total };
    },
  };
}

function mkQueue(lib, dl) {
  const events = [];
  const q = new DownloadQueue({
    library: lib,
    downloader: dl,
    dataDir: path.join(lib.dir, 'q' + Math.random().toString(36).slice(2, 7)),
    onChange: (ev) => events.push(ev),
  });
  fs.mkdirSync(q.dataDir, { recursive: true });
  return { q, events };
}

(async () => {
  await at('enqueue 同步返回，状态 queued', async () => {
    const lib = mkLib();
    const id = lib.add('书A');
    const { q } = mkQueue(lib, mkDownloader(lib, { perChapterMs: 20 }));
    const job = q.enqueue({ bookId: id });
    assert.ok(job && job.id, 'enqueue 应同步返回快照');
    assert.ok([STATUS.queued, STATUS.running].includes(job.status), `初始状态是 ${job.status}`);
    await wait(150);
    assert.strictEqual(q.get(job.id).status, STATUS.done);
  });

  await at('同一本书重复入队只有一条任务', async () => {
    const lib = mkLib();
    const id = lib.add('书A');
    const { q } = mkQueue(lib, mkDownloader(lib, { perChapterMs: 20 }));
    const a = q.enqueue({ bookId: id });
    const b = q.enqueue({ bookId: id });
    assert.strictEqual(a.id, b.id, '重复入队应返回同一条任务');
    await wait(200);
    assert.strictEqual(q.list().length, 1);
  });

  await at('多本书串行执行，不并发', async () => {
    const lib = mkLib(3);
    const ids = [lib.add('A'), lib.add('B'), lib.add('C')];
    let running = 0;
    let maxRunning = 0;
    const dl = mkDownloader(lib, { perChapterMs: 8 });
    const inner = dl.downloadChapters.bind(dl);
    dl.downloadChapters = async (...args) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      try {
        return await inner(...args);
      } finally {
        running--;
      }
    };
    const { q } = mkQueue(lib, dl);
    for (const id of ids) q.enqueue({ bookId: id });
    await wait(400);
    assert.strictEqual(maxRunning, 1, `并发数应为 1，实际 ${maxRunning}`);
    assert.strictEqual(q.list().filter((j) => j.status === STATUS.done).length, 3);
  });

  await at('进度：percent 随章节文件增长，完成时 100', async () => {
    const lib = mkLib(6);
    const id = lib.add('书A');
    const { q, events } = mkQueue(lib, mkDownloader(lib, { perChapterMs: 150 }));
    const job = q.enqueue({ bookId: id });
    await wait(900);
    const mid = q.get(job.id);
    assert.ok(mid.percent > 0 || mid.processed > 0, `中途应有进度，实际 percent=${mid.percent} processed=${mid.processed}`);
    await wait(1400);
    const fin = q.get(job.id);
    assert.strictEqual(fin.status, STATUS.done, `应完成，实际 ${fin.status} ${fin.error}`);
    assert.strictEqual(fin.percent, 100);
    assert.strictEqual(fin.done, 6);
    assert.ok(events.some((e) => e.type === 'job'), '应推送过任务快照');
  });

  await at('一本失败不影响后面的', async () => {
    const lib = mkLib(3);
    const a = lib.add('A');
    const b = lib.add('B');
    const dl = mkDownloader(lib, { perChapterMs: 2, failAt: 1 });
    const { q } = mkQueue(lib, dl);
    const ja = q.enqueue({ bookId: a });
    const jb = q.enqueue({ bookId: b });
    await wait(300);
    const ra = q.get(ja.id);
    const rb = q.get(jb.id);
    assert.ok(ra.failed >= 1, `A 应有失败章，实际 ${ra.failed}`);
    assert.strictEqual(rb.status, STATUS.done, `B 应完成，实际 ${rb.status}`);
  });

  await at('cancel() 撤掉排队中的任务', async () => {
    const lib = mkLib(4);
    const a = lib.add('A');
    const b = lib.add('B');
    const { q } = mkQueue(lib, mkDownloader(lib, { perChapterMs: 40 }));
    const ja = q.enqueue({ bookId: a });
    const jb = q.enqueue({ bookId: b });
    await wait(10);
    const r = q.cancel(jb.id);
    assert.strictEqual(r.id, jb.id);
    await wait(400);
    assert.strictEqual(q.get(ja.id).status, STATUS.done);
    assert.strictEqual(q.get(jb.id).status, STATUS.canceled);
    assert.strictEqual(q.get(jb.id).done, 0);
  });

  await at('cancel() 运行中的任务会尽快收手并标 canceled', async () => {
    const lib = mkLib(20);
    const id = lib.add('A');
    const { q } = mkQueue(lib, mkDownloader(lib, { perChapterMs: 30 }));
    const job = q.enqueue({ bookId: id });
    await wait(120);
    q.cancel(job.id);
    await wait(500);
    const r = q.get(job.id);
    assert.strictEqual(r.status, STATUS.canceled, `实际 ${r.status}`);
    assert.ok(r.done < 20, `应只下了一部分，实际 ${r.done}`);
  });

  await at('clearFinished() 只清已结束的', async () => {
    const lib = mkLib(2);
    const a = lib.add('A');
    const b = lib.add('B');
    const { q } = mkQueue(lib, mkDownloader(lib, { perChapterMs: 5 }));
    const ja = q.enqueue({ bookId: a });
    await wait(100);
    q.enqueue({ bookId: b });
    const r = q.clearFinished();
    assert.ok(r.removed >= 1, '应清掉已完成的那条');
    await wait(200);
    // B 还在或已完成，但 A 的记录没了
    assert.strictEqual(q.get(ja.id), null);
  });

  await at('重启恢复：running/queued 变 interrupted，已完成保留', async () => {
    const lib = mkLib(3);
    const id = lib.add('A');
    const dl = mkDownloader(lib, { perChapterMs: 2 });
    const { q } = mkQueue(lib, dl);
    const j = q.enqueue({ bookId: id });
    await wait(150);
    assert.strictEqual(q.get(j.id).status, STATUS.done);

    // 手工塞一条「运行中」再重开
    q.jobs.push({
      id: 'dlX', seq: 999, bookId: id, bookName: 'A', from: 0, to: 2, total: 3,
      done: 1, skipped: 0, failed: 0, processed: 1, percent: 33, status: STATUS.running,
      error: '', failedIndexes: [], createdAt: Date.now(), startedAt: Date.now(), finishedAt: 0,
    });
    q._persist();

    const q2 = new DownloadQueue({ library: lib, downloader: dl, dataDir: q.dataDir });
    const list = q2.list();
    const revived = list.find((x) => x.id === 'dlX');
    assert.strictEqual(revived.status, STATUS.interrupted, `实际 ${revived.status}`);
    assert.ok(/重启/.test(revived.error), '应说明是重启导致的中断');
    assert.ok(list.some((x) => x.id === j.id && x.status === STATUS.done), '已完成记录应保留');
  });

  await at('书架没这本书 / 本地没目录 → enqueue 抛错', async () => {
    const lib = mkLib();
    const { q } = mkQueue(lib, mkDownloader(lib));
    assert.throws(() => q.enqueue({ bookId: 'nope' }), /书架里没有这本书/);
    assert.throws(() => q.enqueue({}), /bookId/);
    const empty = { ...lib, toc: () => [] };
    const id = lib.add('空');
    const q3 = new DownloadQueue({ library: empty, downloader: mkDownloader(lib), dataDir: path.join(root, 'z') });
    assert.throws(() => q3.enqueue({ bookId: id }), /没有目录/);
  });

  console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})();