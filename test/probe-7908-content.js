// 直接跑 7908 正文，打印真实换行结构（不经 e2e-detail 的 clip 折叠）
const { SourceEngine } = require('../src/engine/source');
const fs = require('fs');
const path = require('path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '_recon', 'src_7908.json'), 'utf8'));
const src = Array.isArray(raw) ? raw[0] : raw;

(async () => {
  const engine = new SourceEngine(src, {});
  const list = await engine.search('诡秘之主');
  const book = await engine.bookInfo(list[0].bookUrl);
  const chapters = await engine.toc(book.tocUrl);
  const res = await engine.content(chapters[0].url);
  console.log('长度', res.text.length, '页数', res.pageCount);
  console.log('--- 前 12 行 (JSON) ---');
  console.log(JSON.stringify(res.text.split('\n').slice(0, 12), null, 0));
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
