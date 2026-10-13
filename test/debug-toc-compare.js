'use strict';
/** 对比 1970 与 60434 的目录页结构差异，解释为什么 1970 解不出章节 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const http = require('../src/net/http');
const R = require('../src/rules/rule');

const CACHE = path.join(__dirname, '.cache');
const RULE = '.info_dv3.1@ul@a';

async function getPage(url, cacheName) {
  const f = path.join(CACHE, cacheName);
  if (fs.existsSync(f) && fs.statSync(f).size > 5000) return fs.readFileSync(f, 'utf8');
  const r = await http.get(url);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(f, r.text, 'utf8');
  return r.text;
}

(async () => {
  for (const [url, cache] of [
    ['https://www.zuizhong.net/book/1970/1.html', '1970-toc.html'],
    ['https://www.zuizhong.net/book/60434/1.html', '60434-toc.html'],
  ]) {
    const html = await getPage(url, cache);
    const $ = cheerio.load(html);
    console.log(`\n######## ${url}  len=${html.length}`);

    console.log(`  分段: ${JSON.stringify(R.splitTop(RULE, '@'))}`);
    const res = R.evalRule(RULE, $, {}, {});
    console.log(`  evalRule → elems=${res.elems ? res.elems.length : 'null'} strings=${JSON.stringify((res.strings || []).slice(0, 3))}`);

    const info3 = $('.info_dv3');
    console.log(`  $('.info_dv3') = ${info3.length}`);
    info3.each((i, el) => {
      const $el = $(el);
      console.log(`    [${i}] class="${$el.attr('class')}" a=${$el.find('a').length} ul=${$el.find('ul').length}`);
      console.log(`        ul 内 a 数=${$el.find('ul').find('a').length}`);
      const as = $el.find('ul').find('a');
      as.slice(0, 4).each((j, a) => {
        const $a = $(a);
        console.log(`        a[${j}] text="${$a.text().trim()}" href="${$a.attr('href')}" onclick="${($a.attr('onclick') || '').slice(0, 30)}"`);
      });
      console.log(`        select=${$el.find('select').length} option=${$el.find('option').length}`);
      $el.find('option').each((j, o) => {
        const $o = $(o);
        console.log(`          option[${j}] value="${$o.attr('value')}" selected=${$o.attr('selected') !== undefined} text="${$o.text().trim()}"`);
      });
    });

    // selectSingle 的中间结果
    const base = $.root();
    const one = R.selectSingle ? R.selectSingle($, base, '.info_dv3.1') : null;
    console.log(`  selectSingle('.info_dv3.1') = ${one ? one.length : 'N/A'}`);
    if (R.findIndexSet) console.log(`  findIndexSet('.info_dv3.1') = ${JSON.stringify(R.findIndexSet('.info_dv3.1'))}`);
    if (R.findIndexSet) console.log(`  findIndexSet('ul') = ${JSON.stringify(R.findIndexSet('ul'))}`);
    if (R.findIndexSet) console.log(`  findIndexSet('a') = ${JSON.stringify(R.findIndexSet('a'))}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
