'use strict';
/**
 * 临时调试：逐个拉取指定在线书源并带日志探测，看搜索阶段到底发生了什么。
 * 用法: node test/debug-probe-fails.js 8035 8033 8025 8023 8002
 */
const yck = require('../src/source/yck');
const { probe } = require('../src/source/probe');

(async () => {
  const ids = process.argv.slice(2);
  for (const id of ids) {
    for (const src of await yck.download(id)) {
    console.log('='.repeat(70));
    console.log(`#${id} ${src.bookSourceName}  ${src.bookSourceUrl}`);
    console.log('  searchUrl =', JSON.stringify(src.searchUrl).slice(0, 200));
    console.log('  header    =', JSON.stringify(src.header || '').slice(0, 200));
    console.log('  loginUrl  =', JSON.stringify(src.loginUrl || '').slice(0, 100));
    const res = await probe(src, { logger: (m) => console.log('   ', m) });
    console.log(`  => ok=${res.ok} score=${res.score} allowed-errors=${res.errors.join(' | ')}`);
    for (const [n, st] of Object.entries(res.stages)) {
      console.log(`     ${st.ok ? '✓' : st.skipped ? '–' : '✗'} ${n} ${st.message || ''} tried=${JSON.stringify(st.tried || '').slice(0, 300)}`);
    }
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
