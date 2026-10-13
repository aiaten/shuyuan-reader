/* 检查 zuizhong.net 各页面上 .info_dv3 / .info_dv* 的数量与结构 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'test/.cache/7941-book.html',
      'test/.cache/7941-toc.html',
      'test/.cache/7941-toc-desktop.html',
      'test/.cache/7941-toc-android.html',
    ];

for (const f of files) {
  const p = path.resolve(f);
  if (!fs.existsSync(p)) { console.log(`--- ${f}: (missing)`); continue; }
  const html = fs.readFileSync(p, 'utf8');
  const $ = cheerio.load(html);
  const classes = new Set();
  $('[class*=info_dv]').each((_i, el) => {
    const c = $(el).attr('class') || '';
    c.split(/\s+/).filter((x) => /^info_dv/.test(x)).forEach((x) => classes.add(x));
  });
  console.log(`--- ${f} (${html.length}B) title=${JSON.stringify($('title').text().slice(0, 40))}`);
  console.log('    info_dv* 类名:', [...classes].join(', ') || '(none)');
  for (const c of classes) {
    const n = $('.' + c).length;
    console.log(`    .${c} = ${n} 个; 各元素 ul=${$( '.' + c).find('ul').length} a=${$('.' + c).find('a').length}`);
  }
  const ulAll = $('ul').length;
  console.log(`    全页 ul=${ulAll} a=${$('a').length}`);
}
