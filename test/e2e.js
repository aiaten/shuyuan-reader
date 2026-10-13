'use strict';
/**
 * 端到端验证：最终小说网 7941（纯 CSS 规则）
 * 用法: node test/e2e.js [书源id] [关键词]
 * 链路: search -> bookInfo -> toc -> content
 */
const fs = require('fs');
const path = require('path');
const { SourceEngine } = require('../src/engine/source');

const id = process.argv[2] || '7941';
const keyword = process.argv[3] || '诡秘之主';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function loadSource(id) {
  const p = path.join(__dirname, '..', '..', '_recon', `src_${id}.json`);
  let raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (Array.isArray(raw)) raw = raw[0];
  return raw;
}

function ms(t) { return `${Date.now() - t}ms`; }
function clip(s, n = 120) {
  if (s == null) return String(s);
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

(async () => {
  const source = loadSource(id);
  console.log(`书源: ${source.bookSourceName} (${source.bookSourceUrl})`);
  const engine = new SourceEngine(source, { httpOptions: { headers: { 'User-Agent': DESKTOP_UA } } });

  let t = Date.now();
  const results = await engine.search(keyword, 1);
  console.log(`\n[搜索] ${ms(t)}  命中 ${results.length} 条`);
  results.slice(0, 5).forEach((b, i) => {
    console.log(`  ${i + 1}. ${clip(b.name, 40)} | 作者=${clip(b.author, 20)} | 分类=${clip(b.kind, 16)}`);
    console.log(`     url=${clip(b.bookUrl, 100)}`);
  });
  if (!results.length) { console.log('搜索无结果，终止'); return; }

  const book = results[0];
  t = Date.now();
  const info = await engine.bookInfo(book.bookUrl);
  console.log(`\n[详情] ${ms(t)}`);
  for (const k of ['name', 'author', 'kind', 'lastChapter', 'coverUrl', 'tocUrl']) {
    console.log(`  ${k.padEnd(12)} = ${clip(info[k], 100)}`);
  }
  console.log(`  intro        = ${clip(info.intro, 160)}`);

  const tocUrl = info.tocUrl || book.bookUrl;
  t = Date.now();
  const toc = await engine.toc(tocUrl);
  console.log(`\n[目录] ${ms(t)}  共 ${toc.length} 章`);
  toc.slice(0, 4).forEach((c, i) => console.log(`  ${i + 1}. ${clip(c.name, 50)} → ${clip(c.url, 90)}`));
  if (toc.length > 4) console.log(`  … 末章: ${clip(toc[toc.length - 1].name, 50)}`);
  if (!toc.length) { console.log('目录为空，终止'); return; }

  t = Date.now();
  const content = await engine.content(toc[0].url);
  console.log(`\n[正文] ${ms(t)}  第1章 ${clip(toc[0].name, 40)}  长度 ${content.length} 字`);
  console.log(`  --- 前 300 字 ---`);
  console.log('  ' + clip(content, 300));

  console.log(`\n[统计] 请求数=${engine.requestCount}  诊断=${JSON.stringify(engine.lastDiagnostics)}`);
})().catch((e) => { console.error('FAILED:', e.stack || e); process.exit(1); });
