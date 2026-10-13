'use strict';
/**
 * 端到端：真实书源 → 搜索 → 加书架 → 抓目录 → 下载前 N 章 → 导出 TXT。
 *
 * 用法: node test/e2e-full.js [书源id=7941] [关键词=诡秘之主] [下载章数=3]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SourceEngine } = require('../src/engine/source');
const { Library } = require('../src/store/library');
const { Downloader } = require('../src/store/downloader');
const { exportTxt } = require('../src/export/txt');
const yck = require('../src/source/yck');

const srcId = process.argv[2] || '7941';
const keyword = process.argv[3] || '诡秘之主';
const nChapters = parseInt(process.argv[4] || '3', 10);

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const ms = (t) => `${Date.now() - t}ms`;
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuyuan-e2e-'));
  const outDir = path.join(dataDir, 'export');
  console.log(`数据目录: ${dataDir}\n`);

  // 1. 下载书源
  let t = Date.now();
  const arr = await yck.download(srcId);
  const source = arr[0];
  console.log(`[书源] ${ms(t)}  ${source.bookSourceName} — ${source.bookSourceUrl}`);

  const library = new Library(dataDir);
  const dl = new Downloader({
    library,
    dataDir,
    concurrency: 3,
    logger: (m) => console.log('  · ' + m),
  });
  const engine = new SourceEngine(source, { httpOptions: { headers: { 'User-Agent': DESKTOP_UA } } });

  // 2. 搜索
  t = Date.now();
  const list = await engine.search(keyword, 1);
  console.log(`\n[搜索] ${ms(t)}  命中 ${list.length} 条`);
  if (!list.length) throw new Error('搜索无结果');
  list.slice(0, 3).forEach((b, i) => console.log(`  ${i}. ${clip(b.name, 40)} | ${b.author}`));

  // 3. 加书架 + 抓目录
  t = Date.now();
  const added = await dl.addBook(source, list[0]);
  console.log(`\n[加书架] ${ms(t)}  id=${added.id}  《${added.name}》  目录 ${added.chapterCount} 章`);

  // 4. 下载正文
  const from = 0;
  const to = Math.min(nChapters - 1, added.chapterCount - 1);
  t = Date.now();
  const res = await dl.downloadChapters(source, added.id, {
    from,
    to,
    onProgress: (p) => console.log(`  ${p.status.padEnd(5)} 第${p.index + 1}章`),
  });
  console.log(`\n[下载] ${ms(t)}  成功 ${res.done} / 跳过 ${res.skipped} / 失败 ${res.failed}`);

  // 5. 再次下载（验证断点续传）
  const res2 = await dl.downloadChapters(source, added.id, { from, to });
  console.log(`[续传] 跳过 ${res2.skipped} / 新下 ${res2.done}（应全部跳过）`);

  // 6. 导出 TXT（三种布局 × 两种编码）
  const book = library.get(added.id);
  const toc = library.toc(added.id);
  const getChapter = (i) => library.chapter(added.id, i);

  console.log('\n[导出]');
  let exportChecked = 0;
  for (const layout of ['single', 'chapter', 'volume']) {
    for (const encoding of ['utf-8', 'gbk']) {
      const dir = path.join(outDir, `${layout}-${encoding}`);
      const r = exportTxt({ book, toc, getChapter, outDir: dir, options: { layout, encoding } });
      const names = r.files.map((f) => path.basename(f.path));
      console.log(
        `  ${layout.padEnd(8)} ${encoding.padEnd(6)} ${r.files.length} 个文件 ` +
          `${r.chapters} 章 ${(r.bytes / 1024).toFixed(1)}KB  例: ${names[0]}${names.length > 1 ? ` … +${names.length - 1}` : ''}`
      );

      // 校验：每个文件都能按目标编码解回，且章节标题不重复、正文非空
      const iconv = require('iconv-lite');
      for (const f of r.files) {
        const raw = fs.readFileSync(f.path);
        const txt = encoding === 'utf-8' ? raw.toString('utf8') : iconv.decode(raw, encoding);
        if (txt.includes('\ufffd') && encoding === 'utf-8') {
          console.log(`    ⚠ ${path.basename(f.path)} utf-8 解出替换字符`);
        }
        // 章标题重复检测：同一标题连续出现两次即为 bug
        const dup = /^(第\d+章)\s*\n+\1$/m.test(txt) || /第1章 第1章/.test(txt);
        if (dup) console.log(`    ⚠ ${path.basename(f.path)} 章节标题重复`);
        // 正文出现第一个章节标题后必须还有正文（书籍信息文件本身没有正文，跳过）
        const isMeta = /^__/.test(path.basename(f.path));
        const m = /第(\d+)章/.exec(txt);
        if (m && !isMeta) {
          const after = txt.slice(txt.indexOf(m[0]));
          if (after.length < 200) console.log(`    ⚠ ${path.basename(f.path)} 疑似只有标题无正文`);
        }
        exportChecked++;
      }
    }
  }
  console.log(`  共校验 ${exportChecked} 个导出文件`);

  // 7. 书架统计
  console.log(`\n[书架] 共 ${library.books().length} 本，已下载章节 ${library.downloadedIndexes(added.id).length} 章`);
  console.log(`[书目] ${library.books().map((b) => `${b.name}(${b.downloadedCount}/${b.chapterCount})`).join(', ')}`);
  console.log(`\n导出的文件在: ${outDir}`);
  console.log(JSON.stringify(engine.lastDiagnostics));
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
