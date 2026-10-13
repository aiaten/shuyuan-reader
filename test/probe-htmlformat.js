const H = require('../src/util/htmlformat');

const html = '<p>第一段</p><p>第二段</p><div>第三段</div>你好&nbsp;世界&amp;符号<img src="/a.jpg">图片后';
console.log('--- format ---');
console.log(JSON.stringify(H.format(html)));
console.log('--- formatKeepImg ---');
console.log(JSON.stringify(H.formatKeepImg(html, 'https://x.com/book/1.html', (b, h) => require('../src/rules/rule').absUrl(b, h))));
console.log('--- formatContent ---');
console.log(JSON.stringify(H.formatContent(html, 'https://x.com/book/1.html', (b, h) => require('../src/rules/rule').absUrl(b, h))));
console.log('--- usehtml 保留 ---');
const h2 = '<p>前</p><usehtml><div><script>x</script><p>自定义</p></div></usehtml><p>后</p>';
console.log(JSON.stringify(H.formatContent(h2, null, null)));
console.log('--- 实体 ---');
console.log(JSON.stringify(H.unescapeHtml4('&lt;a&gt; &#65; &#x4e2d; &nbsp; &unknown; &amp;')));
