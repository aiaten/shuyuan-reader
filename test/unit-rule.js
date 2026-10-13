'use strict';
/**
 * Legado 规则引擎单元测试（离线，用 cheerio 造 DOM）。
 * 覆盖：索引语法（`.N` / `!N` / `[a,b]` / `[a:b:c]` / 负索引 / 越界丢弃）、
 *       `@` 链、`&&` / `||`、`##` 正则替换、jsoup 特有 `[attr~=regex]`、属性提取、切片。
 * 跑法：node test/unit-rule.js
 */

const cheerio = require('cheerio');
const R = require('../src/rules/rule.js');

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  = ${g}\n      want = ${w}`}`);
}

function ok(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail || ''}`}`);
}

/** 对 html 跑规则，返回 strings */
function evalS(html, rule, opts) {
  const $ = cheerio.load(html);
  const r = R.evalRule(rule, $, { baseUrl: 'https://e.com/', source: {} }, opts || {});
  return r.strings;
}

/** 对 html 跑规则，返回 elems 的长度 */
function evalN(html, rule, opts) {
  const $ = cheerio.load(html);
  const r = R.evalRule(rule, $, { baseUrl: 'https://e.com/', source: {} }, opts || {});
  return r.elems ? r.elems.length : 0;
}

console.log('=== applyReplaceRegex（Legado AnalyzeRule.replaceRegex 语义） ===');
{
  eq('删方括号字符', R.applyReplaceRegex('[其他分类]', '[\\[\\]]', '', false), '其他分类');
  eq('全局替换', R.applyReplaceRegex('a-b-c', '-', '_', false), 'a_b_c');
  eq('replaceFirst=true 只留第一个匹配', R.applyReplaceRegex('abc def xyz', 'b', 'X', true), 'X');
  eq('replaceFirst=true 无匹配返回空串', R.applyReplaceRegex('abc', 'z', 'X', true), '');
  eq('带捕获组 $1', R.applyReplaceRegex('第12章', '(\\d+)', '[$1]', false), '第[12]章');
  eq('非法正则退回字面量替换', R.applyReplaceRegex('a.b', '(', 'X', false), 'a.b');
  eq('空替换串', R.applyReplaceRegex('x1y2z', '\\d', '', false), 'xyz');
}

console.log('\n=== 索引语法：尾缀 .N ===');
{
  const html = '<div class="list"><a>0</a><a>1</a><a>2</a><a>3</a></div>';
  eq('.list@a.0@text → 第 0 个', evalS(html, '.list@a.0@text'), ['0']);
  eq('.list@a.2@text → 第 2 个', evalS(html, '.list@a.2@text'), ['2']);
  eq('.list@a.-1@text → 最后一个（负索引）', evalS(html, '.list@a.-1@text'), ['3']);
  eq('.list@a.9@text → 越界丢弃', evalS(html, '.list@a.9@text'), []);
}

console.log('\n=== 索引语法：class.N 简写 ===');
{
  const html = '<div class="a">A</div><div class="a">B</div><div class="a">C</div>';
  eq('class.a.0@text', evalS(html, 'class.a.0@text'), ['A']);
  eq('class.a.1@text', evalS(html, 'class.a.1@text'), ['B']);
  eq('class.a.5@text 越界', evalS(html, 'class.a.5@text'), []);
}

console.log('\n=== 索引语法：! 排除 ===');
{
  const html = '<div class="l"><a>x</a><a>y</a><a>z</a></div>';
  const got = evalS(html, '.l@a!0@text').sort();
  eq('.l@a!0 → 排除第 0 个', got, ['y', 'z']);
}

console.log('\n=== 索引语法：区间 [a:b] / [a:b:c] ===');
{
  const html =
    '<div class="l">' + [0, 1, 2, 3, 4, 5].map((i) => `<a>${i}</a>`).join('') + '</div>';
  eq('.l@a[1:3] → 升序区间', evalS(html, '.l@a[1:3]@text'), ['1', '2', '3']);
  eq('.l@a[3:1] → 降序区间', evalS(html, '.l@a[3:1]@text'), ['3', '2', '1']);
  eq('.l@a[0:4:2] → 步长 2', evalS(html, '.l@a[0:4:2]@text'), ['0', '2', '4']);
  eq('.l@a[-2:] 语义（负数）不崩', evalN(html, '.l@a[!0]'), 5);
}

console.log('\n=== p[a:b] 切片：正文场景 ===');
{
  const html =
    '<div class="info_dv1">' +
    [0, 1, 2, 3, 4].map((i) => `<p>段${i}</p>`).join('') +
    '</div>';
  // 7941 的真实正文规则：跳过第 0 个 p（书名行），去掉最后 1 个 p
  eq('.info_dv1@p[1:-2]@text 取 p1..p3', evalS(html, '.info_dv1@p[1:-2]@text'), ['段1', '段2', '段3']);
  eq('.info_dv1@p[0:1]@text', evalS(html, '.info_dv1@p[0:1]@text'), ['段0', '段1']);
}

console.log('\n=== @ 链：属性 / html / 元素名 ===');
{
  const html =
    '<div class="b"><a href="/x/1.html" title="T1">A</a><a href="https://e.com/x/2.html">B</a></div>';
  eq('@href', evalS(html, '.b@a@href'), ['/x/1.html', 'https://e.com/x/2.html']);
  eq('@title', evalS(html, '.b@a@title'), ['T1']);
  eq('a.0@href 取第一个', evalS(html, '.b@a.0@href'), ['/x/1.html']);
  eq('@text 汇总', evalS(html, '.b@a@text'), ['A', 'B']);
}

console.log('\n=== 选择器简写：class. / id. / tag. / text. ===');
{
  const html = '<div class="cls">C</div><div id="i1">I</div><p class="pc">P</p>';
  eq('class.cls@text', evalS(html, 'class.cls@text'), ['C']);
  eq('id.i1@text', evalS(html, 'id.i1@text'), ['I']);
  eq('tag.p@text', evalS(html, 'tag.p@text'), ['P']);
  eq('tag.p.pc@text（tag.标签.类名）', evalS(html, 'tag.p.pc@text'), ['P']);
}

console.log('\n=== text.xxx：按文本找元素（findBylext） ===');
{
  const html = '<div class="m"><a href="/a.html">目录</a><a href="/b.html">下一章</a></div>';
  eq('text.目录@href', evalS(html, 'text.目录@href'), ['/a.html']);
  eq('text.下一@href（子串命中）', evalS(html, 'text.下一@href'), ['/b.html']);
  eq('text.不存在@href', evalS(html, 'text.不存在@href'), []);
}

console.log('\n=== || 短路：取第一个非空 ===');
{
  const html = '<div class="a">A</div>';
  eq('第一个有值', evalS(html, '.a@text||.b@text'), ['A']);
  eq('第一个空取第二个', evalS(html, '.b@text||.a@text'), ['A']);
  eq('都空', evalS(html, '.x@text||.y@text'), []);
}

console.log('\n=== && 并联（Legado getStringList：&& 与无操作符等价，addAll 并联） ===');
{
  // 两侧都非空 → 结果直接并联（不是「后一段作用在前一段结果上」）
  const html = '<div class="author">甲作者</div><div class="tag">分类甲</div>';
  eq('.author@text&&.tag@text 并联', evalS(html, '.author@text&&.tag@text'), ['甲作者', '分类甲']);
  // 只认第一个非空的 || 与之对照
  eq('对照 || 只取首个非空', evalS(html, '.author@text||.tag@text'), ['甲作者']);
  // 真实书源用例（起点中文网 7036）：两个作者格式各出一份，并联
  const h2 = '<div class="author"><a href="/a1">作者甲</a><a href="/a2">作者丙</a><span>作者乙</span></div>';
  eq('起点 ruleSearch.kind', evalS(h2, '.author@a.1@text&&.author@span@text'), ['作者丙', '作者乙']);
  const h3 = '<div class="book-attribute">分类甲</div><meta property="og:novel:update_time" content="2024-01-01">';
  eq('起点 ruleBookInfo.kind', evalS(h3, '.book-attribute@text&&[property="og:novel:update_time"]@content'), ['分类甲', '2024-01-01']);
}

console.log('\n=== %% 交错（Legado：以 results[0] 下标为准交织） ===');
{
  const html = '<div class="l"><li><a class="n" href="/1">甲</a></li><li><a class="n" href="/2">乙</a></li><li><a class="n" href="/3">丙</a></li></div>';
  eq('li@a.n@href %% li@text', evalS(html, 'li@a.n@href%%li@text'), ['/1', '甲', '/2', '乙', '/3', '丙']);
  const html2 = '<div class="l"><i>1</i><i>2</i><i>3</i><i>4</i></div>';
  eq('长度不等时按下标截断', evalS(html2, '.l@i@text%%.l@i[0]@text'), ['1', '1', '2', '3', '4']);
}

console.log('\n=== ## 正则替换挂在整条规则上 ===');
{
  const html = '<div class="s"><span class="s1">[其他分类]</span></div>';
  eq('.s@.s1@text##[\\[\\]]', evalS(html, '.s@.s1@text##[\\[\\]]'), ['其他分类']);
  eq('.s@.s1@text##^\\[|\\]$', evalS(html, '.s@.s1@text##^\\[|\\]$'), ['其他分类']);
  eq('##regex##replacement', evalS(html, '.s@.s1@text##其他##玄幻'), ['[玄幻分类]']);
  eq('## 三段（replaceFirst）', evalS(html, '.s@.s1@text##\\[##'), ['其他分类]']);
  const html2 = '<div class="k"><span>[a]</span><span>[b]</span></div>';
  eq('列表逐项替换', evalS(html2, '.k@span@text##[\\[\\]]'), ['a', 'b']);
}

console.log('\n=== jsoup 特有：[attr~=regex] 属性正则匹配 ===');
{
  const html = `<html><head>
    <meta property="og:novel:author" content="澄光">
    <meta property="og:novel:category" content="其他小说">
    <meta property="og:novel:status" content="连载中">
    <meta property="og:novel:update_time" content="2023-11-02 20:59:11">
    <meta property="og:image" content="/img/1.jpg">
    <meta property="og:novel:latest_chapter_name" content="第140章">
  </head></html>`;
  eq('[property="og:novel:author"]@content', evalS(html, '[property="og:novel:author"]@content'), ['澄光']);
  eq(
    '[property~=category|status|update_time]@content → 3 个',
    evalS(html, '[property~=category|status|update_time]@content'),
    ['其他小说', '连载中', '2023-11-02 20:59:11']
  );
  eq('[property~=las?test_chapter_name]@content（可选字符）', evalS(html, '[property~=las?test_chapter_name]@content'), ['第140章']);
  eq('[property="og:novel:book_name"]@content 精确匹配', evalS(html + '<meta property="og:novel:book_name" content="B">', '[property="og:novel:book_name"]@content'), ['B']);
  eq('不匹配的属性返回空', evalS(html, '[property~=nothere]@content'), []);
}

console.log('\n=== 尾随 @ / 前导 - ===');
{
  const html = '<div class="d"><a href="/1.html">x</a></div>';
  eq('text.目录@href@（尾随 @）', evalS(html, 'text.不存在@href@'), []);
  ok('尾随 @ 不报错', true);
}

console.log('\n=== @css: 前缀 ===');
{
  const html = '<div id="c"><span class="s">S</span></div>';
  eq('@css: #c > .s@text', evalS(html, '@css: #c > .s@text'), ['S']);
  eq('@css: 逗号选择器', evalS('<i>1</i><b>2</b>', '@css: i, b@text'), ['1', '2']);
}

console.log('\n=== 相对 URL 绝对化（absUrl(base, href)） ===');
{
  eq('根相对', R.absUrl('https://e.com/x/y.html', '/a/b.html'), 'https://e.com/a/b.html');
  eq('文档相对', R.absUrl('https://e.com/x/y.html', 'c.html'), 'https://e.com/x/c.html');
  eq('已是绝对', R.absUrl('https://e.com/', 'https://o.com/z'), 'https://o.com/z');
  eq('协议相对', R.absUrl('https://e.com/', '//cdn.com/a.js'), 'https://cdn.com/a.js');
  eq('空 href', R.absUrl('https://e.com/', ''), '');
  eq('javascript: 原样', R.absUrl('https://e.com/', 'javascript:void(0)'), 'javascript:void(0)');
}

console.log('\n=== isBadUrl：过滤无效链接 ===');
{
  ok('javascript:void(0) 判坏', R.isBadUrl('javascript:void(0)') === true);
  ok('# 判坏', R.isBadUrl('#') === true);
  ok('空串判坏', R.isBadUrl('') === true);
  ok('正常 http 判好', R.isBadUrl('https://e.com/a') === false);
  ok('相对路径判好', R.isBadUrl('/a/b.html') === false);
}

console.log('\n=== splitTop / splitOp：括号与引号感知 ===');
{
  eq('splitTop 基础', R.splitTop('a@b@c', '@'), ['a', 'b', 'c']);
  eq('splitTop 不切 [] 内', R.splitTop('a@b[x@y]@c', '@'), ['a', 'b[x@y]', 'c']);
  eq('splitTop 不切引号内', R.splitTop("a@'b@c'@d", '@'), ['a', "'b@c'", 'd']);
  eq('splitOp 基础', R.splitOp('a&&b||c', '&&'), ['a', 'b||c']);
  eq('splitOp 不切 [] 内', R.splitOp('a[&&]b&&c', '&&'), ['a[&&]b', 'c']);
}

console.log('\n=== jsonPath：入参是 JSON 文本，返回值一律字符串化 ===');
{
  const src = JSON.stringify({ a: { b: [{ c: 1 }, { c: 2 }] }, list: [1, 2, 3] });
  eq('$.a.b[0].c → "1"', R.jsonPath(src, '$.a.b[0].c'), '1');
  eq('$.list[1] → "2"', R.jsonPath(src, '$.list[1]'), '2');
  eq('$.a.b → JSON 串', R.jsonPath(src, '$.a.b'), '[{"c":1},{"c":2}]');
  eq('通配 $.a.b[*].c → 多行', R.jsonPath(src, '$.a.b[*].c'), '1\n2');
  eq('非法 JSON 返回空串', R.jsonPath('not json', '$.a'), '');
  eq('空输入返回空串', R.jsonPath('', '$.a'), '');
  eq('路径取对象', R.jsonPath(JSON.stringify({ o: { x: 1 } }), '$.o'), '{"x":1}');
}

console.log('\n=== expandBraces（需要 ctx.js） ===');
{
  const fakeJs = { run: (code) => (code.includes('"k"') || code.includes("'k'") ? 'VAL' : '') };
  eq('无 {{ }} 原样返回', R.expandBraces('plain', { js: fakeJs }), 'plain');
  eq('无 ctx.js 原样返回', R.expandBraces('{{x}}', {}), '{{x}}');
  eq('展开 {{ "k" }}', R.expandBraces('a-{{"k"}}-b', { js: fakeJs }), 'a-VAL-b');
  const throwing = {
    run: () => {
      throw new Error('boom');
    },
  };
  eq('JS 抛错时替换为空串（不崩）', R.expandBraces('a{{x}}b', { js: throwing }), 'ab');
}

console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
