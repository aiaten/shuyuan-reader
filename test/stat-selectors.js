'use strict';
/* 扫描书源里的选择器简写形态：node test/stat-selectors.js */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', '..', '_recon');
const counts = new Map();
const samples = new Map();
const bump = (k, src) => {
  counts.set(k, (counts.get(k) || 0) + 1);
  if (!samples.has(k)) samples.set(k, new Set());
  if (samples.get(k).size < 4) samples.get(k).add(src);
};

for (const f of fs.readdirSync(dir).filter((x) => /^src_\d+\.json$/.test(x))) {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
  if (!Array.isArray(arr)) arr = [arr];
  for (const src of arr) {
    const walk = (v) => {
      if (typeof v === 'string') {
        // 找出所有 class./tag./id./text. 简写（允许前面有 @ 或引号）
        for (const m of v.matchAll(/(?:^|[@|"'(\s])((?:class|tag|id|text)\.[^@"'|\s()]+)/g)) {
          const tok = m[1];
          const parts = tok.split('.');
          const key = `${parts[0]}.${parts.length} 段  (${parts[0]}.${parts[1]}${parts.length > 2 ? '.…' : ''})`;
          bump(key, `${src.bookSourceName || f}: ${tok}`);
        }
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(src);
  }
}

const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log('简写形态统计（键 = 前缀.段数）:');
for (const [k, n] of rows) {
  console.log(`  ${String(n).padStart(3)}  ${k}`);
  for (const s of samples.get(k)) console.log(`         e.g. ${s}`);
}
