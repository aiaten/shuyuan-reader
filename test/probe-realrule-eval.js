'use strict';
/*
 * 探针：直接用真实书源的 5 条「含 JS 块」规则 + 4 条组合符规则，跑当前 evalRule，
 * 看行为是否符合 Legado 语义。
 * 跑法：node test/probe-realrule-eval.js
 */
const cheerio = require('cheerio');
const path = require('path');
const R = require('../src/rules/rule.js');

const DIR = 'D:/AI/工作区/_recon';
const read = (f) => {
  let raw = require(path.join(DIR, f));
  if (Array.isArray(raw)) raw = raw[0];
  return raw;
};

const qidian = read('src_7036.json');
const shenwen = read('src_7908.json');
const uushuk = read('src_7940.json');

// 起点目录页结构（模拟）
const qdHtml = `<html><body><div id="allCatalog">
<div class="catalog-volume"><label class="volume-name">第一卷 免费</label>
<ul><li><a href="/chapter/1">第一章 起点</a><em></em></li>
<li><a href="/chapter/2">第二章 起点</a><em class="chapter-locked"></em></li></ul></div>
<div class="catalog-volume"><label class="volume-name">第二卷 订阅本卷</label>
<ul><li><a title="更新时间：2024 章节" href="/chapter/3">第三章 起点</a><em></em></li></ul></div>
</div></body></html>`;

const uuHtml = `<html><body><pre class="content"><p>第一段</p><p></p><p>第二段</p>
<p>本站域名 uushuk.com 请记住。</p><p>第三段</p></pre></body></html>`;

function show(label, rule, $, opts = {}, ctxExtra = {}) {
  console.log(`\n----- ${label} -----`);
  console.log('rule(前 120): ' + JSON.stringify(String(rule).slice(0, 120)));
  try {
    const r = R.evalRule(rule, $, { ...ctxExtra }, opts);
    console.log(`  → strings(${r.strings.length}): ${JSON.stringify(r.strings).slice(0, 300)}`);
    console.log(`  → elems: ${r.elems ? r.elems.length : null}  text: ${JSON.stringify(String(r.text).slice(0, 160))}`);
  } catch (e) {
    console.log(`  → ✗ ${e.constructor.name}: ${e.message}`);
  }
}

console.log('======== 1. 组合符（无 JS） ========');
const $qd = cheerio.load(`<html><body>
<div class="book-info-title"><a href="/book/1">书名甲</a></div>
<div class="book-mid-info"><a href="/book/2">书名乙</a></div>
<div class="author"><a href="/a">作者甲</a><span>作者乙</span></div>
<div class="book-attribute">分类甲</div>
<meta property="og:novel:update_time" content="2024-01-01">
</body></html>`);
show('起点 bookUrl (||)', qidian.ruleSearch.bookUrl, $qd);
show('起点 name (||)', qidian.ruleSearch.name, $qd);
show('起点 kind (&& 并联)', qidian.ruleSearch.kind, $qd);
show('起点 ruleBookInfo.kind (&& 并联)', qidian.ruleBookInfo.kind, $qd);

console.log('\n======== 2. %% 交错（README 声称支持） ========');
const $li = cheerio.load(`<html><body><div class="list">
<li><a class="n" href="/1">甲</a></li><li><a class="n" href="/2">乙</a></li><li><a class="n" href="/3">丙</a></li>
</div></body></html>`);
show('li@a.n@href%%li@text', 'li@a.n@href%%li@text', $li);

console.log('\n======== 3. 起点 ruleToc.chapterList（@css: + @js:） ========');
show('qidian.ruleToc.chapterList', qidian.ruleToc.chapterList, cheerio.load(qdHtml));

console.log('\n======== 4. 神文 ruleToc.chapterList（"-" 前缀 + @js:） ========');
show('shenwen.ruleToc.chapterList', shenwen.ruleToc.chapterList, cheerio.load('<html><body></body></html>'));

console.log('\n======== 5. uu书库 ruleContent.content（class.content@html@js:） ========');
show('uushuk.ruleContent.content', uushuk.ruleContent.content, cheerio.load(uuHtml));

console.log('\n======== 6. uu书库 searchUrl（<js> + @result 流水线） ========');
show('uushuk.searchUrl', uushuk.searchUrl, cheerio.load('<html><body></body></html>'));
