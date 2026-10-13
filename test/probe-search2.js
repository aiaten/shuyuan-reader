'use strict';
/** 保存搜索结果页并分析其真实结构 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const http = require('../src/net/http');
const { CookieJar } = require('../src/net/cookiejar');

const KEY = '诡秘之主';

(async () => {
  const jar = new CookieJar();
  await http.request('https://www.zuizhong.net/', { jar });
  const r = await http.request('https://www.zuizhong.net/search.html', {
    method: 'POST',
    body: `s=${KEY}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    jar,
  });
  const out = path.join(__dirname, '.cache', '7941-search-ok.html');
  fs.writeFileSync(out, r.text, 'utf8');
  console.log(`已保存 ${out}  ${r.body.length}B`);

  const $ = cheerio.load(r.text);
  console.log('\n--- 常见候选选择器命中数 ---');
  for (const sel of ['.txt-list', 'li', 'ul', 'a', '.book', '.result', '.novel', '.item', '.list', 'table', 'dl', 'dt', 'dd']) {
    console.log(`  ${sel.padEnd(12)} ${$(sel).length}`);
  }

  console.log('\n--- 出现"诡秘"的上下文 ---');
  const html = r.text;
  let idx = 0;
  let n = 0;
  while ((idx = html.indexOf(KEY, idx)) !== -1 && n < 3) {
    console.log(`  ...${html.slice(Math.max(0, idx - 300), idx + 150).replace(/\s+/g, ' ')}...`);
    console.log('  ---');
    idx += KEY.length;
    n++;
  }
})().catch((e) => { console.error('FAILED:', e.stack || e); process.exit(1); });
