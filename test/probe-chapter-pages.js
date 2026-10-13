'use strict';
/**
 * 探查章节页的分页结构：找出所有含「下一」「下一页」「下一章」的链接，
 * 以及 select/option 之类的分页控件。
 *
 * 用法: node test/probe-chapter-pages.js [缓存html] [深度]
 *   深度>0 时沿着「下一」链接继续抓，打印每页的 .info_dv1 文本长度与链接。
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const file = process.argv[2] || path.join(__dirname, '.cache', '7941-chapter.html');
const depth = parseInt(process.argv[3] || '0', 10);

const html = fs.readFileSync(file, 'utf8');
const $ = cheerio.load(html);

console.log(`文件: ${file}  len=${html.length}`);

console.log('\n=== 含「下一」的 <a> ===');
$('a').each((i, el) => {
  const $el = $(el);
  const own = $el.contents().filter((_j, n) => n.type === 'text').text().trim();
  const full = $el.text().trim();
  if (own.includes('下一') || full.includes('下一')) {
    console.log(`  [${i}] own="${own}"  full="${full}"  href="${$el.attr('href')}"  class="${$el.attr('class') || ''}"`);
  }
});

console.log('\n=== select / option ===');
$('select').each((i, el) => {
  const $el = $(el);
  console.log(`  select[${i}] id=${$el.attr('id') || ''} class=${$el.attr('class') || ''}`);
  $el.find('option').each((j, o) => {
    const $o = $(o);
    console.log(`    option[${j}] value="${$o.attr('value')}" selected=${$o.attr('selected') !== undefined} text="${$o.text().trim()}"`);
  });
});

console.log('\n=== 含 chapter / page / 换页 关键词的元素属性 ===');
$('[id],[class]').each((i, el) => {
  const $el = $(el);
  const idc = `${$el.attr('id') || ''} ${$el.attr('class') || ''}`;
  if (/page|pagelist|chapter|read_btn|next/i.test(idc)) {
    const t = $el.text().replace(/\s+/g, ' ').trim();
    if (t.length && t.length < 120) console.log(`  <${el.tagName}> #${$el.attr('id') || ''} .${$el.attr('class') || ''}  "${t}"`);
  }
});

console.log('\n=== .info_dv1 内 p 文本 ===');
$('.info_dv1').each((i, el) => {
  const ps = $(el).find('p');
  console.log(`  .info_dv1[${i}] p数=${ps.length} 总文本=${$(el).text().trim().length}`);
  ps.each((j, p) => {
    const t = $(p).text().replace(/\s+/g, ' ').trim();
    console.log(`    p[${j}] len=${t.length} "${t.slice(0, 70)}"`);
  });
});

if (depth > 0) {
  const http = require('../src/net/http');
  (async () => {
    let cur = process.argv[4] || 'https://www.zuizhong.net/book/60434/yuedu-15920759.html';
    const seen = new Set();
    for (let i = 0; i <= depth; i++) {
      if (seen.has(cur)) { console.log(`\n[${i}] 环回: ${cur}`); break; }
      seen.add(cur);
      const r = await http.get(cur);
      const $$ = cheerio.load(r.text);
      const dv = $$('.info_dv1');
      const links = [];
      $$('a').each((_j, el) => {
        const $e = $$(el);
        const t = $e.contents().filter((_k, n) => n.type === 'text').text().trim();
        if (t.includes('下一') || t.includes('下一页')) links.push(`${t}→${$e.attr('href')}`);
      });
      console.log(`\n[${i}] ${cur}\n     status=${r.status} len=${r.text.length} .info_dv1=${dv.length} 文本=${dv.text().trim().length} title="${$$('title').text().trim()}"`);
      console.log(`     links: ${links.join('  |  ')}`);
      const nx = links.find((l) => l.startsWith('下一'));
      if (!nx) break;
      cur = new URL(nx.split('→')[1], cur).toString();
    }
  })().catch((e) => console.error(e));
}
