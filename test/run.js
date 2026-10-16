'use strict';
/**
 * 聚合测试入口：`pnpm test` / `node test/run.js`
 *
 * 分层执行：
 *   unit   —— 纯函数 / 本地逻辑，秒级，不联网
 *   net    —— 需要访问书源站与目标小说站
 *   e2e    —— 完整链路（搜索→加书架→下载→导出）
 *   gui    —— 拉起真实 Electron
 *
 * 用法：
 *   node test/run.js              跑 unit + net
 *   node test/run.js --all        跑全部（含 e2e、gui）
 *   node test/run.js unit         只跑指定层
 *   node test/run.js --list       列出所有测试
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HERE = __dirname;
const NODE = process.execPath;

/** 测试清单：{layer, file, args, desc, timeout} */
const TESTS = [
  { layer: 'unit', file: 'unit-cookiejar.js', desc: 'CookieJar 域/路径/过期/删除语义' },
  { layer: 'unit', file: 'unit-encoding.js', desc: '编码识别与解码（GBK 假 utf-8 回退）' },
  { layer: 'unit', file: 'unit-rule.js', desc: 'Legado 规则引擎（索引/正则替换/选择器）' },
  { layer: 'unit', file: 'unit-encode.js', desc: 'URL 编码语义（query/form/escape）' },
  { layer: 'unit', file: 'unit-txt.js', desc: 'TXT 导出（模板/编码/换行/标题去重）' },
  { layer: 'unit', file: 'unit-library.js', desc: '本地书架读写与原子落盘' },
  { layer: 'unit', file: 'unit-store.js', desc: '书源库 key 归一化 / BOM 导入 / 结构校验' },
  { layer: 'unit', file: 'unit-rss.js', desc: '订阅源库（Legado RSS）结构与增删改' },
  { layer: 'unit', file: 'unit-yck.js', desc: '在线书源列表 HTML 解析 + 备用线路故障转移' },
  { layer: 'unit', file: 'unit-searchall.js', desc: '全书源聚合搜索（并发/增量/熔断/去重/源排序）' },
  { layer: 'unit', file: 'unit-window.js', desc: '懒加载滑动窗口（加书架前10章 / 读到哪下到哪 / 防重入）' },
  { layer: 'unit', file: 'unit-switchsrc.js', desc: '书架换源（候选筛选 / 畸形地址探测 / 进度保留 / 失败回滚 / 窗口衔接）' },
  { layer: 'unit', file: 'unit-browser.js', desc: '内置浏览器（预置站点表 / 书签历史会话持久化 / 脏数据容错）' },
  { layer: 'unit', file: 'unit-rules.js', desc: '书源规则回归（搜索页302落点 / ## 正则后缀 / ruleContent.replaceRegex）' },
  { layer: 'unit', file: 'unit-autogen.js', desc: '网页转书源嗅探（搜索表单/模板/列表容器/条目规则/全链路/正文红线，假站点离线跑）' },

  { layer: 'net', file: 'smoke-http.js', desc: 'HTTP 抓取 4 站点 + cookie 往返' },
  { layer: 'net', file: 'probe-reject.js', desc: '可读性探测拒绝路径（6 个坏书源）', timeout: 240000 },
  { layer: 'net', file: 'probe-source.js', args: ['7941', '剑'], desc: '探测 7941 最终小说网（真站）', timeout: 180000 },

  { layer: 'e2e', file: 'e2e-detail.js', args: ['7941', '诡秘之主'], desc: '搜索→详情→目录→正文', timeout: 180000 },
  { layer: 'e2e', file: 'e2e-full.js', args: ['7941', '诡秘之主', '3'], desc: '全链路 + 3 布局导出校验', timeout: 300000 },

  { layer: 'gui', file: 'gui-smoke.js', desc: 'Electron GUI 冒烟（199 项：探测闸门、日夜模式、换源、书架查看方式/排序、阅读设置、网页转书源、内置浏览器、书源网站跳转、可用线路、全书源搜索与导出链路、阅读器stub重下）', timeout: 600000 },
];

const DEFAULT_LAYERS = ['unit', 'net'];
const ALL_LAYERS = ['unit', 'net', 'e2e', 'gui'];

function parseArgv(argv) {
  const o = { layers: [], list: false, verbose: false, filter: null };
  for (const a of argv) {
    if (a === '--all') o.layers = ALL_LAYERS.slice();
    else if (a === '--list') o.list = true;
    else if (a === '-v' || a === '--verbose') o.verbose = true;
    else if (a.startsWith('--only=')) o.filter = a.slice(7);
    else if (['unit', 'net', 'e2e', 'gui'].includes(a)) o.layers.push(a);
  }
  if (!o.layers.length && !o.list) o.layers = DEFAULT_LAYERS.slice();
  return o;
}

function runOne(t, verbose) {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = [path.join(HERE, t.file), ...(t.args || [])];
    const child = spawn(NODE, args, {
      cwd: path.join(HERE, '..'),
      env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS || '' },
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    if (!verbose) {
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
    }
    const timeout = t.timeout || 90000;
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
    }, timeout);

    child.on('exit', (code) => {
      clearTimeout(killTimer);
      const ms = Date.now() - start;
      if (code === 0) return resolve({ ok: true, ms });
      const tail = out
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(-12)
        .join('\n');
      resolve({ ok: false, ms, code, tail: code === null ? '超时被终止' : tail });
    });
    child.on('error', (e) => {
      clearTimeout(killTimer);
      resolve({ ok: false, ms: Date.now() - start, code: -1, tail: e.message });
    });
  });
}

function human(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const o = parseArgv(process.argv.slice(2));

  if (o.list) {
    for (const layer of ALL_LAYERS) {
      const items = TESTS.filter((t) => t.layer === layer);
      if (!items.length) continue;
      console.log(`\n${layer}:`);
      for (const t of items) {
        const exists = fs.existsSync(path.join(HERE, t.file));
        console.log(`  ${exists ? ' ' : '!'} ${t.file.padEnd(22)} ${t.desc}`);
      }
    }
    console.log('\n(! 表示文件尚不存在)');
    return 0;
  }

  let list = TESTS.filter((t) => o.layers.includes(t.layer));
  if (o.filter) list = list.filter((t) => t.file.includes(o.filter));

  console.log(`书源阅读器 · 测试（层级：${o.layers.join(', ')}，共 ${list.length} 项）`);
  console.log('='.repeat(72));

  const results = [];
  for (const t of list) {
    const p = path.join(HERE, t.file);
    if (!fs.existsSync(p)) {
      console.log(`  ⊘ ${t.file.padEnd(22)} 跳过（文件不存在）`);
      results.push({ t, ok: null, ms: 0 });
      continue;
    }
    process.stdout.write(`  ⋯ ${t.file.padEnd(22)} ${t.desc}`);
    const r = await runOne(t, o.verbose);
    results.push({ t, ...r });
    if (r.ok) {
      process.stdout.write(`\r  ✓ ${t.file.padEnd(22)} ${human(r.ms).padStart(7)}\n`);
    } else {
      process.stdout.write(`\r  ✗ ${t.file.padEnd(22)} ${human(r.ms).padStart(7)}  (exit=${r.code})\n`);
      if (r.tail) {
        for (const line of r.tail.split('\n')) console.log(`      │ ${line}`);
      }
    }
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => r.ok === false).length;
  const skip = results.filter((r) => r.ok === null).length;

  console.log('='.repeat(72));
  console.log(`通过 ${pass} · 失败 ${fail}${skip ? ` · 跳过 ${skip}` : ''}`);
  if (fail) {
    console.log('\n失败的测试：');
    for (const r of results.filter((x) => x.ok === false)) console.log(`  - ${r.t.file}`);
  }
  return fail ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('测试入口异常：' + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
);
