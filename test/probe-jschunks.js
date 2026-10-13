// 扫描所有书源规则，找出「@js: / <js> 块前面还有非 JS 文本」的规则（即需要流水线语义的）
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/AI/工作区/_recon';
const JS_RE = /<js>([\s\S]*?)<\/js>|@js:([\s\S]*)/gi;

const fields = ['searchUrl', 'exploreUrl', 'loginUrl'];
const ruleGroups = ['ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleExplore'];

let total = 0;
let piped = 0;
for (const f of fs.readdirSync(ROOT)) {
  if (!/^src_\d+\.json$/.test(f)) continue;
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const list = Array.isArray(raw) ? raw : [raw];
  for (const src of list) {
    const name = src.bookSourceName;
    const check = (label, rule) => {
      if (typeof rule !== 'string' || !rule) return;
      JS_RE.lastIndex = 0;
      const ms = [...rule.matchAll(JS_RE)];
      if (!ms.length) return;
      total++;
      const hasTextBefore = ms.some((m) => m.index > 0 && rule.slice(0, m.index).trim() !== '');
      const hasTextAfter = ms.some((m) => rule.slice(m.index + m[0].length).trim() !== '');
      if (hasTextBefore || hasTextAfter) {
        piped++;
        console.log(`\n=== ${name} (${label}) 前文本=${hasTextBefore} 后文本=${hasTextAfter}`);
        for (const m of ms) {
          const pre = rule.slice(0, m.index).trim();
          const chunk = (m[2] != null && m[2] !== '' ? m[2] : m[1]);
          const post = rule.slice(m.index + m[0].length).trim();
          if (pre) console.log(`  [前] ${pre}`);
          console.log(`  [JS] ${chunk.slice(0, 240).replace(/\n/g, ' ')}${chunk.length > 240 ? '…' : ''}`);
          if (post) console.log(`  [后] ${post.slice(0, 160)}`);
        }
      }
    };
    for (const k of fields) check(k, src[k]);
    for (const g of ruleGroups) {
      const grp = src[g];
      if (Array.isArray(grp)) grp.forEach((it, i) => Object.entries(it || {}).forEach(([k, v]) => check(`${g}[${i}].${k}`, v)));
      else if (grp && typeof grp === 'object') Object.entries(grp).forEach(([k, v]) => check(`${g}.${k}`, v));
    }
  }
}
console.log(`\n含 JS 块的规则共 ${total} 条，其中「有前后文本」的 ${piped} 条`);
