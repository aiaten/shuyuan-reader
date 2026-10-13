'use strict';
/* 结构探测：node test/probe-chapter-struct.js [html] */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const file = process.argv[2] || path.join(__dirname, '.cache', '7941-chapter.html');
const html = fs.readFileSync(file, 'utf8');
const $ = cheerio.load(html);
console.log('len=', html.length);

const classes = {};
$('*').each((i, el) => {
  const c = el.attribs && el.attribs.class;
  if (!c) return;
  for (const one of c.split(/\s+/).filter(Boolean)) {
    classes[one] = (classes[one] || 0) + 1;
  }
});
const interesting = Object.keys(classes).filter((k) => /info|content|text|read|article|chapter|body|main/i.test(k)).sort();
console.log('\n相关 class:');
for (const k of interesting) console.log(`  .${k} x${classes[k]}`);

for (const sel of ['.info_dv1', '.info_dv2', '.info_dv3', '#content', '.content', '.read-content', '.text', '.article']) {
  const n = $(sel).length;
  if (!n) continue;
  console.log(`\n${sel} → ${n} 个`);
  $(sel).slice(0, 3).each((i, el) => {
    const $el = $(el);
    console.log(`  [${i}] tag=${el.tagName} class=${el.attribs.class || ''} p数=${$el.find('p').length} 文本长=${$el.text().trim().length}`);
    console.log(`       子元素标签: ${$el.children().map((k, c) => c.tagName + (c.attribs && c.attribs.id ? '#' + c.attribs.id : '') + (c.attribs && c.attribs.class ? '.' + c.attribs.class.split(/\s+/)[0] : '')).get().slice(0, 15).join(', ')}`);
  });
}

console.log('\n所有 p 总数 =', $('p').length);
$('.info_dv1').each((i, el) => {
  const ps = $(el).find('p');
  console.log(`\n.info_dv1[${i}] 内 p 数 = ${ps.length}`);
  ps.slice(0, 6).each((k, p) => console.log(`  p[${k}] len=${$(p).text().trim().length} :: ${$(p).text().trim().slice(0, 80)}`));
  const last = ps.length - 1;
  ps.slice(Math.max(0, last - 3)).each((k, p) => console.log(`  p[${last - 3 + k}] len=${$(p).text().trim().length} :: ${$(p).text().trim().slice(0, 80)}`));
});
