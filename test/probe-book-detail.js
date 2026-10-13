/* 用桌面 UA 抓详情页，列出所有含「目录」的 a，以及 .info_dv3 结构与章节链接形态 */
const http = require('../src/net/http.js');
const cheerio = require('cheerio');
const fs = require('fs');

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

(async () => {
  const r = await http.get('https://www.zuizhong.net/novel/60434/', { headers: { 'User-Agent': DESKTOP_UA } });
  console.log('status', r.status, 'len', r.text.length);
  fs.writeFileSync('test/.cache/7941-book-desktop.html', r.text);

  const $ = cheerio.load(r.text);
  console.log('\n=== 含「目录」的 a ===');
  $('a').each((i, el) => {
    const $el = $(el);
    const t = $el.text().trim();
    const own = $el.contents().filter((_j, n) => n.type === 'text').text().trim();
    if (t.includes('目录') || own.includes('目录')) {
      console.log(`  a[${i}] text=${JSON.stringify(t)} ownText=${JSON.stringify(own)} href=${JSON.stringify($el.attr('href'))} class=${JSON.stringify($el.attr('class'))}`);
    }
  });

  console.log('\n=== .info_dv3 结构 ===');
  $('.info_dv3').each((i, el) => {
    const $el = $(el);
    console.log(`  [${i}] class=${JSON.stringify($el.attr('class'))} ul=${$el.find('ul').length} a=${$el.find('a').length}`);
    const t = $el.find('.title').first().text().trim();
    console.log(`      title=${JSON.stringify(t)}`);
    const firstA = $el.find('a').first();
    console.log(`      first a: text=${JSON.stringify(firstA.text().trim())} href=${JSON.stringify(firstA.attr('href'))} htmlish=${JSON.stringify(firstA.toString().slice(0, 140))}`);
  });

  console.log('\n=== 全文含「目录」片段 ===');
  const h = r.text;
  let idx = h.indexOf('目录');
  let n = 0;
  while (idx >= 0 && n < 8) {
    console.log(`  #${n} @${idx}: ${JSON.stringify(h.slice(Math.max(0, idx - 160), idx + 60))}`);
    idx = h.indexOf('目录', idx + 1);
    n++;
  }
})();
