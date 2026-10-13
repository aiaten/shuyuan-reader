const cheerio = require('cheerio');
const html = `<div id="allCatalog"><div class="catalog-volume"><label class="volume-name">第一卷</label><ul><li><a href="/c/1.html" title="更新时间：x 章节">第一章</a><em class="chapter-locked"></em></li><li><a href="/c/2.html">第二章</a></li></ul></div></div>`;
const $ = cheerio.load(html);
const sel = $('#allCatalog>.catalog-volume>label,#allCatalog>.catalog-volume>ul');
console.log('len =', sel.length);
console.log('toString =', String(sel).slice(0, 120).replace(/\n/g, ' '));
console.log('sel[0] typeof =', typeof sel[0], sel[0] && sel[0].type, sel[0] && sel[0].name);
console.log('$(sel[0]).find(li).length =', $(sel[0]).find('li').length);
const keys = [];
for (const k in sel) keys.push(k);
console.log('for-in keys =', JSON.stringify(keys));
console.log('isArray =', Array.isArray(sel), 'len prop =', sel.length);
console.log('sel.find exists =', typeof sel.find, 'sel.select =', typeof sel.select);
console.log('forEach =', typeof sel.forEach);
// element wrapper check
const li = $(sel[1]).find('li');
console.log('li.length =', li.length, 'li[0].name =', li[0].name);
console.log('EM test =', String($(li[0]).find('em')));
