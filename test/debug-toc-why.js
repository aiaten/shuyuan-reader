'use strict';
/**
 * 同一个目录 URL，用不同方式取回，比较 .info_dv3 / .info_dv1 的数量，
 * 找出 e2e（成功 100 章）与裸抓（0 章）的差异来源。
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const http = require('../src/net/http');
const { CookieJar } = require('../src/net/cookiejar');
const { SourceEngine } = require('../src/engine/source');
const R = require('../src/rules/rule');

const SRC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '_recon', 'src_7941.json'), 'utf8'))[0];
const TOC = 'https://www.zuizhong.net/book/60434/1.html';
const RULE = '.info_dv3.1@ul@a';

function report(label, html) {
  const $ = cheerio.load(html);
  const n3 = $('.info_dv3').length;
  const nAny = $('[class*="info_dv"]').length;
  const classes = [];
  $('[class*="info_dv"]').each((i, el) => classes.push($(el).attr('class')));
  const res = R.evalRule(RULE, $, {}, {});
  const as = $('.info_dv3').find('ul').find('a').length;
  console.log(`[${label}] len=${html.length}  .info_dv3=${n3}  [class*=info_dv]=${nAny}  ul内a=${as}  evalRule elems=${res.elems ? res.elems.length : 0}`);
  console.log(`          classes=${JSON.stringify(classes)}`);
  return { $, n3 };
}

(async () => {
  // A. 裸抓，无 cookie
  const a = await http.get(TOC);
  report('裸抓 无cookie', a.text);

  // B. 带 jar 但先不访问搜索页
  const jar1 = new CookieJar();
  const b = await http.get(TOC, { jar: jar1 });
  report('裸抓 有jar', b.text);
  console.log(`          jar cookies=${JSON.stringify(jar1.toJSON())}`);

  // C. 走引擎 _fetch（e2e 的路径）
  const engine = new SourceEngine(SRC, { jar: new CookieJar() });
  const c = await engine._fetch(TOC, {});
  report('引擎 _fetch', c.text);

  // D. 先搜索再取目录（e2e 的实际顺序，带会话）
  const engine2 = new SourceEngine(SRC, { jar: new CookieJar() });
  const items = await engine2.search('诡秘之主', 1);
  console.log(`\n搜索命中 ${items.length}，jar cookies=${JSON.stringify(engine2.jar.toJSON())}`);
  const d = await engine2._fetch(TOC, {});
  report('引擎 先搜索后取目录', d.text);

  // E. 直接把 C/D 存盘，方便逐字节比
  fs.mkdirSync(path.join(__dirname, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '.cache', 'cmp-C-engine.txt'), c.text, 'utf8');
  fs.writeFileSync(path.join(__dirname, '.cache', 'cmp-D-after-search.txt'), d.text, 'utf8');
  fs.writeFileSync(path.join(__dirname, '.cache', 'cmp-A-bare.txt'), a.text, 'utf8');
  console.log('\n已存 cmp-{A,B,C,D} 到 test/.cache/');
})().catch((e) => { console.error(e); process.exit(1); });
