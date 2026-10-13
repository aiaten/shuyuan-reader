// 复现 7940 目录解析路径
const { SourceEngine } = require('../src/engine/source');
const fs = require('fs');
const path = require('path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '_recon', 'src_7940.json'), 'utf8'));
const src = Array.isArray(raw) ? raw[0] : raw;

(async () => {
  const engine = new SourceEngine(src, {});
  const list = await engine.search('诡秘之主');
  console.log('搜索 =', list.length, '首条 =', list[0] && list[0].bookUrl);
  const book = await engine.bookInfo(list[0].bookUrl);
  console.log('bookInfo tocUrl =', book.tocUrl);
  console.log('ruleToc.chapterList 前 80 =', String(src.ruleToc.chapterList).slice(0, 80));
  const chapters = await engine.toc(book.tocUrl);
  console.log('目录 =', chapters.length);
  console.log('前 3 章 =', JSON.stringify(chapters.slice(0, 3), null, 1));
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
