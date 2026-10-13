'use strict';
// 临时辅助：统计 unit-yck.js 的花括号深度变化，找出未闭合的块。
const fs = require('fs');
const s = fs.readFileSync('D:/AI/工作区/novel-reader/test/unit-yck.js', 'utf8');
let depth = 0;
let ln = 1;
let inStr = null; // '"' | "'" | '`'
let inLineComment = false;
let inBlockComment = false;
let prev = '';
const transitions = [];
for (let i = 0; i < s.length; i++) {
  const ch = s[i];
  const next = s[i + 1];
  if (ch === '\n') { ln++; inLineComment = false; prev = ch; continue; }
  if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i++; } continue; }
  if (inLineComment) continue;
  if (inStr) {
    if (ch === '\\') { i++; continue; }
    if (ch === inStr) inStr = null;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
  if (ch === '/' && next === '/') { inLineComment = true; continue; }
  if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
  if (ch === '{') { depth++; if (depth <= 3) transitions.push(ln + ': OPEN  d=' + depth + '  ' + s.slice(i, i + 40).split('\n')[0]); continue; }
  if (ch === '}') { depth--; if (depth <= 2) transitions.push(ln + ': CLOSE d=' + depth + '  ' + s.slice(i - 30, i + 2).split('\n').pop()); continue; }
}
console.log('final depth =', depth);
console.log(transitions.filter((t) => Number(t.split(':')[0]) >= 28).join('\n'));
