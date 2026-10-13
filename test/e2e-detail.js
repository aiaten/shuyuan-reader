'use strict';
/**
 * 端到端验证（目录页 = 详情页）：用于书源 tocUrl 指向分页目录页、但 chapterList 规则
 * 实际写在详情页上的场景（如 7941 最终小说网，bookSourceGroup="测试"）。
 *
 * 用法: node test/e2e-detail.js [书源id] [关键词] [章序号]
 */
const fs = require('fs');
const path = require('path');
const { SourceEngine } = require('../src/engine/source');

const id = process.argv[2] || '7941';
const keyword = process.argv[3] || '诡秘之主';
const chapterIdx = parseInt(process.argv[4] || '0', 10);
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function loadSource(sid) {
  const p = path.join(__dirname, '..', '..', '_recon', `src_${sid}.json`);
  let raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (Array.isArray(raw)) raw = raw[0];
  return raw;
}
const ms = (t) => `${Date.now() - t}ms`;
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
  if (!results.length) { console.log('搜索无结果，终止'); return; }
  const book = results[0];
  console.log(`  ${clip(book.name, 40)} | ${clip(book.author, 16)} | ${clip(book.bookUrl, 90)}`);

  t = Date.now();
  const info = await engine.bookInfo(book.bookUrl);
  console.log(`\n[详情] ${ms(t)}  tocUrl(书源给的) = ${clip(info.tocUrl, 100)}`);

  // 关键差异：故意用 bookUrl（详情页）当目录页
  t = Date.now();
  const toc = await engine.toc(book.bookUrl);
  console.log(`\n[目录@详情页] ${ms(t)}  共 ${toc.length} 章`);
  toc.slice(0, 4).forEach((c, i) => console.log(`  ${i + 1}. ${clip(c.name, 50)} → ${clip(c.url, 90)}`));
  if (toc.length) console.log(`  … 末章: ${clip(toc[toc.length - 1].name, 50)} → ${clip(toc[toc.length - 1].url, 90)}`);
  if (!toc.length) { console.log('目录为空，终止'); return; }

  const ch = toc[Math.min(chapterIdx, toc.length - 1)];
  const nextCh = toc[Math.min(chapterIdx, toc.length - 1) + 1];
  t = Date.now();
  const res = await engine.content(ch.url, nextCh ? { nextChapterUrl: nextCh.url } : {});
  console.log(`\n[正文] ${ms(t)}  ${clip(ch.name, 40)}  长度 ${res.text.length} 字  页数 ${res.pageCount}`);
  console.log(`  章节标题规则给出: ${clip(res.title, 60)}`);
  console.log(`  页 URL: ${res.pageUrls.map((u) => u.replace(/^https?:\/\/[^/]+/, '')).join('  ')}`);
  console.log(`  next=${clip(res.nextContentUrl, 60)}`);
  console.log('  --- 前 400 字 ---');
  console.log('  ' + clip(res.text, 400));
  console.log(`\n[统计] 请求数=${engine.requestCount}  诊断=${JSON.stringify(engine.lastDiagnostics)}`);
})().catch((e) => { console.error('FAILED:', e.stack || e); process.exit(1); });
