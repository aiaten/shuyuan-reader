'use strict';
// 探查 cheerio 对象上可用的 HTML 序列化 API，用于对齐 Legado 的 outerHtml()。
const cheerio = require('cheerio');
const $ = cheerio.load('<div class="a"><script>x</script><p>t</p></div>');
const els = $('.a');
console.log('typeof els.outerHtml :', typeof els.outerHtml);
console.log('typeof els.html      :', typeof els.html);
console.log('typeof els.toArray   :', typeof els.toArray);
console.log('String(els)          :', String(els));
console.log('els.html()           :', els.html());
if (typeof els.outerHtml === 'function') console.log('els.outerHtml()      :', els.outerHtml());
console.log('$.html(els)          :', $.html(els));
console.log('$.html(els.first())  :', $.html(els.first()));
// 多个元素
const $2 = cheerio.load('<p>1</p><p>2</p>');
console.log('$.html($2("p"))      :', $2.html($2('p')));
console.log('$.root().html()      :', $2.root().html());
