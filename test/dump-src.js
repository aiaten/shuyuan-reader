'use strict';
/* 打印书源关键规则，便于人工核对。用法: node test/dump-src.js <id> [字段...] */
const fs = require('fs');
const path = require('path');

const id = process.argv[2] || '7940';
const keys = process.argv.slice(3);
const p = path.join(__dirname, '..', '..', '_recon', `src_${id}.json`);
let raw = JSON.parse(fs.readFileSync(p, 'utf8'));
if (Array.isArray(raw)) raw = raw[0];

const show = keys.length ? keys : ['bookSourceName', 'bookSourceUrl', 'searchUrl', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'header', 'exploreUrl'];
for (const k of show) {
  const v = raw[k];
  console.log(`--- ${k} ---`);
  if (typeof v === 'string') console.log(v);
  else console.log(JSON.stringify(v, null, 2));
}
