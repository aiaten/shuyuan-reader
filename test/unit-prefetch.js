'use strict';
/**
 * 本轮三项修复的回归测试（离线，全部打桩，不联网）。
 *
 *  1. searchEverywhere 并发：总耗时 ≈ 批次 × 单源耗时，不是所有源之和
 *  2. _runWithPrefetch 的墙上时钟预算：预算到点就收工，不会按 MAX_ROUNDS 累加
 *  3. Prefetcher 的缓存键：getSync 与 peekSync 用不同 options 形态也必须命中同一个键
 *
 * 跑法：node test/unit-prefetch.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const { App } = require(path.join(__dirname, '..', 'src', 'app'));
const { Prefetcher } = require(path.join(__dirname, '..', 'src', 'rules', 'jsrt'));
const { SourceEngine } = require(path.join(__dirname, '..', 'src', 'engine', 'source'));

let pass = 0;
let fail = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  \u2713 ${name}`); pass++; })
    .catch((e) => { console.log(`  \u2717 ${name}\n      ${e && e.message ? e.message : e}`); fail++; });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 1. 并发累加 ---------------- */

async function testConcurrency() {
  console.log('\n[1] searchEverywhere 不再串行累加');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-pf-conc-'));
  const app = new App({ dataDir: dir });
  const N = 12;
  const PER = 200;
  const CO = 6;
  const sources = [];
  for (let i = 0; i < N; i++) {
    sources.push({ bookSourceName: '源' + i, bookSourceUrl: 's' + i, searchUrl: 'https://x/?q={{key}}', enabled: true });
  }
  app.sources.all = () => sources;
  let inFlight = 0;
  let maxInFlight = 0;
  app.search = async (key) => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    await sleep(PER);
    inFlight--;
    return { sourceKey: key, list: [] };
  };

  const t0 = Date.now();
  const r = await app.searchEverywhere('书', { concurrency: CO, perSourceTimeout: 5000, totalTimeout: 20000 });
  const el = Date.now() - t0;
  const batches = Math.ceil(N / CO);
  const ideal = batches * PER;

  await t(`${N} 个源 / 并发 ${CO} / 各 ${PER}ms：耗时 ≈ ${ideal}ms 而不是 ${N * PER}ms`, () => {
    // 串行累加会接近 2400ms；这里要求落在两批的量级内（留 400ms 抖动余量）
    assert.ok(el < ideal + 400, `elapsed=${el}ms，期望 < ${ideal + 400}ms（串行会是 ${N * PER}ms）`);
  });
  await t(`同时在跑的请求数不超过并发上限 ${CO}`, () => {
    assert.ok(maxInFlight <= CO, `maxInFlight=${maxInFlight}`);
  });
  await t('并发不是 1（确实并行了）', () => {
    assert.ok(maxInFlight > 1, `maxInFlight=${maxInFlight}`);
  });
  await t('全部源都跑完且没有 skipped', () => {
    assert.strictEqual(r.ran, N);
    assert.strictEqual(r.skipped, 0);
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 2. 预取预算 ---------------- */

async function testPrefetchBudget() {
  console.log('\n[2] _runWithPrefetch 按时限收工（不再按 MAX_ROUNDS 累加）');

  await t('链式翻页 ajax 每轮都不收敛：预算 800ms 内收工，而不是 64 轮累加', async () => {
    // 每轮都用 Math.random() 造新 URL → 永远不会命中缓存，模拟「链式 java.ajax 翻页失控」
    const eng = new SourceEngine({
      bookSourceUrl: 'https://x.example/',
      bookSourceName: '链式慢源',
      header: '',
      ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
      searchUrl: '@js:var u="https://x.example/p?n=0"; var html=""; for (var i=0;i<3;i++){ html = java.ajax(u); if(!html) break; u = "https://x.example/p?n=" + (i+1) + "&from=" + Math.random(); } "https://x.example/done"',
    }, { httpOptions: { roundBudgetMs: 800, timeout: 5000, maxRounds: 64 } });
    let calls = 0;
    eng._fetch = async (url) => { calls++; await sleep(120); return { status: 200, text: '<i>' + url + '</i>', url }; };

    const t0 = Date.now();
    await eng.search('书', 1);
    const el = Date.now() - t0;
    // 没有预算时 = 64 轮 × 每轮 ~360ms ≈ 23s；有预算应在 1–2s 量级
    assert.ok(el < 3000, `elapsed=${el}ms，预算 800ms 却跑了 ${el}ms（calls=${calls}）`);
    assert.ok(calls < 20, `calls=${calls}，不应该跑到 MAX_ROUNDS=64`);
  });

  await t('预算到点后在 diagnostics 里留下「预取超时」记录', async () => {
    const eng = new SourceEngine({
      bookSourceUrl: 'https://x.example/',
      bookSourceName: '链式慢源2',
      header: '',
      ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
      searchUrl: '@js:var u="https://x.example/p?n=0"; var html=""; for (var i=0;i<3;i++){ html = java.ajax(u); if(!html) break; u = "https://x.example/p?n=" + (i+1) + "&from=" + Math.random(); } "https://x.example/done"',
    }, { httpOptions: { roundBudgetMs: 600, timeout: 5000, maxRounds: 64 } });
    eng._fetch = async (url) => { await sleep(120); return { status: 200, text: '<i>ok</i>', url }; };
    try { await eng.search('书', 1); } catch (_) { /* 不关心是否抛错 */ }
    const errs = (eng.lastDiagnostics && eng.lastDiagnostics.errors) || [];
    assert.ok(errs.some((e) => /预取超时/.test(e)), 'diagnostics 里应有「预取超时」：' + JSON.stringify(errs));
    assert.ok(errs.some((e) => /budget|600ms/.test(e)), '错误里应带上预算值：' + JSON.stringify(errs));
  });
  await t('正常收敛的规则不受预算影响（一次请求就返回）', async () => {
    const eng = new SourceEngine({
        bookSourceUrl: 'https://x.example/',
        bookSourceName: '快源',
        header: '',
        searchUrl: '@js:java.ajax("https://x.example/s") + "?q=" + encodeURIComponent(key)',
      },
      { httpOptions: { roundBudgetMs: 20000, timeout: 5000, maxRounds: 64 } });
    let calls = 0;
    eng._fetch = async () => {
      calls++;
      return { status: 200, text: '<div class="item"><a href="/b/1">书</a></div>', url: 'https://x.example/s' };
    };
    try { await eng.search('书', 1); } catch (_) { /* 结果形态不关心，只关心请求次数 */ }
    assert.ok(calls >= 1 && calls <= 3, `calls=${calls}，正常规则不该反复重发`);
  });
}

/* ---------------- 3. 缓存键一致性 ---------------- */

async function testReqKey() {
  console.log('\n[3] 缓存键一致：getSync 与 peekSync 用不同 options 形态也命中同一个键');

  await t('getSync 带完整 headers，peekSync 只带 method —— 仍能取到条目', () => {
    const p = new Prefetcher();
    p.cache.set(
      ['GET', 'https://x.example/a', '', ''].join('\u0001'),
      { status: 200, text: 'hi', url: 'https://x.example/b' }
    );
    // 规则里 java.ajax(url, JSON.stringify(opt)) 会带一大堆额外字段
    assert.strictEqual(p.getSync('https://x.example/a', { method: 'GET', headers: { 'User-Agent': 'UA' }, timeout: 25000, retry: 2 }), 'hi');
    // 引擎 peekSync 只带 { method }
    const hit = p.peekSync('https://x.example/a', { method: 'GET' });
    assert.ok(hit, 'peekSync 应命中');
    assert.strictEqual(hit.url, 'https://x.example/b', 'peekSync 应带出跳转后的地址');
  });

  await t('headers 不同不影响键（UA/Referer 不进键）', () => {
    const a = new Prefetcher();
    const b = new Prefetcher();
    a.getSync('https://x.example/z', { method: 'GET', headers: { 'User-Agent': 'A' } });
    b.getSync('https://x.example/z', { method: 'GET', headers: { 'User-Agent': 'B' } });
    const ka = Array.from(a.misses.keys());
    const kb = Array.from(b.misses.keys());
    assert.deepStrictEqual(ka, kb, '两个不同 UA 的请求应登记成同一个 miss key');
  });

  await t('method / body / charset 仍然进键（不同请求不能串味）', () => {
    const p = new Prefetcher();
    p.getSync('https://x.example/z', { method: 'GET' });
    p.getSync('https://x.example/z', { method: 'POST' });
    p.getSync('https://x.example/z', { method: 'POST', body: 'a=1' });
    p.getSync('https://x.example/z', { method: 'POST', body: 'a=2' });
    p.getSync('https://x.example/z', { method: 'POST', body: 'a=1', charset: 'gbk' });
    assert.strictEqual(p.misses.size, 5, '5 种不同的请求应产生 5 个键，实际 ' + p.misses.size);
  });

  await t('method 大小写归一（get 与 GET 同键）', () => {
    const p = new Prefetcher();
    p.getSync('https://x.example/z', { method: 'get' });
    p.getSync('https://x.example/z', { method: 'GET' });
    assert.strictEqual(p.misses.size, 1, 'get / GET 应同键，实际 ' + p.misses.size);
  });
}

async function main() {
  await testConcurrency();
  await testPrefetchBudget();
  await testReqKey();
  console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});