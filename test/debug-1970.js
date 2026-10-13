'use strict';
/** 看 /book/1970/1.html 的结构，与 /book/60434/1.html 对比 */
const cheerio = require('cheerio');
const http = require('../src/net/http');

(async () => {
  for (const u of ['https://www.zuizhong.net/book/1970/1.html', 'https://www.zuizhong.net/book/1970/']) {
    const r = await http.get(u);
    const $ = cheerio.load(r.text);
    console.log(`\n=== ${u}  status=${r.status} len=${r.text.length}`);
    console.log(`  title="${$('title').text().trim()}"`);
    console.log(`  a[onclick*=read_tz] = ${$('a[onclick*="read_tz"]').length}`);
    console.log(`  a[href*=yuedu] = ${$('a[href*="yuedu"]').length}`);
    console.log(`  [class*=info_dv] = ${$('[class*="info_dv"]').length}`);
    $('[class*="info_dv"]').each((i, el) => {
      const $el = $(el);
      console.log(`    [${i}] <${el.tagName}> class="${$el.attr('class')}" a=${$el.find('a').length} li=${$el.find('li').length} ul=${$el.find('ul').length} title="${($el.attr('title') || '').slice(0, 50)}"`);
    });
    console.log(`  ul 列表: ${$('ul').length} 个`);
    $('ul').slice(0, 6).each((i, el) => {
      const $el = $(el);
      console.log(`    ul[${i}] class="${$el.attr('class') || ''}" id="${$el.attr('id') || ''}" li=${$el.find('li').length} a=${$el.find('a').length}`);
    });
    if (/1970/.test(u)) {
      const a = $('a').first();
      console.log(`  第一个 a: ${a.prop('outerHTML')}`);
      const links = [];
      $('a[href]').each((i, el) => { if (links.length < 12 && /\.html$/.test($(el).attr('href'))) links.push(`${$(el).text().trim().slice(0,20)}→${$(el).attr('href')}`); });
      console.log('  前 12 个 .html 链接:\n    ' + links.join('\n    '));
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
