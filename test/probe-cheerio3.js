const cheerio = require('cheerio');
const doc = cheerio.load('<a href="/book/1/2.html">第一章</a><a href="/book/1/3.html">第二章</a>', null, false);
console.log('doc.root().find(a).length =', doc.root().find('a').length);
console.log('doc(a).length =', doc('a').length);
const R = require('../src/rules/rule.js');
console.log('evalRule root=doc.root():', JSON.stringify(R.evalRule('a@text', doc, {}, { root: doc.root() })));
console.log('evalRule result0:', JSON.stringify(R.evalRule('a@text', doc, {}, { result0: '<a href="/x">甲</a>' })));
console.log('evalRule asHtml:', JSON.stringify(R.evalRule('a@text', doc, {}, { result0: '<a href="/x">甲</a>', asHtml: true })));
