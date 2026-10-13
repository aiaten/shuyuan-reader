'use strict';
const fs = require('fs');
const path = require('path');
const DIR = 'D:/AI/工作区/_recon';
for (const f of ['src_7036.json', 'src_7908.json']) {
  let raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (Array.isArray(raw)) raw = raw[0];
  console.log(`\n########## ${raw.bookSourceName} (${f}) ##########`);
  console.log('ruleToc = ' + JSON.stringify(raw.ruleToc, null, 1));
}
