'use strict';
/**
 * 离线规则调试：抓一次页面存盘，之后反复用存盘 HTML 调规则，不重复走网络。
 * 用法：
 *   node test/debug-rules.js fetch 7941 搜索关键词
 *   node test/debug-rules.js run  7941
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { SourceEngine } = require('../src/engine/source');
const { CookieJar } = require('../src/net/cookiejar');
const R = require('../src/rules/rule');

const RECON = 'D:\\AI\\工作区\\_recon';
const CACHE = path.join(__dirname, '.cache');
fs.mkdirSync(CACHE, { recursive: true });

function loadSource(id) {
  let s = JSON.parse(fs.readFileSync(path.join(RECON, `src_${id}.json`), 'utf8'));
  if (Array.isArray(s)) s = s[0];
  return s;
}

/** 展开 searchUrl 为最终 URL + options（复刻引擎逻辑，便于单独检查） */
function buildSearch(source, keyword, page) {
  const vars = {
    key: keyword,
    searchKey: encodeURIComponent(keyword),
    page: String(page),
  };
  let raw = String(source.searchUrl);
  const pre = [...raw.matchAll(/<js>([\s\S]*?)<\/js>/g)].map((m) => m[1]);
  let urlPart = raw.replace(/<js>[\s\S]*?<\/js>/g, '').trim();
  let options = {};
  const ci = require('../src/engine/source').findOptionsComma(urlPart);
  if (ci > 0) {
    options = JSON.parse(urlPart.slice(ci + 1).trim());
    urlPart = urlPart.slice(0, ci).trim();
  }
  urlPart = urlPart.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_m, e) => (e in vars ? vars[e] : ''));
  if (options.body) options.body = String(options.body).replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_m, e) => (e in vars ? vars[e] : ''));
  return { pre, url: urlPart, options };
}

(async () => {
  const mode = process.argv[2] || 'run';
  const id = process.argv[3] || '7941';
  const src = loadSource(id);
  const plan = buildSearch(src, process.argv[4] || '诡秘之主', 1);
  console.log('searchUrl 展开 →', JSON.stringify(plan, null, 2));

  const htmlFile = path.join(CACHE, `${id}-search-1.html`);
  if (mode === 'fetch') {
    const eng = new SourceEngine(src, { jar: new CookieJar() });
    const r = await eng._fetch(plan.url, {
      method: plan.options.method || (plan.options.body ? 'POST' : 'GET'),
      body: plan.options.body,
      headers: plan.options.headers || {},
    });
    console.log(`HTTP ${r.status} ${r.body.length}B charset=${r.charset} final=${r.url}`);
    fs.writeFileSync(htmlFile, r.text, 'utf8');
    console.log('已保存', htmlFile);
    return;
  }

  const html = fs.readFileSync(htmlFile, 'utf8');
  console.log(`HTML ${html.length} 字符`);
  const $ = cheerio.load(html);

  const ctx = { baseUrl: src.bookSourceUrl.replace(/\/+$/, ''), source: src };
  const rs = src.ruleSearch;
  const listRes = R.evalRule(rs.bookList || '', $, ctx, {});
  console.log(`\nbookList=${JSON.stringify(rs.bookList)} → elems=${listRes.elems ? listRes.elems.length : 'null'} strings=${JSON.stringify(listRes.strings.slice(0, 3))}`);

  const els = listRes.elems && listRes.elems.length ? listRes.elems.toArray() : [];
  console.log(`元素数 ${els.length}`);
  for (let i = 0; i < Math.min(els.length, 3); i++) {
    console.log(`\n--- 第 ${i} 个元素 ---`);
    const $el = $(els[i]);
    console.log('  outerHTML:', $el.clone().wrap('<x/>').parent().html().slice(0, 300).replace(/\s+/g, ' '));
    for (const [k, rule] of Object.entries(rs)) {
      if (k === 'bookList') continue;
      if (!rule) { console.log(`  ${k.padEnd(12)} = (空规则)`); continue; }
      let r;
      try { r = R.evalRule(rule, $, ctx, { root: $el }); } catch (e) { console.log(`  ${k.padEnd(12)} !! ${e.message}`); continue; }
      console.log(`  ${k.padEnd(12)} [${JSON.stringify(rule)}] elems=${r.elems ? r.elems.length : '-'} → ${JSON.stringify(r.text).slice(0, 120)}`);
    }
  }

  // 逐段拆解 name 规则，定位是选择器还是取值的问题
  console.log('\n=== name 规则逐段拆解 ===');
  const rule = rs.name || 'a.0@text';
  console.log('段:', JSON.stringify(R.splitTop(rule, '@')));
  console.log('translateSelector(a.0) =', JSON.stringify(R.translateSelector('a.0')));
  if (els.length) {
    const $el = $(els[0]);
    console.log('  $el.find("a").length =', $el.find('a').length);
    console.log('  $el.find("a").eq(0).text() =', JSON.stringify($el.find('a').eq(0).text()));
    console.log('  $el.children("a").length =', $el.children('a').length);
  }
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
