// 打印 7908 神文小说 / 7940 uu书库 的关键规则全文
const fs = require('fs');
const path = require('path');
const RECON = 'D:/AI/工作区/_recon';
function load(id) {
  const raw = JSON.parse(fs.readFileSync(path.join(RECON, `src_${id}.json`), 'utf8'));
  return Array.isArray(raw) ? raw : raw;
}
for (const id of ['7908', '7940']) {
  const arr = load(id);
  for (const s of arr) {
    console.log('='.repeat(72));
    console.log(`[${id}] ${s.bookSourceName} ${s.bookSourceUrl}`);
    for (const k of ['ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent']) {
      console.log(`--- ${k} ---`);
      const o = s[k] || {};
      for (const [kk, vv] of Object.entries(o)) {
        console.log(`  ${kk} = ${JSON.stringify(vv)}`);
      }
    }
    console.log(`  searchUrl = ${JSON.stringify(s.searchUrl)}`);
  }
}
