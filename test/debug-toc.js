/* 离线调试：目录页结构分析
 * 用法: node test/debug-toc.js [缓存html路径]
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const file = process.argv[2] || path.join(__dirname, '.cache', '7941-toc.html');
const html = fs.readFileSync(file, 'utf8');
const $ = cheerio.load(html);

console.log('.info_dv3       =', $('.info_dv3').length);
console.log('.info_dv3.1     =', $('.info_dv3').eq(1).length);

$('.info_dv3').each((i, el) => {
  const $el = $(el);
  console.log(`  [${i}] class=${JSON.stringify($el.attr('class'))} ul=${$el.find('ul').length} a=${$el.find('a').length}`);
});

const eq1 = $('.info_dv3').eq(1);
console.log('--- eq(1) find ul a =', eq1.find('ul').find('a').length);
console.log('--- 全页 ul a      =', $('ul').find('a').length);
console.log('page title:', JSON.stringify($('title').text()));

// 打印前若干个 a 的文本/href，看目录链接长什么样
const links = $('ul a').slice(0, 5);
links.each((i, el) => {
  console.log(`  a[${i}] text=${JSON.stringify($(el).text().trim())} href=${JSON.stringify($(el).attr('href'))}`);
});

// 找 select/option（nextTocUrl 规则用 option[selected]+option@value）
console.log('option count =', $('option').length, '| select count =', $('select').length);
