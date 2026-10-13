// 检查目录页（tocUrl 指向的 /book/60434/1.html）的真实结构
// 目的：确认 .info_dv3.1 为何为空，以及分页（nextTocUrl）如何工作
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const file = process.argv[2] || path.join(__dirname, '.cache', '7941-toc-desktop.html');
const html = fs.readFileSync(file, 'utf8');
console.log('file:', file, 'len:', html.length);

const $ = cheerio.load(html, null, false);

// 1. 所有 class 含 info_dv 的元素
console.log('\n=== class 含 info_dv 的元素 ===');
$('[class*="info_dv"]').each((i, el) => {
  const $el = $(el);
  console.log(`  [${i}] tag=${el.tagName} class="${$el.attr('class')}" ul=${$el.find('ul').length} a=${$el.find('a').length} li=${$el.find('li').length}`);
  const t = $el.find('.title').first().text().trim();
  if (t) console.log(`       title="${t}"`);
});

// 2. 章节链接出现在哪里
console.log('\n=== a[href*=yuedu] 的父链 ===');
const yuedu = $('a[href*="yuedu"]');
console.log('  数量:', yuedu.length);
yuedu.slice(0, 3).each((i, el) => {
  const chain = [];
  let cur = $(el);
  for (let d = 0; d < 5 && cur.length; d++) {
    chain.push(`${cur[0].tagName}${cur.attr('class') ? '.' + String(cur.attr('class')).split(/\s+/).join('.') : ''}`);
    cur = cur.parent();
  }
  console.log(`  [${i}] text="${$(el).text().trim()}" href="${$(el).attr('href')}"`);
  console.log(`       链: ${chain.join(' < ')}`);
});

// 3. onclick read_tz 所在容器
console.log('\n=== onclick="read_tz(" 的父链 ===');
const rtz = $('a[onclick*="read_tz"]');
console.log('  数量:', rtz.length);
rtz.slice(0, 3).each((i, el) => {
  const chain = [];
  let cur = $(el);
  for (let d = 0; d < 6 && cur.length; d++) {
    chain.push(`${cur[0].tagName}${cur.attr('class') ? '.' + String(cur.attr('class')).split(/\s+/).join('.') : ''}${cur.attr('id') ? '#' + cur.attr('id') : ''}`);
    cur = cur.parent();
  }
  console.log(`  [${i}] text="${$(el).text().trim()}" onclick="${$(el).attr('onclick')}"`);
  console.log(`       链: ${chain.join(' < ')}`);
});

// 4. select / option（nextTocUrl = option[selected]+option@value）
console.log('\n=== select / option ===');
$('select').each((i, el) => {
  const $s = $(el);
  console.log(`  select[${i}] name=${$s.attr('name')} class=${$s.attr('class')} option数=${$s.find('option').length}`);
  $s.find('option').slice(0, 8).each((j, op) => {
    console.log(`     option[${j}] value="${$(op).attr('value')}" text="${$(op).text().trim()}" selected=${$(op).attr('selected') !== undefined}`);
  });
});

// 5. 分页区
console.log('\n=== page_num / 分页 ===');
$('[class*="page"]').each((i, el) => {
  const $el = $(el);
  console.log(`  [${i}] tag=${el.tagName} class="${$el.attr('class')}" text="${$el.text().trim().slice(0, 80)}"`);
});
