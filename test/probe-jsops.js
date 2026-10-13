'use strict';
/*
 * 扫描：真实的 @js: / <js> 规则体里是否有「顶层」（不在括号/引号内）的 && || %%
 * 这些会被当前引擎的组合符切分误伤。
 * 跑法：node test/probe-jsops.js
 */
const fs = require('fs');
const path = require('path');
const R = require(path.join(__dirname, '..', 'src', 'rules', 'rule.js'));

const DIR = 'D:/AI/工作区/_recon';

// 复刻 JS_PATTERN: <js>([\w\W]*?)</js>|@js:([\w\W]*)
function jsBlocks(s) {
  const out = [];
  const re = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;
  let m;
  while ((m = re.exec(s)) !== null) out.push({ code: m[2] != null && m[2] !== '' ? m[2] : m[1], at: m.index });
  return out;
}

// 找顶层（括号/引号外）操作符
function topOps(code, op) {
  const parts = R.splitOp(code, op);
  return parts.length > 1 ? parts : null;
}

let total = 0;
const bad = [];
for (const f of fs.readdirSync(DIR).filter((x) => /^src_\d+\.json$/.test(x))) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const s of Array.isArray(raw) ? raw : [raw]) {
    const walk = (o, pfx) => {
      if (typeof o === 'string') {
        const blocks = jsBlocks(o);
        for (const b of blocks) {
          total++;
          const andP = topOps(b.code, '&&');
          const orP = topOps(b.code, '||');
          const modP = topOps(b.code, '%%');
          if (andP || orP || modP) {
            bad.push({
              src: f, name: s.bookSourceName, field: pfx,
              ops: [andP && '&&', orP && '||', modP && '%%'].filter(Boolean).join(','),
              head: JSON.stringify(b.code.trim().slice(0, 90)),
            });
          }
        }
        return;
      }
      if (Array.isArray(o)) { o.forEach((v, i) => walk(v, pfx + '[' + i + ']')); return; }
      if (o && typeof o === 'object') { for (const k of Object.keys(o)) walk(o[k], pfx ? pfx + '.' + k : k); }
    };
    walk(s, '');
  }
}

console.log(`共扫描 JS 块 ${total} 个，其中顶层含组合符的 ${bad.length} 个：\n`);
for (const b of bad) {
  console.log(`  [${b.name}] ${b.field}  含 ${b.ops}`);
  console.log(`      ${b.head}…`);
}
