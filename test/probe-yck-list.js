'use strict';
/** 分析 _recon/index.html 的列表结构，为书写源库解析器做准备 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const f = process.argv[2] || path.join(__dirname, '..', '..', '_recon', 'index.html');
const html = fs.readFileSync(f, 'utf8');
const $ = cheerio.load(html);
console.log(`len=${html.length} title="${$('title').text().trim()}"`);

// 找所有指向 content/id/xxx.html 的链接，打印其祖先链与内部结构
const links = $('a[href*="content/id/"]');
console.log(`\n=== a[href*="content/id/"] 命中 ${links.length} ===`);
const first = links.first();
console.log('第一个 a 的 HTML:\n' + first.prop('outerHTML'));
console.log('\n祖先链:');
let p = first;
for (let i = 0; i < 6 && p.length; i++) {
  p = p.parent();
  if (!p.length) break;
  console.log(`  [${i}] <${p[0].tagName}> id=${p.attr('id') || ''} class="${p.attr('class') || ''}"`);
}
const card = first.closest('li,div.card,tr,div.item');
console.log('\n最近的 li/card/tr/item HTML:\n' + (card.length ? card.prop('outerHTML').slice(0, 1200) : '(无)'));

// 其他可能的分页/筛选线索
console.log('\n=== 含 page / 分页 的链接 ===');
$('a').each((i, el) => {
  const t = $(el).text().trim();
  const h = $(el).attr('href') || '';
  if (/page|下一页|上一页/i.test(h + t) && t.length < 20) console.log(`  "${t}" → ${h}`);
});
console.log('\n=== script 里的接口常量 ===');
$('script').each((i, el) => {
  const s = $(el).html() || '';
  if (s.length > 40 && /shuyuan|ajax|fetch|api/i.test(s)) console.log(`--- script[${i}] (${s.length}B) ---\n${s.slice(0, 1500)}`);
});
