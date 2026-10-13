'use strict';
/** 看 div.ylist 卡片的完整结构（含标签/作者/下载量/时间） */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const f = process.argv[2] || path.join(__dirname, '..', '..', '_recon', 'index.html');
const $ = cheerio.load(fs.readFileSync(f, 'utf8'));
const yl = $('.ylist');
console.log(`div.ylist 命中 ${yl.length}`);
console.log('\n=== 第 1 个 ===\n' + yl.eq(0).html());
console.log('\n=== 第 3 个 ===\n' + (yl.eq(2).length ? yl.eq(2).html() : '(无)'));
console.log('\n=== 含「发」「搜」标签的卡 ===');
yl.each((i, el) => {
  const t = $(el).text();
  if (/[发搜图声]/.test(t) && i < 5) console.log(`  [${i}] ${t.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
});
