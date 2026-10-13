'use strict';
/**
 * 全书源聚合搜索单元测试（离线，用假 App 的 search 打桩）。
 *
 * 覆盖点：
 *  - 并发：总耗时 ≈ 最慢的源，而不是所有源之和
 *  - 增量：每完成一个源就回调一次 onResult
 *  - 熔断：单个慢源超时被判定失败，不拖累整体
 *  - 整体超时：到点结算，未执行的源标 skipped
 *  - 聚合去重：同一本书多个来源合并成一条，offers 齐全
 *  - 排序：来源多的排前面
 *  - 性能档案：按历史成功率/耗时排序
 *
 * 跑法：node test/unit-searchall.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { App } = require('../src/app');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail || ''}`}`);
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(name, g === w, `got=${g} want=${w}`);
}

/** 造一个临时 App，书源表与 search 都是假的 */
function makeApp(searchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-searchall-'));
  const app = new App({ dataDir: dir });
  return { app, dir, searchImpl };
}

/** 用给定的书源数组 + search 实现构造 App（覆写 sources.all / app.search） */
function fakeApp(sources, impl) {
  const { app, dir } = makeApp(impl);
  app.sources.all = () => sources;
  app.search = impl;
  app._tmpDir = dir;
  return app;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个书源对象 */
function S(key, name, hasSearch = true) {
  return { bookSourceName: name, bookSourceUrl: key, searchUrl: hasSearch ? 'https://x/?q={{key}}' : '', enabled: true };
}

async function main() {
  console.log('=== 并发：总耗时 ≈ 最慢的源 ===');
  {
    const sources = [S('s1', '源1'), S('s2', '源2'), S('s3', '源3'), S('s4', '源4')];
    const delays = { s1: 200, s2: 200, s3: 200, s4: 200 };
    const app = fakeApp(sources, async (key) => {
      await sleep(delays[key]);
      return { sourceKey: key, source: key, list: [{ name: '书-' + key, author: '甲', bookUrl: 'u-' + key }] };
    });
    const t0 = Date.now();
    const r = await app.searchEverywhere('书', { concurrency: 4, perSourceTimeout: 5000, totalTimeout: 10000 });
    const el = Date.now() - t0;
    ok('4 个各 200ms 的源并发跑 < 600ms（串行会是 800ms+）', el < 600, `elapsed=${el}ms`);
    eq('全部成功', r.ok, 4);
    eq('完成数', r.ran, 4);
    fs.rmSync(app._tmpDir, { recursive: true, force: true });
  }

  console.log('\n=== 增量：每完成一个源回调一次 ===');
  {
    const sources = [S('s1', '源1'), S('s2', '源2')];
    const app = fakeApp(sources, async (key) => {
      await sleep(key === 's1' ? 30 : 80);
      return { sourceKey: key, source: key, list: [{ name: '书' + key, author: '甲', bookUrl: 'u' + key }] };
    });
    const events = [];
    const starts = [];
    await app.searchEverywhere('书', {
      concurrency: 2,
      perSourceTimeout: 3000,
      totalTimeout: 5000,
      onStart: (ev) => starts.push(ev.key),
      onResult: (ev) => events.push({ key: ev.key, count: ev.count, done: ev.done, total: ev.total }),
    });
    eq('onStart 调用 2 次', starts.length, 2);
    eq('onResult 回调 2 次（增量）', events.length, 2);
    eq('第一个回调是快的源 s1', events[0].key, 's1');
    eq('done 递增 1,2', events.map((e) => e.done), [1, 2]);
    ok('每个事件都带 total', events.every((e) => e.total === 2));
    fs.rmSync(app._tmpDir, { recursive: true, force: true });
  }

  console.log('\n=== 熔断：慢源超时不影响其它源 ===');
  {
    const sources = [S('fast', '快源'), S('slow', '慢源')];
    const app = fakeApp(sources, async (key) => {
      await sleep(key === 'fast' ? 30 : 5000);
      return { sourceKey: key, source: key, list: [{ name: '书', author: '甲', bookUrl: 'u-' + key }] };
    });
    const t0 = Date.now();
    const r = await app.searchEverywhere('书', { concurrency: 2, perSourceTimeout: 300, totalTimeout: 2000 });
    const el = Date.now() - t0;
    ok('整体在 1s 内返回（慢源 5s 被熔断）', el < 1000, `elapsed=${el}ms`);
    eq('慢源被标记失败', r.sources.find((s) => s.key === 'slow').ok, false);
    ok('慢源错误信息含「超时」', /超时/.test(r.sources.find((s) => s.key === 'slow').error), r.sources.find((s) => s.key === 'slow').error);
    eq('timedOut 计数', r.timedOut, 1);
    eq('快源仍然成功', r.sources.find((s) => s.key === 'fast').ok, true);
    fs.rmSync(app._tmpDir, { recursive: true, force: true });
  }

  console.log('\n=== 整体超时：未执行的源标 skipped ===');
  {
    const sources = [S('a', 'A'), S('b', 'B'), S('c', 'C'), S('d', 'D')];
    const app = fakeApp(sources, async (key) => {
      await sleep(400);
      return { sourceKey: key, source: key, list: [] };
    });
    const r = await app.searchEverywhere('书', { concurrency: 1, perSourceTimeout: 300, totalTimeout: 400 });
    ok('并发 1、整体 400ms → 有源未执行', r.skipped > 0, `skipped=${r.skipped}`);
    ok('skipped 的源错误信息含「整体超时」', r.sources.filter((s) => !s.list.length && /整体超时/.test(s.error)).length > 0,
      JSON.stringify(r.sources.map((s) => s.error)));
    eq('total 覆盖全部源', r.total, 4);
    fs.rmSync(app._tmpDir, { recursive: true, force: true });
  }

  console.log('\n=== 聚合去重：同一本书多来源合并 ===');
  {
    const sources = [S('s1', '源A'), S('s2', '源B'), S('s3', '源C')];
    const app = fakeApp(sources, async (key) => {
      await sleep(10);
      const books = {
        s1: [{ name: '剑来', author: '烽火戏诸侯', bookUrl: 'u1', lastChapter: '第1章' }],
        s2: [{ name: '剑来', author: '烽火戏诸侯', bookUrl: 'u2' }, { name: '独book', author: '乙', bookUrl: 'u3' }],
        s3: [{ name: ' 剑　来 ', author: '烽火戏诸侯', bookUrl: 'u4' }], // 书名带空格全角，应归一到同一本
      };
      return { sourceKey: key, source: key, list: books[key] };
    });
    const r = await app.searchEverywhere('剑来', { concurrency: 3, perSourceTimeout: 3000, totalTimeout: 5000 });
    const jl = r.groups.find((g) => g.title.replace(/\s/g, '') === '剑来');
    ok('《剑来》聚合为一条', !!jl, JSON.stringify(r.groups.map((g) => g.title)));
    eq('《剑来》来源数 = 3', jl.sourceCount, 3);
    eq('《剑来》offers 的源名', jl.offers.map((o) => o.sourceName).sort(), ['源A', '源B', '源C']);
    ok('《剑来》补全了 lastChapter', jl.lastChapter === '第1章', jl.lastChapter);
    eq('另一个不同的书单独一条', r.groups.length, 2);
    eq('来源多的排前面（剑来 3 源 > 独book 1 源）', r.groups[0].title.replace(/\s/g, ''), '剑来');
    fs.rmSync(app._tmpDir, { recursive: true, force: true });
  }

  console.log('\n=== 无作者的来源不互相合并 ===');
  {
    const sources = [S('s1', '源A'), S('s2', '源B')];
    const app = fakeApp(sources, async (key) => {
      return { sourceKey: key, source: key, list: [{ name: '无名书', author: '', bookUrl: 'u-' + key }] };
    });
    const r = await app.searchEverywhere('无名书', { concurrency: 2, perSourceTimeout: 3000, totalTimeout: 5000 });
    eq('两个无作者同名书不合并', r.groups.length, 2);
    fs.rmSync(app._tmpDir, { recursive: true, force: true });
  }

  console.log('\n=== 跳过没有 searchUrl 的源 ===');
  {
    const sources = [S('s1', '有搜'), S('s2', '无搜', false)];
    const calls = [];
    const app = fakeApp(sources, async (key) => {
      calls.push(key);
      return { sourceKey: key, source: key, list: [] };
    });
    const r = await app.searchEverywhere('书', { concurrency: 2, perSourceTimeout: 3000, totalTimeout: 5000 });
    eq('只搜有 searchUrl 的源', calls, ['s1']);
    eq('total 只算有 searchUrl 的', r.total, 1);
    fs.rmSync(app._tmpDir, { recursive: true, force: true });
  }

  console.log('\n=== 性能档案：成功快的源优先 ===');
  {
    const sources = [S('slow', '慢源'), S('fast', '快源')];
    const app = fakeApp(sources, async (key) => {
      await sleep(key === 'fast' ? 5 : 50);
      return { sourceKey: key, source: key, list: [] };
    });
    // 先跑两轮积累档案
    await app.searchEverywhere('书', { concurrency: 1, perSourceTimeout: 3000, totalTimeout: 5000 });
    await app.searchEverywhere('书', { concurrency: 1, perSourceTimeout: 3000, totalTimeout: 5000 });
    const order = [];
    app.search = async (key) => { order.push(key); return { sourceKey: key, list: [] }; };
    await app.searchEverywhere('书', { concurrency: 1, perSourceTimeout: 3000, totalTimeout: 5000 });
    eq('快源被排到前面先搜', order, ['fast', 'slow']);
    const perf = app.sourcePerf('fast');
    ok('性能档案有记录', perf && perf.runs >= 2, JSON.stringify(perf));
    ok('性能档案 avgMs 是数字', perf && typeof perf.avgMs === 'number' && perf.avgMs >= 0, JSON.stringify(perf));
    fs.rmSync(app._tmpDir, { recursive: true, force: true });
  }

  console.log('\n=== 边界 ===');
  {
    const app = fakeApp([], async () => ({ list: [] }));
    let err = null;
    try { await app.searchEverywhere('  '); } catch (e) { err = e.message; }
    ok('空关键词抛错', !!err && err.includes('不能为空'), String(err));

    const r = await app.searchEverywhere('书', { concurrency: 4, perSourceTimeout: 3000, totalTimeout: 5000 });
    eq('没有书源时 total=0', r.total, 0);
    eq('没有书源时 groups 空', r.groups.length, 0);
    ok('返回带 elapsed/el', typeof r.elapsed === 'number' && typeof r.el === 'string');
    fs.rmSync(app._tmpDir, { recursive: true, force: true });
  }

  console.log('\n=== 某个源抛异常不影响其它源 ===');
  {
    const sources = [S('bad', '坏源'), S('good', '好源')];
    const app = fakeApp(sources, async (key) => {
      if (key === 'bad') throw new Error('规则解不出书列表');
      return { sourceKey: key, source: key, list: [{ name: '书', author: '甲', bookUrl: 'u' }] };
    });
    const r = await app.searchEverywhere('书', { concurrency: 2, perSourceTimeout: 3000, totalTimeout: 5000 });
    eq('坏源被记为失败', r.sources.find((s) => s.key === 'bad').ok, false);
    ok('坏源保留错误原文', /规则解不出书列表/.test(r.sources.find((s) => s.key === 'bad').error));
    eq('好源正常出结果', r.groups.length, 1);
    fs.rmSync(app._tmpDir, { recursive: true, force: true });
  }
}

main().then(
  () => {
    console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
    process.exit(fail ? 1 : 0);
  },
  (e) => {
    console.error('测试异常：' + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
);
