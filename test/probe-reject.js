'use strict';
/**
 * 验证「不能读取的网站不能添加」这条核心规则。
 * 构造若干坏书源，探测结果必须 isAllowed=false。
 *
 * 用法: node test/probe-reject.js
 */
const { probe, canAdd } = require('../src/source/probe');
const { validateShape } = require('../src/source/store');

const CASES = [
  {
    label: '① 站点不存在（DNS 失败）',
    src: {
      bookSourceName: '不存在的站点',
      bookSourceUrl: 'https://this-domain-does-not-exist-9f8a7b6c.example/',
      searchUrl: '/search?q={{key}}',
      ruleSearch: { bookList: '.x', name: 'a@text', bookUrl: 'a@href' },
      ruleToc: { chapterList: '.list@a' },
      ruleContent: { content: '.content@text' },
    },
  },
  {
    label: '② 站点可达但搜索规则是错的（选不中任何东西）',
    src: {
      bookSourceName: '规则全错',
      bookSourceUrl: 'https://www.zuizhong.net/',
      searchUrl: 'https://www.zuizhong.net/search.html,{"method":"POST","body":"s={{key}}"}',
      ruleSearch: { bookList: '.this-class-does-not-exist-xyz', name: 'a@text', bookUrl: 'a@href' },
      ruleToc: { chapterList: '.nope@a' },
      ruleContent: { content: '.nope@text' },
    },
  },
  {
    label: '③ 能搜索、但目录规则错（读不出章节）',
    src: {
      bookSourceName: '目录规则错',
      bookSourceUrl: 'https://www.zuizhong.net/',
      searchUrl: 'https://www.zuizhong.net/search.html,{"method":"POST","body":"s={{key}}"}',
      ruleSearch: {
        bookList: '.txt-list@li',
        name: 'a.0@text',
        bookUrl: 'a.0@href',
        author: 'a.1@text',
      },
      ruleToc: { chapterList: '.this-does-not-exist@a', chapterName: 'text', chapterUrl: 'href' },
      ruleContent: { content: '.info_dv1@p@text' },
    },
  },
  {
    label: '④ 结构校验：缺少必填字段',
    src: { bookSourceUrl: 'https://a.com/', searchUrl: '/s?q={{key}}' },
    shape: true,
  },
  {
    label: '⑤ 结构校验：自定义协议（非 http/https）',
    src: {
      bookSourceName: '本地解析器',
      bookSourceUrl: 'moyue://rapid',
      searchUrl: 'moyue://search?q={{key}}',
      ruleToc: { chapterList: 'a' },
      ruleContent: { content: 'div' },
    },
    shape: true,
  },
  {
    label: '⑥ 结构校验：没有 searchUrl 也没有 ruleExplore',
    src: {
      bookSourceName: '无入口',
      bookSourceUrl: 'https://www.zuizhong.net/',
      ruleToc: { chapterList: '.info_dv3.1@ul@a' },
      ruleContent: { content: '.info_dv1@p@text' },
    },
    shape: true,
  },
];

(async () => {
  let pass = 0;
  let fail = 0;

  for (const c of CASES) {
    console.log(`\n${'='.repeat(70)}\n${c.label}\n${'='.repeat(70)}`);

    // 先看结构校验
    const shapeErrs = validateShape(c.src);
    if (shapeErrs.length) {
      console.log('结构校验失败（本地即可拒绝，无需联网）:');
      shapeErrs.forEach((e) => console.log('  · ' + e));
    }

    if (c.shape) {
      const rejected = shapeErrs.length > 0;
      console.log(rejected ? '→ ✓ 已拒绝' : '→ ✗ 未拒绝（预期应拒绝）');
      rejected ? pass++ : fail++;
      continue;
    }

    const t0 = Date.now();
    const res = await probe(c.src, { keyword: '剑', checkContent: true });
    const gate = canAdd(res);
    console.log(`探测耗时 ${Date.now() - t0}ms  评分=${res.score}  允许添加=${gate.allowed}`);
    for (const [n, st] of Object.entries(res.stages)) {
      console.log(`  ${st.ok ? '✓' : st.skipped ? '–' : '✗'} ${n.padEnd(11)} ${st.message || ''}`);
    }
    if (res.errors.length) console.log('  致命: ' + res.errors.join('; '));
    console.log(gate.allowed ? '→ ✗ 错误：本应拒绝却允许了' : `→ ✓ 已拒绝（${gate.reason}）`);
    gate.allowed ? fail++ : pass++;
  }

  console.log(`\n${'='.repeat(70)}\n总计: ${pass} 通过 / ${fail} 失败\n${'='.repeat(70)}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
