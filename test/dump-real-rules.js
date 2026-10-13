'use strict';
const fs = require('fs');
const path = require('path');
const DIR = 'D:/AI/工作区/_recon';
for (const f of ['src_7036.json', 'src_7908.json', 'src_7940.json']) {
  let raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (Array.isArray(raw)) raw = raw[0];
  console.log(`\n########## ${raw.bookSourceName} (${f}) ##########`);
  if (f === 'src_7036.json') {
    console.log('--- ruleToc.chapterList ---');
    console.log(JSON.stringify(raw.ruleToc.chapterList));
  }
  if (f === 'src_7908.json') {
    console.log('--- ruleToc.chapterList ---');
    console.log(JSON.stringify(raw.ruleToc.chapterList));
  }
  if (f === 'src_7940.json') {
    console.log('--- searchUrl ---');
    console.log(JSON.stringify(raw.searchUrl));
    console.log('--- ruleContent.content ---');
    console.log(JSON.stringify(raw.ruleContent.content));
  }
}
