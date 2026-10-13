'use strict';
/*
 * 探针：把 7 个真实书源里所有含 && / || / %% 的规则捞出来，看：
 *   1. 操作符出现在哪一层（URL 规则 / bookList 元素选择 / 字段取值）
 *   2. 首个出现的是哪个操作符（Legado 用「最先出现的」决定整串怎么切）
 *   3. 两侧的形态（选择器 vs 提取动作 vs 索引语法）
 * 跑法：node test/probe-combo.js
 */
const fs = require('fs');
const path = require('path');

const DIR = 'D:/AI/工作区/_recon';
const FIELDS = [
  'searchUrl', 'exploreUrl', 'loginUrl',
];
const RULE_GROUPS = ['ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'];
const EXPLORE_FIELDS = ['bookList', 'name', 'author', 'kind', 'intro', 'coverUrl', 'bookUrl', 'lastChapter'];

function firstOp(s) {
  let depth = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q && s[i - 1] !== '\\') q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === '[' || ch === '(' || ch === '{') { depth++; continue; }
    if (ch === ']' || ch === ')' || ch === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    if (s.startsWith('&&', i)) return { op: '&&', pos: i };
    if (s.startsWith('||', i)) return { op: '||', pos: i };
    if (s.startsWith('%%', i)) return { op: '%%', pos: i };
  }
  return null;
}

const files = fs.readdirSync(DIR).filter((f) => /^src_\d+\.json$/.test(f)).sort();
let total = 0;

for (const f of files) {
  let raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (Array.isArray(raw)) raw = raw[0];
  const name = raw.bookSourceName;
  const hits = [];
  const scan = (label, rule) => {
    if (typeof rule !== 'string' || !rule) return;
    // 先把 <js>...</js> / @js:... 抠掉，只看「非 JS 文本段」里的操作符
    const jsFree = rule.replace(/<js>[\s\S]*?<\/js>/gi, '\u0001').replace(/@js:[\s\S]*/i, '\u0001');
    const op = firstOp(jsFree);
    if (!op) return;
    hits.push({ label, op: op.op, pos: op.pos, len: rule.length, rule });
  };

  for (const f2 of FIELDS) scan(f2, raw[f2]);
  for (const g of RULE_GROUPS) {
    const grp = raw[g];
    if (!grp) continue;
    if (Array.isArray(grp)) {
      grp.forEach((it, i) => {
        for (const k of Object.keys(it)) scan(`${g}[${i}].${k}`, it[k]);
      });
    } else {
      for (const k of Object.keys(grp)) scan(`${g}.${k}`, grp[k]);
    }
  }
  if (Array.isArray(raw.ruleExplore)) {
    raw.ruleExplore.forEach((it, i) => {
      for (const k of Object.keys(it)) scan(`ruleExplore[${i}].${k}`, it[k]);
    });
  }

  if (!hits.length) continue;
  console.log(`\n===== ${name} (${f}) : ${hits.length} 条组合符规则 =====`);
  for (const h of hits) {
    total++;
    console.log(`\n-- [${h.label}] 首个操作符=${h.op}@pos${h.pos} len=${h.len}`);
    console.log(h.rule.length > 400 ? h.rule.slice(0, 400) + ' …' : h.rule);
  }
}
console.log(`\n合计 ${total} 条`);
