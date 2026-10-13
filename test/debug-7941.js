'use strict';
/** 用桌面 UA 抓搜索页，离线跑 7941 的 ruleSearch 各字段 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const http = require('../src/net/http');
const { CookieJar } = require('../src/net/cookiejar');
const R = require('../src/rules/rule');

const KEY = '诡秘之主';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

(async () => {
  const jar = new CookieJar();
  const r = await http.request('https://www.zuizhong.net/search.html', {
    method: 'POST',
    body: `s=${KEY}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': DESKTOP_UA },
    jar,
  });
  const out = path.join(__dirname, '.cache', '7941-search-desktop.html');
  fs.writeFileSync(out, r.text, 'utf8');
  console.log(`保存 ${out} len=${r.body.length}`);

  const $ = cheerio.load(r.text);
  const srcRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '_recon', 'src_7941.json'), 'utf8'));
  const src = Array.isArray(srcRaw) ? srcRaw[0] : srcRaw;
  const ruleSearch = src.ruleSearch;

  console.log('\n--- .txt-list 存在性 ---');
  console.log('  .txt-list       =', $('.txt-list').length);
  console.log('  .txt-list@li 手测 =', $('.txt-list li').length);
  console.log('  .txt-list > li  =', $('.txt-list > li').length);
  console.log('  .txt-list 首元素 tag =', $('.txt-list').first().get(0) ? $('.txt-list').first().get(0).tagName : '(无)');

  console.log('\n--- .txt-list 内部结构（前 500 字符）---');
  const inner = $('.txt-list').first().html();
  console.log(' ', inner ? inner.replace(/\s+/g, ' ').slice(0, 500) : '(空)');

  console.log('\n--- evalRule(".txt-list@li") ---');
  const els = R.evalRule('.txt-list@li', $, {}, {});
  const elems = els.elems;
  console.log('  elems =', elems ? elems.length : 'null');

  console.log('\n--- 逐字段求值（ruleSearch）---');
  if (elems && elems.length) {
    for (const [field, rule] of Object.entries(ruleSearch)) {
      if (field === 'bookList' || !rule) continue;
      try {
        const out2 = R.evalRule(rule, $, { result: elems.get(0) }, { root: elems, result0: elems.get(0) });
        console.log(`  ${field.padEnd(12)} rule=${JSON.stringify(rule).padEnd(22)} → strings=${JSON.stringify(out2.strings)} elems=${out2.elems ? out2.elems.length : 'null'}`);
      } catch (e) {
        console.log(`  ${field.padEnd(12)} rule=${JSON.stringify(rule).padEnd(22)} → ERROR ${e.message}`);
      }
    }
  }

  console.log('\n--- 用 Engine 的字段求值方式（elements 逐元素）---');
  if (elems && elems.length) {
    for (const [field, rule] of Object.entries(ruleSearch)) {
      if (field === 'bookList' || !rule) continue;
      const vals = [];
      for (let i = 0; i < Math.min(elems.length, 3); i++) {
        const el = elems.get(i);
        const $$ = cheerio.load(el.outerHtml || '');
        const out3 = R.evalRule(rule, $$, {}, { root: $$.root(), result0: $$.root().get(0) });
        vals.push(out3.text !== undefined ? out3.text : (out3.strings ? out3.strings.join('|') : ''));
      }
      console.log(`  ${field.padEnd(12)} → ${JSON.stringify(vals)}`);
    }
  }
})().catch((e) => { console.error('FAILED:', e.stack || e); process.exit(1); });
