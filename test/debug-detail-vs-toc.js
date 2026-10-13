'use strict';
/** 详情页 vs 目录页：.info_dv3 的数量与 a 数 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const http = require('../src/net/http');
const R = require('../src/rules/rule');

const CACHE = path.join(__dirname, '.cache');
const RULE = '.info_dv3.1@ul@a';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

async function get(url, cacheName) {
  const f = path.join(CACHE, cacheName);
  if (fs.existsSync(f) && fs.statSync(f).size > 5000) return fs.readFileSync(f, 'utf8');
  const r = await http.get(url, { headers: { 'User-Agent': UA } });
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(f, r.text, 'utf8');
  return r.text;
}

(async () => {
  for (const [url, cache] of [
    ['https://www.zuizhong.net/novel/60434/', 'detail-60434.html'],
    ['https://www.zuizhong.net/book/60434/1.html', 'toc1-60434.html'],
    ['https://www.zuizhong.net/book/60434/', 'toc0-60434.html'],
    ['https://www.zuizhong.net/novel/1970/', 'detail-1970.html'],
  ]) {
    let html;
    try { html = await get(url, cache); } catch (e) { console.log(`\n### ${url} → 抓取失败 ${e.message}`); continue; }
    const $ = cheerio.load(html);
    const res = R.evalRule(RULE, $, {}, {});
    console.log(`\n### ${url}  len=${html.length}  title="${$('title').text().trim().slice(0, 40)}"`);
    console.log(`    .info_dv3 = ${$('.info_dv3').length}   [class*=info_dv] = ${$('[class*="info_dv"]').length}`);
    $('[class*="info_dv"]').each((i, el) => {
      const $el = $(el);
      console.log(`      [${i}] class="${$el.attr('class')}" a=${$el.find('a').length} ul=${$el.find('ul').length}`);
    });
    console.log(`    evalRule('${RULE}') → elems=${res.elems ? res.elems.length : 0}`);
    if (res.elems && res.elems.length) {
      const as = res.elems.toArray();
      console.log(`      首: "${$(as[0]).text().trim()}" href=${$(as[0]).attr('href')} onclick=${($(as[0]).attr('onclick') || '').slice(0, 25)}`);
      console.log(`      末: "${$(as[as.length - 1]).text().trim()}" href=${$(as[as.length - 1]).attr('href')} onclick=${($(as[as.length - 1]).attr('onclick') || '').slice(0, 25)}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
