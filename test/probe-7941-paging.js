'use strict';
/**
 * 查清 7941 章节页的分页链路：
 *  - 目录里第 1 章与第 2 章的 URL
 *  - 第 1 章页面上的「下一章」href 与目录里第 2 章 URL 是否一致
 *  - 沿 href 连抓数页，看 h2 标题的「（第N页）」如何变化、正文如何变化
 */
const cheerio = require('cheerio');
const http = require('../src/net/http');

const BASE = 'https://www.zuizhong.net';
const TOC = `${BASE}/book/60434/1.html`;

const info = ($) => {
  const h2 = $('h2.chapter-title').text().trim();
  const dv = $('.info_dv1');
  const txt = dv.text().replace(/\s+/g, ' ').trim();
  const links = [];
  $('a').each((_i, el) => {
    const $e = $(el);
    const t = $e.contents().filter((_k, n) => n.type === 'text').text().trim();
    if (!t) return;
    if (/上一|下一|目录|返回/.test(t)) links.push(`${t}→${$e.attr('href')}`);
  });
  return { h2, len: txt.length, head: txt.slice(0, 60), links: links.join('  |  ') };
};

(async () => {
  const tocRes = await http.get(TOC);
  const $$ = cheerio.load(tocRes.text);
  const chs = [];
  $$('a[onclick*="read_tz"]').each((_i, el) => {
    const $e = $$(el);
    chs.push({ name: $e.text().trim(), href: $e.attr('href') || $e.attr('onclick') });
  });
  console.log(`目录页 a[onclick*=read_tz] 命中 ${chs.length} 个，前 4 个:`);
  chs.slice(0, 4).forEach((c, i) => console.log(`  [${i}] ${c.name}  ${c.href}`));

  // 目录里前 4 章的 href 到底是什么？
  const firstA = $$('a[onclick*="read_tz"]').first();
  console.log(`\n首个章节 a 的全部属性: ${JSON.stringify(firstA.attr ? firstA.attr() : null)}`);

  // 目录页里第一个 li 的完整 HTML
  const firstLi = $$('a[onclick*="read_tz"]').first().closest('li');
  console.log(`\n首个 li HTML:\n${firstLi.html()}`);

  let cur = 'https://www.zuizhong.net/book/60434/yuedu-15920759.html';
  for (let i = 0; i < 5; i++) {
    const r = await http.get(cur);
    const $ = cheerio.load(r.text);
    const d = info($);
    console.log(`\n[${i}] ${cur}\n    status=${r.status} len=${r.text.length}\n    h2="${d.h2}"  .info_dv1 文本长=${d.len}\n    头: ${d.head}\n    links: ${d.links}`);
    const nx = d.links.split('  |  ').find((l) => l.startsWith('下一'));
    if (!nx) break;
    const href = nx.split('→')[1];
    if (href === cur) { console.log('    自环，停'); break; }
    cur = new URL(href, cur).toString();
  }
})().catch((e) => { console.error(e); process.exit(1); });
