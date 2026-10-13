// 验证：1) cheerio 实例能否挂自定义属性；2) $.html() 是否保留 og: meta 原始属性顺序
const cheerio = require('cheerio');
const html = `<!DOCTYPE html><html><head>
<meta property="og:image" content="/img/a.jpg">
<meta property="og:novel:book_name" content="书甲">
</head><body><div class="c">正文</div></body></html>`;

const $ = cheerio.load(html);
$.rawHtml = html;
console.log('rawHtml 挂载:', typeof $.rawHtml === 'string', $.rawHtml.length);
console.log('$.html() 长度:', $.html().length);
const re = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/;
const m1 = $.html().match(re);
const m2 = html.match(re);
console.log('对 $.html() 匹配:', m1 && m1[1]);
console.log('对原始 html 匹配:', m2 && m2[1]);
const re2 = /<meta[^>]+property="og:novel:book_name"[^>]+content="([^"]+)"/;
console.log('书名(经 $.html()):', ($.html().match(re2) || [])[1]);
