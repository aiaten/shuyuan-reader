'use strict';
/**
 * URL 编码语义单元测试（逐行对齐 Legado NetworkUtils / EncoderUtils / AnalyzeUrl）。
 * 跑法：node test/unit-encode.js
 */

const E = require('../src/net/encode.js');

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

console.log('=== encodedForm：认定「已是合法 form 编码」（保留表 = alnum + * - . _） ===');
{
  ok('纯字母数字通过', E.encodedForm('abc123') === true);
  ok('*-._ 通过', E.encodedForm('*-._') === true);
  ok('%E4%B8%AD 经编码通过', E.encodedForm('%E4%B8%AD') === true);
  ok('中文未编码 → 不通过', E.encodedForm('中文') === false);
  ok('空格 → 不通过', E.encodedForm('a b') === false);
  ok('& → 不通过（form 表不含 &）', E.encodedForm('a&b') === false);
  ok('= → 不通过（form 表不含 =）', E.encodedForm('a=b') === false);
  ok('+ → 不通过', E.encodedForm('a+b') === false);
  ok('% 后非两位 hex → 不通过', E.encodedForm('%ZZ') === false);
  ok('孤立 % → 不通过', E.encodedForm('a%') === false);
}

console.log('\n=== encodedQuery：保留表更宽（含 & = ? / : @ 等） ===');
{
  ok('URL 通过', E.encodedQuery('http://a.com/b?c=1&d=2') === true);
  ok('& = ? / 都通过', E.encodedQuery('&=?/') === true);
  ok('# 不通过', E.encodedQuery('a#b') === false);
  ok('% 不通过', E.encodedQuery('a%') === false);
  ok('中文不通过', E.encodedQuery('中文') === false);
  ok('~ 通过（query 表含 ~）', E.encodedQuery('a~b') === true);
  ok("' 不通过（query 表不含单引号）", E.encodedQuery("a'b") === false);
  ok('" 不通过', E.encodedQuery('a"b') === false);
}

console.log('\n=== urlEncoderEncode：java.net.URLEncoder 语义（空格 → +） ===');
{
  eq('空格 → +', E.urlEncoderEncode('a b', 'utf-8'), 'a+b');
  eq('字母数字原样', E.urlEncoderEncode('abc123', 'utf-8'), 'abc123');
  eq('*-._ 原样', E.urlEncoderEncode('*-._', 'utf-8'), '*-._');
  eq('中文 → 大写 %XX', E.urlEncoderEncode('中', 'utf-8'), '%E4%B8%AD');
  eq('中文 GBK', E.urlEncoderEncode('中', 'gbk'), '%D6%D0');
  eq('+ 被编码为 %2B', E.urlEncoderEncode('a+b', 'utf-8'), 'a%2Bb');
  eq('& 被编码为 %26', E.urlEncoderEncode('a&b', 'utf-8'), 'a%26b');
  eq('= 被编码为 %3D', E.urlEncoderEncode('a=b', 'utf-8'), 'a%3Db');
  eq('/ 被编码为 %2F', E.urlEncoderEncode('a/b', 'utf-8'), 'a%2Fb');
  eq('~ 被编码为 %7E（Java 语义，不同于 JS）', E.urlEncoderEncode('~', 'utf-8'), '%7E');
}

console.log('\n=== escapeEncode：Legado EncoderUtils.escape（不是 JS escape） ===');
{
  // EncoderUtils.kt:11-28 —— 仅 alnum 保留；prefix = code<16?'%0':code<256?'%':'%u'，hex 小写不补零
  eq('空格 → %20', E.escapeEncode(' '), '%20');
  eq('! → %21', E.escapeEncode('!'), '%21');
  eq('换行 \\n → %0a', E.escapeEncode('\n'), '%0a');
  eq('中文 中 → %u4e2d', E.escapeEncode('中'), '%u4e2d');
  eq('字母数字原样', E.escapeEncode('aZ09'), 'aZ09');
  eq('@ → %40', E.escapeEncode('@'), '%40');
  eq('& → %26', E.escapeEncode('&'), '%26');
  eq('tab → %09', E.escapeEncode('\t'), '%09');
}

console.log('\n=== encodeQueryParams：AnalyzeUrl 专用表（含 ~ 和反引号，大写 hex） ===');
{
  eq('中文大写 hex', E.encodeQueryParams('中', 'utf-8'), '%E4%B8%AD');
  eq('空格 → %20（不是 +）', E.encodeQueryParams('a b', 'utf-8'), 'a%20b');
  eq('~ 原样', E.encodeQueryParams('~', 'utf-8'), '~');
  eq('& 原样', E.encodeQueryParams('a&b', 'utf-8'), 'a&b');
  eq('= 原样', E.encodeQueryParams('a=b', 'utf-8'), 'a=b');
  eq('中文 GBK', E.encodeQueryParams('中', 'gbk'), '%D6%D0');
}

console.log('\n=== encodeParams：form 分支（isQuery=false） ===');
{
  // charset 为空 → checkEncoded = true（已是合法编码则原样）
  eq('已是编码原样保留', E.encodeParams('s=%E4%B8%AD', null, false), 's=%E4%B8%AD');
  eq('未编码中文 → 按 utf-8 URLEncoder（+ 表）', E.encodeParams('s=中', null, false), 's=%E4%B8%AD');
  eq('空格 → +', E.encodeParams('s=a b', null, false), 's=a+b');
  eq('多组 & 切分', E.encodeParams('a=1&b=2', null, false), 'a=1&b=2');
  eq('值是中文', E.encodeParams('key=值', null, false), 'key=%E5%80%BC');
  eq('只有 key 无 =', E.encodeParams('justkey', null, false), 'justkey');
  eq('gbk charset', E.encodeParams('s=中', 'gbk', false), 's=%D6%D0');
}

console.log('\n=== encodeParams：escape charset ===');
{
  // charset === 'escape' → cs = null → escapeEncode
  eq("charset='escape' 走 escapeEncode", E.encodeParams('s=中', 'escape', false), 's=%u4e2d');
  eq("charset='escape' 空格", E.encodeParams('s=a b', 'escape', false), 's=a%20b');
}

console.log('\n=== encodeParams：query 分支（isQuery=true） ===');
{
  // isQuery && cs != null → 整串判定后整体重编码
  eq('已是合法 query 原样', E.encodeParams('a=1&b=2', null, true), 'a=1&b=2');
  eq('中文整体重编码', E.encodeParams('s=中', null, true), 's=%E4%B8%AD');
  eq('空格用 %20（不是 +）', E.encodeParams('s=a b', null, true), 's=a%20b');
  eq('escape charset 走 escape', E.encodeParams('s=中', 'escape', true), 's=%u4e2d');
}

console.log('\n=== 与真实场景对照（7941 书源 searchUrl 的 body） ===');
{
  // searchUrl: "https://www.zuizhong.net/search.html,{\"method\":\"POST\",\"body\":\"s={{key}}\"}"
  const body = 's=诡秘之主';
  const encoded = E.encodeParams(body, null, false);
  ok('中文被编码', !/[\u4e00-\u9fa5]/.test(encoded), encoded);
  eq('结果符合 URLEncoder 语义', encoded, 's=%E8%AF%A1%E7%A7%98%E4%B9%8B%E4%B8%BB');
  // 二次编码应当原样返回（幂等性）
  eq('幂等性：已编码不再编码', E.encodeParams(encoded, null, false), encoded);
}

console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
