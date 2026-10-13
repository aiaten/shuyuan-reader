'use strict';
/** 定位 `.txt-list@li` 为何取不到元素 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const R = require('../src/rules/rule');

const html = fs.readFileSync(path.join(__dirname, '.cache', '7941-search-1.html'), 'utf8');
const $ = cheerio.load(html);

console.log('--- classifySegment 判定 ---');
for (const seg of ['.txt-list', 'li', 'a.0', 'text', 'href', 'html', 'content', 'p[1:-2]', '目录']) {
  let c;
  try { c = R.classifySegment(seg); } catch (e) { c = 'THREW ' + e.message; }
  console.log(`  ${JSON.stringify(seg).padEnd(14)} → ${JSON.stringify(c)}`);
}

console.log('\n--- translateSelector ---');
for (const seg of ['.txt-list', 'li', 'a.0', 'ul@li']) {
  console.log(`  ${JSON.stringify(seg).padEnd(14)} → ${JSON.stringify(R.translateSelector(seg))}`);
}

console.log('\n--- 页面结构 ---');
console.log('  .txt-list 数量 =', $('.txt-list').length);
console.log('  .txt-list 的 outerHTML（前 400）:');
console.log('   ', ($('.txt-list').first().html() || '(空)').replace(/\s+/g, ' ').slice(0, 400));

console.log('\n--- 手动模拟第一段 ---');
const first = R.evalRule('.txt-list', $, {}, {});
console.log('  evalRule(".txt-list") elems =', first.elems ? first.elems.length : 'null');

if (first.elems && first.elems.length) {
  const el = first.elems;
  console.log('  该集合上 find("li") =', el.find('li').length);
  console.log('  该集合上 children("li") =', el.children('li').length);
  console.log('  该集合上 filter("li") =', el.filter('li').length);
  console.log('  集合内元素 tagName =', el.map((_i, e) => e.tagName).get().join(','));
}

console.log('\n--- evalRule 整条 .txt-list@li ---');
const whole = R.evalRule('.txt-list@li', $, {}, {});
console.log('  elems =', whole.elems ? whole.elems.length : 'null', 'strings =', JSON.stringify(whole.strings));
