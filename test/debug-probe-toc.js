'use strict';
/** 调试：探测里 toc 失败的这本书，tocUrl 到底是什么 */
const fs = require('fs');
const path = require('path');
const { SourceEngine } = require('../src/engine/source');
const { CookieJar } = require('../src/net/cookiejar');

const src = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '_recon', 'src_7941.json'), 'utf8'))[0];

(async () => {
  const engine = new SourceEngine(src, { jar: new CookieJar() });
  const items = await engine.search('剑', 1);
  console.log(`搜索 ${items.length} 条`);
  const first = items[0];
  console.log(`first: ${JSON.stringify(first, null, 2)}`);

  const info = await engine.bookInfo(first.bookUrl);
  console.log(`\nbookInfo: ${JSON.stringify(info, null, 2)}`);

  const toc = await engine.toc(info.tocUrl);
  console.log(`\ntocUrl=${info.tocUrl} → ${toc ? toc.length : 'null'} 章`);
  if (toc && toc.length) console.log(`  首: ${toc[0].name} → ${toc[0].url}`);
  console.log(`诊断: ${JSON.stringify(engine.lastDiagnostics)}`);
})().catch((e) => { console.error(e); process.exit(1); });
