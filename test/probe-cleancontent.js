const H = require('../src/util/htmlformat');
const { cleanContent } = require('../src/engine/source');

const html = '<p>第一段</p><p>第二段</p><p>第三段</p>';
const fmt = H.formatContent(html, null, null);
console.log('formatContent 原文:', JSON.stringify(fmt));
console.log('再经 cleanContent :', JSON.stringify(cleanContent(fmt)));
console.log('trim 是否吃 \\u3000 :', JSON.stringify('\u3000\u3000abc'.trim()));
