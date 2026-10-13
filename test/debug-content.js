'use strict';
/* 调试正文规则：node test/debug-content.js [缓存html] [规则] */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const R = require('../src/rules/rule.js');

const file = process.argv[2] || path.join(__dirname, '.cache', '7941-chapter.html');
const rule = process.argv[3] || '.info_dv1@p[1:-2]@text';
const html = fs.readFileSync(file, 'utf8');
console.log('文件:', file, 'len=', html.length);
console.log('规则:', rule);

const $ = cheerio.load(html);
const segs = R.splitTop(rule, '@');
console.log('段:', JSON.stringify(segs));
for (const s of segs) {
  console.log('  classifySegment(', JSON.stringify(s), ') =', JSON.stringify(R.classifySegment(s)));
}
try {
  console.log('translateSelector(段1) =', JSON.stringify(R.translateSelector(segs[0])));
} catch (e) {
  console.log('translateSelector 抛错:', e.message);
}

const ctx = { baseUrl: 'https://www.zuizhong.net/', source: {}, js: null };
const r = R.evalRule(rule, $, ctx, {});
console.log('结果: strings.length=', r.strings.length, ' elems=', r.elems ? r.elems.length : null);
console.log('strings[0..2] =', JSON.stringify(r.strings.slice(0, 3)).slice(0, 300));
console.log('text 前 200 =', String(r.text).slice(0, 200));
