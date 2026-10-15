'use strict';
/**
 * 书源规则单测（不联网）——覆盖两处由真实站点暴露出的引擎缺陷。
 *
 * 背景（两个都是实跑速读谷 / 得奇小说网时发现的真实缺陷）：
 *
 *  ① 搜索页 302 跳转到详情页时，`ruleSearch.bookList` 选不中任何元素，
 *     引擎走 `_readBookInfo` 兜底解析——但 bookUrl 取的是**原始请求地址**，
 *     于是「捞尸人」的 bookUrl 变成了 `…/search.php?searchkey=…` 搜索页，
 *     点进去必失败。修法：用 Prefetcher 缓存里 http.js 回填的**跳转后地址**。
 *
 *  ② `ruleContent.replaceRegex`（Legado 的整章全文替换，BookContent.kt:189-195）
 *     在引擎里从未被读取，书源写这个字段等于白写（广告/水印清不掉）。
 */
const assert = require('assert');
const path = require('path');
const cheerio = require('cheerio');

const R = require(path.join(__dirname, '..', 'src', 'rules', 'rule.js'));
const { Prefetcher } = require(path.join(__dirname, '..', 'src', 'rules', 'jsrt'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function loadDoc(html) { const $ = cheerio.load(html); if (html) $.__srcHtml = String(html); return $; }

console.log('\n[1] Prefetcher.peekSync 能拿到跳转后的最终地址');

t('peekSync 返回缓存条目本体（含 url 字段）', () => {
  const p = new Prefetcher();
  // 模拟 http.js 的行为：请求 A，30x 后落在 B，缓存条目里的 url 是 B
  p.cache.set(
    ['GET', 'https://www.deqixss.com/modules/article/search.php?searchkey=x', '', '', ''].join('\u0001'),
    { status: 200, text: '<html>详情页</html>', url: 'https://www.deqixss.com/books/126/' }
  );
  const hit = p.peekSync('https://www.deqixss.com/modules/article/search.php?searchkey=x', { method: 'GET' });
  assert.ok(hit, 'peekSync 应命中');
  assert.strictEqual(hit.url, 'https://www.deqixss.com/books/126/', ' 应带出跳转后的地址');
});

t('peekSync 未命中时返回 null（不是空字符串）', () => {
  const p = new Prefetcher();
  assert.strictEqual(p.peekSync('https://none.test/a', { method: 'GET' }), null);
});

t('getSync 未命中返回空串并登记 miss（语义与 peekSync 不同，不可混用）', () => {
  const p = new Prefetcher();
  assert.strictEqual(p.getSync('https://none.test/b', { method: 'GET' }), '');
  assert.strictEqual(p.misses.size, 1, '应登记一次 miss');
});

console.log('\n[2] ruleContent 里的 `##` 后缀：选择器结果上的替换');

t('.con@html 返回带外层标签，锚 `^` 会失配（这是踩过的坑）', () => {
  const $ = loadDoc('<div class="con"><p>第1章 绯红</p><p>痛！</p></div>');
  const ctx = { baseUrl: 'https://x.test/', source: {}, js: null };
  const r = R.evalRule('.con@html##^\\s*<p>\\s*第[^<]*</p>', $, ctx, {});
  assert.ok(/第1章 绯红/.test(r.text), '带锚规则的标题应仍在（说明锚没匹配上外层 div）');
});

t('.con@html 去锚后能删掉首个标题段落', () => {
  const $ = loadDoc('<div class="con"><p>第1章 绯红</p><p>痛！</p></div>');
  const ctx = { baseUrl: 'https://x.test/', source: {}, js: null };
  const r = R.evalRule('.con@html##<p>\\s*第[^<]*</p>', $, ctx, {});
  assert.ok(!/第1章 绯红/.test(r.text), '标题段落应已被删除');
  assert.ok(/痛！/.test(r.text), '正文段落必须保留');
});

t('`##` 拆出 4 段时进入 replaceFirst 分支（对齐 AnalyzeRule.kt:496-506）', () => {
  const $ = loadDoc('<div class="con"><p>A</p><p>A</p></div>');
  const ctx = { baseUrl: 'https://x.test/', source: {}, js: null };
  // 三段写法：##regex##replacement → 全局替换
  const g = R.evalRule('.con@html##<p>A</p>##<p>B</p>', $, ctx, {});
  const gA = (String(g.text).match(/<p>A<\/p>/g) || []).length;
  assert.strictEqual(gA, 0, '全局替换应把两个 A 都换掉');
  assert.strictEqual((String(g.text).match(/<p>B<\/p>/g) || []).length, 2, '全局替换应产出两个 B');

  // 四段写法：##regex##replacement### → replaceFirst
  // ⚠️ Legado 的 replaceFirst 分支返回的是【首个匹配片段本身】（AnalyzeRule.kt:499-504
  //    的 `match.value.replaceFirst(regex, replacement)`），不是「原文中只换一处」！
  //    所以输出里既没有第二个 A，也不保留匹配片段之外的任何内容。
  const f = R.evalRule('.con@html##<p>A</p>##<p>B</p>###', $, ctx, {});
  assert.strictEqual(String(f.text), '<p>B</p>', `replaceFirst 应只返回首个匹配片段，实得 ${JSON.stringify(String(f.text))}`);
});

console.log('\n[3] ruleContent.replaceRegex 是「整章」全局替换（与 `##` 区分）');

/** 复刻 source.js 里新加的整章替换逻辑 */
function applyChapterReplaceRegex(body, rr) {
  if (!rr) return body;
  try { return body.replace(new RegExp(String(rr), 'g'), ''); }
  catch (_) { return body; }
}

t('去除站点名与水印（真实用例：速读谷）', () => {
  const body = '正文一。速读谷 www.suduguu.com 正文二。shudugu.org';
  const out = applyChapterReplaceRegex(body, '速读谷|shudugu\\.org|sudugu\\.org');
  assert.ok(!/速读谷/.test(out), '站点名应被清掉');
  assert.ok(!/shudugu\.org/.test(out), '别名域名应被清掉');
  assert.ok(/正文一/.test(out) && /正文二/.test(out), '正文不能受损');
});

t('是全局替换，不是只换首个', () => {
  const out = applyChapterReplaceRegex('广告 广告 广告', '广告');
  assert.strictEqual(out.replace(/\s/g, ''), '', '三处都应被替换掉');
});

t('非法正则不能让整章失败（必须兜底原样返回）', () => {
  const body = '正常正文';
  const out = applyChapterReplaceRegex(body, '([unclosed');
  assert.strictEqual(out, body, '非法正则应原样返回，而不是抛异常');
});

t('replaceRegex 为空时零开销直通', () => {
  assert.strictEqual(applyChapterReplaceRegex('abc', ''), 'abc');
  assert.strictEqual(applyChapterReplaceRegex('abc', undefined), 'abc');
});

console.log('\n[4] 搜索兜底分支的报错页护栏（真实用例：速读谷搜索接口 500）');

/* 从 source.js 里取真实实现，避免「测试里抄一份、实现改了测试还绿」。
   两个函数都是模块内的纯函数（只依赖 cheerio 的 $），用源码正则抽出来 eval。 */
const fs = require('fs');
const srcText = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'source.js'), 'utf8');
function grabFn(name) {
  const i = srcText.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `源码里找不到 ${name}`);
  // 从函数名起做花括号配平
  const start = srcText.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < srcText.length; j++) {
    if (srcText[j] === '{') depth++;
    else if (srcText[j] === '}') { depth--; if (depth === 0) return srcText.slice(i, j + 1); }
  }
  throw new Error(`${name} 花括号不配平`);
}
const ERROR_PAGE_RE = /const ERROR_PAGE_PATTERNS = \[[\s\S]*?\n\];/;
const patMatch = srcText.match(ERROR_PAGE_RE);
assert.ok(patMatch, '源码里找不到 ERROR_PAGE_PATTERNS');
// eslint-disable-next-line no-eval
const looksLikeErrorPage = eval(`(() => { ${patMatch[0]}\n ${grabFn('looksLikeErrorPage')}\n return looksLikeErrorPage; })()`);
// eslint-disable-next-line no-eval
const looksLikeBookDetailPage = eval(`(() => { ${grabFn('looksLikeBookDetailPage')}\n return looksLikeBookDetailPage; })()`);

t('ASP.NET 500 错误页必须被识别（速读谷真实页面）', () => {
  const $ = loadDoc('<html><head><title>运行时错误</title></head><body><h1>“/”应用程序中的服务器错误。</h1><p>说明: 服务器上出现应用程序错误。</p></body></html>');
  assert.strictEqual(looksLikeErrorPage($), true, '必须认出这是报错页');
});

t('常见 404 / 拦截页也要认出', () => {
  for (const html of [
    '<html><head><title>404 Not Found</title></head><body><h1>404</h1></body></html>',
    '<html><head><title>页面不存在</title></head><body></body></html>',
    '<html><head><title>Just a moment...</title></head><body><h1>请完成验证</h1></body></html>',
    '<html><head><title>502 Bad Gateway</title></head><body></body></html>',
  ]) {
    assert.strictEqual(looksLikeErrorPage(loadDoc(html)), true, '应识别: ' + html.slice(0, 50));
  }
});

t('正常书籍详情页不能被误判成报错页', () => {
  const $ = loadDoc('<html><head><title>大荒剑帝_速读谷</title></head><body><h1><i>585.4万字</i><a href="/1666/#dir">大荒剑帝</a></h1><div id="list"><li><a href="/1666/1.html">第一章</a></li></ul></div></body></html>');
  assert.strictEqual(looksLikeErrorPage($), false, '详情页不是报错页');
});

t('详情页形态识别：#list 目录容器命中', () => {
  const $ = loadDoc('<html><body><div id="list"><li><a href="/a/1.html">一</a></li><li><a href="/a/2.html">二</a></li></ul></div></body></html>');
  assert.strictEqual(looksLikeBookDetailPage($), true, '有目录容器即认');
});

t('得奇小说网单结果搜索页（真详情页）仍被认作详情页 —— 护栏不能误伤这条正当兜底', () => {
  const $ = loadDoc('<html><body><div id="list-chapterAll"><dd><a href="/books/639/1.html">第1章</a></dd><dd><a href="/books/639/2.html">第2章</a></dd><dd><a href="/books/639/3.html">第3章</a></dd></div></body></html>');
  assert.strictEqual(looksLikeBookDetailPage($), true, '得奇用的是 div#list-chapterAll');
});

t('书籍元信息 + 多个章节链接也算详情页（无标准目录容器的站点）', () => {
  const $ = loadDoc('<html><body><div class="bookinfo"><h1>某书</h1><span class="author">作者</span></div><a href="/x/1.html">1</a><a href="/x/2.html">2</a><a href="/x/3.html">3</a></body></html>');
  assert.strictEqual(looksLikeBookDetailPage($), true, '元信息 + ≥3 章节链接应认');
});

t('报错页不具备详情页形态（兜底第二道判据要拦住它）', () => {
  const $ = loadDoc('<html><head><title>运行时错误</title></head><body><h1>“/”应用程序中的服务器错误。</h1><p>堆栈跟踪…</p></body></html>');
  assert.strictEqual(looksLikeBookDetailPage($), false, '报错页不该被当详情页');
  assert.strictEqual(looksLikeErrorPage($), true, '且应被第一道判据认出');
});

console.log('\n[5] 正文分页选择器：文本匹配必须用 :contains()（真实用例：速读谷丢 3/4 正文）');

t('「下一页」在元素文本里，a[href*=下一页] 命中 0 个（这是写错过的形态）', () => {
  const $ = loadDoc('<div class="prenext"><span>上一章</span><a href="/1666/#dir">目录</a><span><a href="/1666/435178-2.html">下一页</a></span></div>');
  assert.strictEqual($('a[href*=下一页]').length, 0, 'href 里没有「下一页」三个字，属性选择器必然失配');
  assert.strictEqual($('a:contains(下一页)').length, 1, ':contains() 才是按文本匹配');
});

t(':contains(下一页)@href 能取出真实分页地址', () => {
  const $ = loadDoc('<div class="prenext"><span><a href="/1666/435178-2.html">下一页</a></span></div>');
  const ctx = { baseUrl: 'https://www.sudugu.org/1666/435178.html', source: {}, js: null };
  const r = R.evalRule('a:contains(下一页)@href', $, ctx, {});
  assert.strictEqual(String(r.text), '/1666/435178-2.html', `实得 ${JSON.stringify(String(r.text))}`);
});

t('末页没有「下一页」时应取不到（否则会死循环）', () => {
  const $ = loadDoc('<div class="prenext"><span>上一章</span><a href="/1666/#dir">目录</a></div>');
  assert.strictEqual($('a:contains(下一页)').length, 0, '末页应无命中');
});

console.log(`\n书源规则单测：通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
