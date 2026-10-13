const cheerio = require('cheerio');
const $ = cheerio.load('<div class="l"><i>a</i><i>b</i></div><div class="m"><i>c</i></div>');
const a = $('.l > i');
const b = $('.m > i');
console.log('a=', a.length, 'b=', b.length);
const arr = [...a.toArray(), ...b.toArray()];
const c = $(arr);
console.log('$(arr).length =', c.length, 'texts=', c.map((_i, e) => $(e).text()).get());
const d = a.add(b);
console.log('a.add(b).length =', d.length, 'texts=', d.map((_i, e) => $(e).text()).get());
const e = $([]);
console.log('$([]).length =', e.length);
// per-element setContent semantics: string -> parse
const doc = cheerio.load('<a href="/book/1/2.html">第一章</a>', null, false);
console.log('doc a@text =', doc('a').text(), 'href =', doc('a').attr('href'));
