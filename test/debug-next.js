'use strict';
/** 调试 nextContentUrl 规则：node test/debug-next.js [缓存html] [规则] */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const R = require('../src/rules/rule');

const file = process.argv[2] || path.join(__dirname, '.cache', '7941-chapter.html');
const rule = process.argv[3] || 'text.下一@href';
const html = fs.readFileSync(file, 'utf8');
const $ = cheerio.load(html);
console.log('文件:', file, 'len=', html.length);
console.log('规则:', JSON.stringify(rule));

const segs = R.splitTop(rule, '@');
console.log('段:', JSON.stringify(segs));

const r = R.evalRule(rule, $, {}, {});
console.log('strings =', JSON.stringify(r.strings));
console.log('text =', JSON.stringify(r.text));

// 列出所有含「下一」的元素
const hits = [];
$('*').each((_i, el) => {
  const $el = $(el);
  const own = $el.contents().filter((_j, n) => n.type === 'text').text();
  if (own.includes('下一') || $el.text().includes('下一')) {
    const tag = el.tagName || el.name;
    hits.push({
      tag,
      own: own.replace(/\s+/g, ' ').trim().slice(0, 30),
      full: $el.text().replace(/\s+/g, ' ').trim().slice(0, 40),
      href: $el.attr('href') || null,
      cls: $el.attr('class') || null,
      id: $el.attr('id') || null,
      children: $el.children().length,
    });
  }
});
console.log('\n含「下一」的元素共', hits.length, '个:');
hits.slice(0, 25).forEach((h, i) => console.log(` ${i}. <${h.tag} class="${h.cls}" id="${h.id}"> own="${h.own}" full="${h.full}" href=${JSON.stringify(h.href)} kids=${h.children}`));
