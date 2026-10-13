'use strict';
/*
 * 探针：JS 块内出现 && / || / ## 时，规则切分是否会把它误当组合符。
 * Legado 的做法（AnalyzeRule.splitSourceRule）是**先**用 JS_PATTERN 把 <js>...</js> / @js:...
 * 摘成独立的 SourceRule，**再**对剩余部分做 @ / && / || 切分。若我们反过来（先切操作符、
 * 后认 JS 段），JS 体里裸露的 && 就会被当成组合符截断。
 * 跑法：node test/probe-jsblock.js
 */
const path = require('path');
const R = require(path.join(__dirname, '..', 'src', 'rules', 'rule.js'));
const cheerio = require('cheerio');

const HTML = '<div class="content"><p>甲</p><p>乙</p></div>';

function run(rule) {
  const $ = cheerio.load(HTML, null, false);
  const js = {
    run(code, vars) {
      // 沙箱只提供 result，便于观察 JS 体是否被完整传入
      const f = new Function('result', 'return (' + code + ')');
      return f(vars && vars.result);
    },
  };
  try {
    const r = R.evalRule(rule, $, { js }, {});
    return { ok: true, strings: r.strings };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

console.log('=== 1. JS 体内裸露 && （无括号包裹）===');
// 期望：把 '甲\n乙' 传进 JS，返回布尔/拼接结果；若被切分则 JS 体残缺
console.log('  ', JSON.stringify(run('class.content@html@js:result.length>2&&"OK"')));

console.log('\n=== 2. JS 体内 && 被 (function(){...})() 包裹 ===');
console.log('  ', JSON.stringify(run('class.content@html@js:(function(){var s=String(result);return s.length>2&&"OK";})()')));

console.log('\n=== 3. JS 体内 || ===');
console.log('  ', JSON.stringify(run('class.content@html@js:result||"空"')));

console.log('\n=== 4. <js> 块 + 后续 URL 模板（7941 searchUrl 形态）===');
console.log('  ', JSON.stringify(run('<js>"pre"</js>\nclass.content@p@text')));

console.log('\n=== 5. JS 体内 ## ===');
console.log('  ', JSON.stringify(run('class.content@html@js:String(result).replace(/</g,"[").replace(/>/g,"]")')));

console.log('\n=== 6. 对照：Legado 语义下 1 应为 ["OK"] ===');
