#!/usr/bin/env node
'use strict';
/**
 * 命令行界面：node src/cli.js <命令> [参数...]
 *
 * 命令：
 *   info                              显示数据目录与统计
 *   online list [--page N] [--keys K]  列出 yck2026.fun 在线书源
 *   online get <id>                    下载在线书源 JSON（打印）
 *   online install <id> [--no-probe]   安装在线书源（默认可读性探测准入）
 *   source list                        本地书源列表
 *   source add <file.json|-> [--no-probe] [--force]
 *   source test <file.json|->          只做结构校验 + 探测，不落盘
 *   source remove <key|名称>
 *   source export [--out f.json]
 *   source import <file.json> [--no-probe]
 *   search <书名> [--source KEY] [--page N]
 *   search <书名> --everywhere              全书源聚合搜索（并发/增量/熔断）
 *   check [--book <bookId>] [--dry-run] [--concurrency N]   检查书架小说有没有更新
 *   shelf                              书架列表
 *   add <sourceKey> <bookUrl>          按书地址加入书架（抓目录）
 *   download <bookId> [--from N] [--to N] [--force]
 *   read <bookId> [章节序号] [--chars N]   打印章节正文
 *   export <bookId|--all> [--layout single|chapter|volume] [--encoding utf-8|gbk]
 *                        [--out DIR] [--no-toc] [--lf]
 *   help
 */

const fs = require('fs');
const path = require('path');
const { App } = require('./app');
const { keyOf } = require('./source/store');

/* ---------------- 极简参数解析 ---------------- */

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const k = a.slice(2);
        const nxt = argv[i + 1];
        if (nxt != null && !nxt.startsWith('--')) {
          flags[k] = nxt;
          i++;
        } else {
          flags[k] = true;
        }
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

/** 读取 `-` 表示 stdin，否则读文件 */
function readInput(spec) {
  if (spec === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(spec, 'utf8');
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 列宽对齐（中文按 2 列宽计） */
function width(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}
function pad(s, n) {
  const w = width(s);
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

const HELP = `书源阅读器 CLI

用法: node src/cli.js <命令> [参数...]

书源库（在线 yck2026.fun 书源 + yckceo.com 订阅源）
  online list [--page N] [--keys 关键词] [--order time|down]   列出在线书源
  online get <id>                                             下载并打印书源 JSON
  online install <id> [--no-probe] [--keyword 词]              安装（默认做可读性探测）
  online update [--kind shuyuan|rss] [--days N] [--pages N]    刷新最近更新并同步安装
                 [--no-probe] [--force]

书源管理（本地）
  source list                                   本地书源
  source add <file.json|-> [--no-probe] [--force]
  source test <file.json|->                     只探测不落盘
  source check [--keyword 词] [--keys k1,k2]     批量校验本地书源（重跑可读性探测）
  source remove <key|名称>
  source import <file.json> [--no-probe]
  source export [--out 文件.json]

订阅源管理（Legado RSS，yckceo.com）
  rss list [--page N]                           在线订阅源列表
  rss install <id> [--force]                    从在线库安装订阅源
  rss import <file.json> [--force]              导入订阅源 JSON
  rss local                                     本地订阅源列表
  rss remove <key|名称>                         删除订阅源

搜索 / 阅读
  search <关键词> [--source KEY] [--page N]              单源搜索
  search <关键词> --everywhere [--concurrency N] [--timeout MS]
                                                         全书源聚合搜索（并发+增量+超时熔断）
  check [--book <bookId>] [--dry-run] [--concurrency N]   检查书架小说有没有更新
  shelf
  add <sourceKey> <bookUrl> [--download] [--to N]
  download <bookId> [--from N] [--to N] [--force]
  read <bookId> [章节序号=0] [--chars N]

导出 TXT
  export <bookId|--all> [--layout single|chapter|volume] [--encoding utf-8|gbk]
                        [--out 目录] [--no-toc] [--no-header] [--lf] [--bom]

其它
  info      数据目录与统计
  help      本帮助

环境变量 SHUYUAN_DATA 可指定数据目录（默认 <项目>/data）。
`;

/* ---------------- 命令实现 ---------------- */

async function cmdInfo(app) {
  const i = app.info();
  console.log('数据目录: ' + i.dataDir);
  console.log(`书源    : 共 ${i.sources.total} 个，已探测 ${i.sources.probed}，通过 ${i.sources.passed}`);
  console.log(`书架    : 共 ${i.books} 本，已下载 ${i.chapters} 章`);
}

async function cmdOnline(app, { pos, flags }) {
  const sub = pos[0];
  if (sub === 'list' || !sub) {
    const r = await app.onlineList({
      page: flags.page ? parseInt(flags.page, 10) : 1,
      keys: flags.keys || '',
      order1: flags.order || 'time',
    });
    console.log(`在线书源（第 ${r.page}/${r.totalPages} 页，共 ${r.items.length} 条）`);
    if (flags.keys) console.log(`筛选: ${flags.keys}`);
    console.log('');
    for (const it of r.items) {
      const tags = [it.hasSearch ? '搜' : '', it.hasExplore ? '发' : '', it.hasImage ? '图' : '', it.hasAudio ? '声' : '']
        .filter(Boolean)
        .join('');
      console.log(
        `  ${pad(it.id, 7)}${pad(it.name.slice(0, 22), 24)}${pad(it.url.slice(0, 32), 34)}${pad(tags, 6)}下载:${it.downloads}  ${it.updatedText}`
      );
    }
    return;
  }
  if (sub === 'get') {
    const id = pos[1];
    if (!id) throw new Error('用法: online get <id>');
    const list = await app.onlineDownload(id);
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (sub === 'install') {
    const id = pos[1];
    if (!id) throw new Error('用法: online install <id>');
    const results = await app.installFromOnline(id, {
      probe: flags['no-probe'] ? false : true,
      keyword: flags.keyword,
      force: !!flags.force,
    });
    for (const r of results) {
      if (r.added) {
        console.log(`✓ 已添加 ${r.name}（评分 ${r.probe ? r.probe.score : '-'}）`);
      } else {
        console.log(`✗ ${r.name} — ${r.reason}`);
        if (r.errors && r.errors.length) for (const e of r.errors) console.log('    · ' + e);
      }
    }
    return;
  }
  if (sub === 'update') {
    const r = await app.syncOnlineUpdates({
      kind: flags.kind || 'shuyuan',
      days: flags.days ? parseInt(flags.days, 10) : 7,
      pages: flags.pages ? parseInt(flags.pages, 10) : 1,
      probe: flags['no-probe'] ? false : true,
      force: !!flags.force,
    });
    console.log(`最近 ${flags.days || 7} 天更新 ${r.checked} 条；新增/更新 ${r.added}，失败 ${r.failed}`);
    for (const it of r.items) {
      console.log(`  ${it.ok ? '✓' : '✗'} ${pad(String(it.name || '').slice(0, 24), 26)}${it.reason || ''}`);
    }
    return;
  }
  throw new Error(`未知 online 子命令: ${sub}`);
}

async function cmdSource(app, { pos, flags }) {
  const sub = pos[0];
  if (sub === 'list' || !sub) {
    const list = app.listSources();
    if (!list.length) {
      console.log('（本地还没有书源，试试: node src/cli.js online list）');
      return;
    }
    console.log(`本地书源 ${list.length} 个`);
    console.log('');
    for (const s of list) {
      const probe = s.probed ? (s.probeOk ? `✓ ${s.probeScore}` : `✗ ${s.probeScore}`) : '未探测';
      const cap = [s.hasSearch ? '搜' : '', s.hasExplore ? '发' : ''].filter(Boolean).join('');
      console.log(`  ${pad(s.name.slice(0, 20), 22)}${pad(s.url.slice(0, 36), 38)}${pad(cap, 4)}${probe}`);
    }
    return;
  }
  if (sub === 'add') {
    const f = pos[1];
    if (!f) throw new Error('用法: source add <file.json|->');
    const list = app.importSources(readInput(f)).list;
    for (const src of list) {
      // eslint-disable-next-line no-await-in-loop
      const r = await app.addSource(src, {
        probe: flags['no-probe'] ? false : true,
        keyword: flags.keyword,
        force: !!flags.force,
      });
      if (r.added) {
        console.log(`✓ ${r.reason} ${src.bookSourceName}` + (r.probe ? `（评分 ${r.probe.score}/100）` : ''));
      } else {
        console.log(`✗ ${src.bookSourceName} — ${r.reason}`);
        if (r.errors && r.errors.length) for (const e of r.errors) console.log('    · ' + e);
      }
    }
    return;
  }
  if (sub === 'test') {
    const f = pos[1];
    if (!f) throw new Error('用法: source test <file.json|->');
    const list = app.importSources(readInput(f)).list;
    for (const src of list) {
      // eslint-disable-next-line no-await-in-loop
      const r = await app.testSource(src, { keyword: flags.keyword });
      console.log(`书名: ${src.bookSourceName}`);
      console.log(`站点: ${src.bookSourceUrl}`);
      if (r.errors && r.errors.length) {
        console.log('结构问题:');
        for (const e of r.errors) console.log('  · ' + e);
      }
      if (r.probe) {
        console.log('探测阶段:');
        for (const [k, v] of Object.entries(r.probe.stages)) {
          console.log(`  ${v.ok ? '✓' : '✗'} ${pad(k, 10)}${v.count != null ? 'count=' + v.count : ''}${v.chars != null ? 'chars=' + v.chars : ''}${v.error ? ' ' + v.error : ''}`);
        }
        console.log(`评分: ${r.probe.score}/100  耗时 ${r.probe.elapsed}ms`);
        for (const w of r.probe.warnings || []) console.log('  ⚠ ' + w);
      }
      console.log(`准入: ${r.allowed ? '✓ 允许添加' : '✗ 不允许添加 — ' + r.reason}`);
    }
    return;
  }
  if (sub === 'remove') {
    const k = pos[1];
    if (!k) throw new Error('用法: source remove <key|名称>');
    console.log(app.removeSource(k) ? `✓ 已删除 ${k}` : `✗ 没找到 ${k}`);
    return;
  }
  if (sub === 'export') {
    const r = app.exportSources();
    const out = flags.out;
    if (out) {
      fs.writeFileSync(out, r.text, 'utf8');
      console.log(`✓ 已导出 ${r.count} 个书源 → ${out}`);
    } else {
      console.log(r.text);
    }
    return;
  }
  if (sub === 'import') {
    const f = pos[1];
    if (!f) throw new Error('用法: source import <file.json>');
    const list = app.importSources(fs.readFileSync(f, 'utf8')).list;
    for (const src of list) {
      // eslint-disable-next-line no-await-in-loop
      const r = await app.addSource(src, { probe: flags['no-probe'] ? false : true, force: !!flags.force });
      console.log(`${r.added ? '✓' : '✗'} ${src.bookSourceName} — ${r.reason}`);
    }
    return;
  }
  if (sub === 'check') {
    const r = await app.checkSources({
      keyword: flags.keyword,
      keys: flags.keys ? String(flags.keys).split(',') : null,
      concurrency: flags.concurrency ? parseInt(flags.concurrency, 10) : 3,
    });
    console.log(`校验完成：共 ${r.total} 个，通过 ${r.passed}，未通过 ${r.failed}`);
    for (const it of r.results) {
      console.log(
        `  ${it.allowed ? '✓' : '✗'} ${pad(String(it.name).slice(0, 22), 24)}${pad(String(it.score ?? '-'), 6)}${it.reason || ''}`
      );
      for (const e of it.errors.slice(0, 2)) console.log('      · ' + e);
    }
    return;
  }
  throw new Error(`未知 source 子命令: ${sub}`);
}

async function cmdRss(app, { pos, flags }) {
  const sub = pos[0];
  if (sub === 'list' || sub === 'local') {
    if (sub === 'list') {
      const r = await app.onlineRssList({ page: flags.page ? parseInt(flags.page, 10) : 1 });
      console.log(`在线订阅源（第 ${r.page}/${r.totalPages} 页，共 ${r.items.length} 条）`);
      console.log('');
      for (const it of r.items) {
        console.log(
          `  ${pad(it.id, 7)}${pad(it.name.slice(0, 26), 28)}${pad(it.url.slice(0, 40), 42)}下载:${it.downloads}  ${it.updatedText}`
        );
      }
      return;
    }
    const list = app.listRss();
    if (!list.length) {
      console.log('（本地还没有订阅源，试试: node src/cli.js rss install <id> 或 rss import <file>）');
      return;
    }
    console.log(`本地订阅源 ${list.length} 个`);
    for (const s of list) {
      console.log(`  ${pad(s.name.slice(0, 26), 28)}${pad(s.url.slice(0, 48), 50)}${s.enabled ? '' : '（停用）'}`);
    }
    return;
  }
  if (sub === 'install') {
    const id = pos[1];
    if (!id) throw new Error('用法: rss install <id>');
    const r = await app.installRssFromOnline(id, { force: !!flags.force });
    console.log(`安装完成：新增 ${r.added}，更新 ${r.updated}，跳过 ${r.skipped}`);
    for (const it of r.items) console.log(`  ${it.ok ? '✓' : '✗'} ${it.name} — ${it.reason}`);
    return;
  }
  if (sub === 'import') {
    const f = pos[1];
    if (!f) throw new Error('用法: rss import <file.json>');
    const r = app.importRss(fs.readFileSync(f, 'utf8'), { force: !!flags.force });
    console.log(`导入完成：新增 ${r.added}，更新 ${r.updated}，跳过 ${r.skipped}`);
    for (const it of r.items) console.log(`  ${it.ok ? '✓' : '✗'} ${it.name} — ${it.reason}`);
    return;
  }
  if (sub === 'remove') {
    const k = pos[1];
    if (!k) throw new Error('用法: rss remove <key|名称>');
    console.log(app.removeRss(k) ? `✓ 已删除 ${k}` : `✗ 没找到 ${k}`);
    return;
  }
  throw new Error(`未知 rss 子命令: ${sub}`);
}

async function cmdSearch(app, { pos, flags }) {
  const kw = pos[0];
  if (!kw) throw new Error('用法: search <关键词> [--source KEY] [--all|--everywhere] [--page N] [--concurrency N] [--timeout MS]');
  const page = flags.page ? parseInt(flags.page, 10) : 1;

  // --everywhere / --all：全书源聚合搜索（并发 + 增量 + 熔断）
  if (flags.everywhere || flags.all) {
    const showAll = !!flags.verbose;
    let shown = 0;
    const t0 = Date.now();
    process.stdout.write(`全书源搜索「${kw}」…\n`);
    const r = await app.searchEverywhere(kw, {
      page,
      concurrency: flags.concurrency ? parseInt(flags.concurrency, 10) : undefined,
      perSourceTimeout: flags.timeout ? parseInt(flags.timeout, 10) : undefined,
      onResult: (ev) => {
        const mark = ev.ok ? (ev.count ? '✓' : '·') : '✗';
        const detail = ev.ok ? `${ev.count} 条` : ev.error;
        if (ev.count || !ev.ok || showAll) {
          process.stdout.write(`  ${mark} [${String(ev.done).padStart(2)}/${ev.total}] ${pad((ev.name || '').slice(0, 20), 22)}${pad(detail.slice(0, 40), 42)}${ev.ms}ms\n`);
        }
        shown++;
      },
    });
    const all = r.sources.filter((s) => s.ok);
    const failed = r.sources.filter((s) => !s.ok);
    if (!showAll && all.length > shown) process.stdout.write(`  …共 ${all.length} 个源有响应\n`);

    console.log(`\n聚合结果：${r.groups.length} 本书（来自 ${r.ok}/${r.total} 个源，耗时 ${r.el}${r.timedOut ? `，${r.timedOut} 个源超时` : ''}）`);
    if (!r.groups.length) {
      console.log('（无结果）');
      return;
    }
    r.groups.slice(0, flags.limit ? parseInt(flags.limit, 10) : 40).forEach((g, i) => {
      const srcs = g.offers.map((o) => o.sourceName).join('/');
      console.log(`  ${String(i + 1).padStart(3)}. ${pad((g.title || '').slice(0, 28), 30)}${pad((g.author || '').slice(0, 12), 14)}${String(g.sourceCount).padStart(2)}源  ${srcs.slice(0, 60)}`);
    });
    if (r.groups.length > 40 && !flags.limit) console.log(`  …还有 ${r.groups.length - 40} 本（--limit N 看更多）`);
    if (failed.length && flags.verbose) {
      console.log(`\n失败 ${failed.length} 个源：`);
      for (const f of failed) console.log(`  ✗ ${f.name} — ${f.error}`);
    }
    console.log(`\n查看来源详情：search "${kw}" --source <书源名>，或直接 add --source <书源名> --url <bookUrl>`);
    return;
  }

  let groups;
  if (flags.source) {
    const src = app.getSource(flags.source);
    if (!src) throw new Error(`找不到书源：${flags.source}`);
    groups = [{ ok: true, ...(await app.search(keyOf(src), kw, page)) }];
  } else {
    const all = app.listSources().filter((s) => s.hasSearch && s.enabled);
    if (!all.length) throw new Error('还没有可用书源，先 online install <id>，或用 search <关键词> --everywhere 全书源搜索');
    // 默认用第一个可用书源
    groups = [{ ok: true, ...(await app.search(all[0].key, kw, page)) }];
  }

  let total = 0;
  for (const g of groups) {
    if (!g.ok) {
      console.log(`✗ ${g.source} — ${g.error}`);
      continue;
    }
    console.log(`\n【${g.source}】「${g.keyword}」第 ${g.page} 页：${g.list.length} 条`);
    g.list.forEach((b, i) => {
      total++;
      console.log(`  ${String(i).padStart(2)}. ${pad((b.name || '').slice(0, 30), 32)}${pad((b.author || '').slice(0, 12), 14)}${b.bookUrl}`);
    });
  }
  if (!total) console.log('\n（无结果）');
}

async function cmdCheck(app, { pos, flags }) {
  const bookId = flags.book || pos[0] || null;
  const r = await app.checkUpdates({
    bookIds: bookId ? [bookId] : undefined,
    dryRun: !!flags['dry-run'],
    concurrency: flags.concurrency ? parseInt(flags.concurrency, 10) : 3,
    onProgress: (it) => {
      const tag = it.status === 'updated' ? `有更新 +${it.addedCount} 章`
        : it.status === 'changed' ? '目录有变动'
        : it.status === 'latest' ? '已是最新'
        : `失败：${it.error}`;
      console.log(`  ${pad(it.name.slice(0, 24), 26)}${it.oldCount} → ${it.newCount} 章  ${tag}`);
    },
  });
  console.log(`\n共 ${r.total} 本：有更新 ${r.updated}，目录变动 ${r.changed}，已最新 ${r.latest}，失败 ${r.failed}（${(r.elapsed / 1000).toFixed(1)}s）`);
  if (flags['dry-run']) console.log('（dry-run：未写入书架状态与目录）');
}

async function cmdShelf(app) {
  const books = app.shelf();
  if (!books.length) {
    console.log('（书架是空的）');
    return;
  }
  console.log(`书架 ${books.length} 本`);
  console.log('');
  for (const b of books) {
    const pct = b.chapterCount ? Math.round(((b.downloadedCount || 0) / b.chapterCount) * 100) : 0;
    console.log(
      `  ${pad(b.name.slice(0, 28), 30)}${pad((b.author || '').slice(0, 10), 12)}` +
        `${pad(`${b.downloadedCount || 0}/${b.chapterCount || 0}`, 10)}${String(pct).padStart(3)}%  ${b.id}  ${b.sourceName}`
    );
  }
}

async function cmdAdd(app, { pos, flags }) {
  const [sourceKey, bookUrl] = pos;
  if (!sourceKey || !bookUrl) throw new Error('用法: add <sourceKey> <bookUrl> [--download]');
  const src = app.getSource(sourceKey);
  if (!src) throw new Error(`找不到书源：${sourceKey}`);
  const r = await app.addToShelf(keyOf(src), { name: '', author: '', bookUrl }, {
    download: !!flags.download,
    to: flags.to ? parseInt(flags.to, 10) : undefined,
  });
  console.log(`✓ 《${r.name}》 目录 ${r.chapterCount} 章  id=${r.id}`);
  if (r.download) {
    const d = r.download;
    console.log(`  下载: 成功 ${d.done} / 跳过 ${d.skipped} / 失败 ${d.failed}`);
  }
}

async function cmdDownload(app, { pos, flags }) {
  const id = pos[0];
  if (!id) throw new Error('用法: download <bookId> [--from N] [--to N] [--force]');
  const from = flags.from != null ? parseInt(flags.from, 10) : undefined;
  const to = flags.to != null ? parseInt(flags.to, 10) : undefined;
  let last = 0;
  const t0 = Date.now();
  const r = await app.download(id, {
    from,
    to,
    force: !!flags.force,
    onProgress: (p) => {
      if (p.status === 'ok' || p.status === 'fail' || p.status === 'empty') {
        const now = Date.now();
        if (now - last > 400 || p.index === p.total - 1) {
          last = now;
          process.stdout.write(`\r  第 ${p.index + 1} 章 ${p.status}…（${p.index + 1}/${p.total}）`);
        }
      }
    },
  });
  process.stdout.write('\r'.padEnd(50) + '\r');
  console.log(`✓ 成功 ${r.done} / 跳过 ${r.skipped} / 失败 ${r.failed}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (r.failedIndexes.length) console.log('  失败章节: ' + r.failedIndexes.map((i) => i + 1).join(', '));
}

async function cmdRead(app, { pos, flags }) {
  const id = pos[0];
  const idx = pos[1] != null ? parseInt(pos[1], 10) : 0;
  if (!id) throw new Error('用法: read <bookId> [章节序号]');
  const book = app.book(id);
  if (!book) throw new Error(`书架里没有这本书：${id}`);
  const toc = app.toc(id);
  const ch = toc[idx];
  if (!ch) throw new Error(`没有第 ${idx + 1} 章（共 ${toc.length} 章）`);
  const text = app.chapter(id, idx);
  console.log(`《${book.name}》 第 ${idx + 1}/${toc.length} 章  ${ch.name}`);
  console.log('─'.repeat(60));
  if (text == null) {
    console.log('（这一章还没有下载，先执行: download ' + id + '）');
    return;
  }
  const max = flags.chars ? parseInt(flags.chars, 10) : 0;
  console.log(max ? text.slice(0, max) + `\n…（共 ${text.length} 字）` : text);
}

async function cmdExport(app, { pos, flags }) {
  const what = pos[0];
  if (!what) throw new Error('用法: export <bookId|--all> [--layout ...] [--encoding ...]');
  const opts = {
    layout: flags.layout || 'single',
    encoding: flags.encoding || 'utf-8',
    includeToc: !flags['no-toc'],
    includeHeader: !flags['no-header'],
    eol: flags.lf ? 'lf' : 'crlf',
    bom: !!flags.bom,
    outDir: flags.out ? path.resolve(flags.out) : undefined,
  };
  if (flags.all || what === '--all') {
    const rs = app.exportShelf(opts);
    for (const r of rs) {
      if (!r.ok) {
        console.log(`✗ ${r.name} — ${r.error}`);
        continue;
      }
      console.log(`✓ 《${r.name}》 ${r.result.files.length} 个文件 ${r.result.chapters} 章 ${fmtSize(r.result.bytes)}`);
      console.log(`  → ${r.result.files[0].path}`);
    }
    return;
  }
  const r = app.exportBook(what, opts);
  console.log(`✓ 《${r.name}》 layout=${r.layout} encoding=${opts.encoding} ${r.chapters} 章 ${fmtSize(r.bytes)}`);
  if (r.missing) console.log(`  跳过未下载章节 ${r.missing} 章`);
  for (const f of r.files) console.log(`  ${fmtSize(f.bytes).padStart(9)}  ${f.path}`);
}

/**
 * 首次使用（数据目录是新建的）时，把**散包内置**的 data/sources/{sources,rss}.json 灌进去。
 *
 * 为什么需要：绿色版把数据目录指到 %USERPROFILE%\ShuyuanReader\data，那里一开始是空的；
 * 而包内 data/sources/*.json 带着 18 个书源（这是发出去就有书可搜的关键）。
 * 只补「目标不存在」的文件，绝不覆盖用户自己的书源。
 */
function seedBundledData(dataDir) {
  const bundled = path.join(__dirname, '..', 'data');
  const files = [path.join('sources', 'sources.json'), path.join('sources', 'rss.json')];
  let seeded = 0;
  for (const rel of files) {
    const from = path.join(bundled, rel);
    const to = path.join(dataDir, rel);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      seeded++;
    } catch (_) {
      /* 灌不进去不影响启动，App 会自己建空文件 */
    }
  }
  return seeded;
}

/* ---------------- 入口 ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  const { pos, flags } = parseArgs(argv);
  const cmd = pos.shift() || 'help';

  if (cmd === 'help' || flags.help) {
    console.log(HELP);
    return 0;
  }

  seedBundledData(flags.data || process.env.SHUYUAN_DATA || path.join(__dirname, '..', 'data'));

  const app = new App({
    dataDir: flags.data,
    concurrency: flags.concurrency ? parseInt(flags.concurrency, 10) : 4,
    logger: flags.verbose ? (m) => console.error('  · ' + m) : null,
  });

  switch (cmd) {
    case 'info':
      await cmdInfo(app, { pos, flags });
      break;
    case 'online':
      await cmdOnline(app, { pos, flags });
      break;
    case 'source':
      await cmdSource(app, { pos, flags });
      break;
    case 'rss':
      await cmdRss(app, { pos, flags });
      break;
    case 'search':
      await cmdSearch(app, { pos, flags });
      break;
    case 'check':
      await cmdCheck(app, { pos, flags });
      break;
    case 'shelf':
      await cmdShelf(app, { pos, flags });
      break;
    case 'add':
      await cmdAdd(app, { pos, flags });
      break;
    case 'download':
      await cmdDownload(app, { pos, flags });
      break;
    case 'read':
      await cmdRead(app, { pos, flags });
      break;
    case 'export':
      await cmdExport(app, { pos, flags });
      break;
    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(HELP);
      return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error('错误: ' + (e && e.message ? e.message : e));
    if (process.env.SHUYUAN_DEBUG) console.error(e.stack);
    process.exit(1);
  });
