// 精确核对 README 里宣称支持的语法是否真的支持
const cheerio = require('cheerio');
const R = require('../src/rules/rule.js');

const html = `<html><body>
<div class="list">
  <li><a class="n" href="/a/1.html">甲</a></li>
  <li><a class="n" href="/a/2.html">乙</a></li>
  <li><a class="n" href="/a/3.html">丙</a></li>
</div>
<pre id="content">正文内容</pre>
</body></html>`;

const $ = cheerio.load(html);

function tryRule(label, rule, opts = {}) {
  try {
    const r = R.evalRule(rule, $, {}, opts);
    const s = r.strings && r.strings.length ? r.strings : (r.elems ? r.elems.map((_i, e) => e.tagName || e.name).get() : []);
    console.log(`${label.padEnd(46)} → ${JSON.stringify(s).slice(0, 110)}`);
  } catch (e) {
    console.log(`${label.padEnd(46)} → ✗ ${e.message}`);
  }
}

console.log('=== A. 组合符 ===');
tryRule('a.n@href  (基准)', 'a.n@href');
tryRule('li.0@a@href || 不存在@href', 'li.0@a@href||li.9@a@href');
tryRule('%% 交错 (li%%a)', 'li@a.n@href%%li@text');
tryRule('li.0@a@href && li.0@a@text', 'li.0@a@href&&li.0@a@text');

console.log('\n=== B. 前缀 ===');
tryRule('@css:.list@li@a@href', '@css:.list@li@a@href');
tryRule('@XPath://li/a@href', '@XPath://li/a@href');
tryRule('$.xxx (json)', '$.a.b', { result0: '{"a":{"b":"值"}}' });
tryRule('@json:$.a.b', '@json:$.a.b', { result0: '{"a":{"b":"值"}}' });
tryRule('@rule:li.0@a@href', '@rule:li.0@a@href');

console.log('\n=== C. 索引语法 ===');
tryRule('li.1@a@text', 'li.1@a@text');
tryRule('li.-1@a@text', 'li.-1@a@text');
tryRule('li!0@a@text', 'li!0@a@text');
tryRule('li[0:2]@a@text', 'li[0:2]@a@text');
tryRule('li[0:3:2]@a@text', 'li[0:3:2]@a@text');
tryRule('li[!0]@a@text', 'li[!0]@a@text');
tryRule('li[0,2]@a@text', 'li[0,2]@a@text');

console.log('\n=== D. 取值操作 ===');
tryRule('#content@text', '#content@text');
tryRule('#content@html', '#content@html');
tryRule('#content@all', '#content@all');
tryRule('a.n@tag', 'a.n@tag');

console.log('\n=== E. 正则 ===');
tryRule('a.n@text##[甲乙]', 'a.n@text##[甲乙]');
tryRule('a.n@text##甲##A', 'a.n@text##甲##A');
tryRule('a.n@text##[甲乙丙]##X###', 'a.n@text##[甲乙丙]##X###');

console.log('\n=== F. jsoup 扩展 ===');
tryRule('a[href~=/a/2]@text', 'a[href~=/a/2]@text');
tryRule('li[class~=^li$]@a@text', 'li[class~=^li$]@a@text');

console.log('\n=== G. 切片 ===');
tryRule('li@p', 'li@p');
tryRule('#content@p[0:-1]', '#content@p[0:-1]');
