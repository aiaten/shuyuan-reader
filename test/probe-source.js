'use strict';
/**
 * 验证可读性探测（交付点 ③）。
 *
 * 用法: node test/probe-source.js [书源id|json文件] [关键词]
 *   - id     → 从 yck2026.fun 下载再探测
 *   - 文件   → 读本地 JSON（数组取第一个）
 *   - 无参   → 用 _recon/src_7941.json
 */
const fs = require('fs');
const path = require('path');
const { probe, canAdd } = require('../src/source/probe');
const yck = require('../src/source/yck');

const RECON = path.join(__dirname, '..', '..', '_recon');

const tick = (t0) => `${Date.now() - t0}ms`;

(async () => {
  const arg = process.argv[2] || '7941';
  const keyword = process.argv[3] || '剑';
  let src;

  if (/^\d+$/.test(arg)) {
    console.log(`从 yck2026.fun 下载书源 ${arg} ...`);
    const arr = await yck.download(arg);
    src = arr[0];
    console.log(`  得到《${src.bookSourceName}》${src.bookSourceUrl}（共 ${arr.length} 条，取第 1 条）\n`);
  } else {
    const f = path.isAbsolute(arg) ? arg : path.join(RECON, arg);
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    src = Array.isArray(data) ? data[0] : data;
    console.log(`读取 ${f} → 《${src.bookSourceName}》\n`);
  }

  const t0 = Date.now();
  const res = await probe(src, {
    keyword,
    checkContent: true,
    logger: (m) => console.log(m),
  });

  console.log(`\n=== 探测结果（${tick(t0)}）===`);
  console.log(`ok=${res.ok}  评分=${res.score}/100`);
  for (const [name, st] of Object.entries(res.stages)) {
    const mark = st.ok ? '✓' : st.skipped ? '–' : '✗';
    const extra = [
      st.count != null ? `count=${st.count}` : '',
      st.chars != null ? `chars=${st.chars}` : '',
      st.status != null ? `HTTP=${st.status}` : '',
      st.skipped ? '(跳过)' : '',
    ].filter(Boolean).join(' ');
    console.log(`  ${mark} ${name.padEnd(12)} ${extra}${st.message ? '  ' + st.message : ''}`);
  }
  if (res.errors.length) console.log('\n致命错误:\n  ' + res.errors.join('\n  '));
  if (res.warnings.length) console.log('\n告警:\n  ' + res.warnings.join('\n  '));
  if (res.details.diagnostics && res.details.diagnostics.unsupported.length) {
    console.log('\n不支持的 API: ' + res.details.diagnostics.unsupported.join(', '));
  }
  const gate = canAdd(res);
  console.log(`\n准入判定: ${gate.allowed ? '✓ 允许添加' : '✗ 不允许添加 — ' + gate.reason}`);
})().catch((e) => { console.error(e); process.exit(1); });
