'use strict';
/** 试探 zuizhong.net 搜索接口的正确请求形态 */
const http = require('../src/net/http');
const { CookieJar } = require('../src/net/cookiejar');

const KEY = '诡秘之主';
const enc = encodeURIComponent(KEY);

const cases = [
  ['POST 裸 UTF-8 body', { method: 'POST', body: `s=${KEY}` }],
  ['POST 百分号编码 body', { method: 'POST', body: `s=${enc}` }],
  ['POST 编码+表单Content-Type', { method: 'POST', body: `s=${enc}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }],
  ['POST 裸+表单Content-Type', { method: 'POST', body: `s=${KEY}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }],
];

(async () => {
  for (const [label, opt] of cases) {
    try {
      const jar = new CookieJar();
      // 先访问首页拿 cookie（部分站点要求）
      await http.request('https://www.zuizhong.net/', { jar });
      const r = await http.request('https://www.zuizhong.net/search.html', { ...opt, jar });
      const hit = r.text.includes(KEY);
      const list = r.text.includes('txt-list');
      console.log(`${label.padEnd(30)} status=${r.status} len=${r.body.length} 含关键词=${hit} 含txt-list=${list} final=${r.url}`);
    } catch (e) {
      console.log(`${label.padEnd(30)} ERROR ${e.message}`);
    }
  }

  // GET 形式也试一下
  for (const [label, url] of [
    ['GET ?s=裸', `https://www.zuizhong.net/search.html?s=${KEY}`],
    ['GET ?s=编码', `https://www.zuizhong.net/search.html?s=${enc}`],
  ]) {
    try {
      const r = await http.request(url, { jar: new CookieJar() });
      console.log(`${label.padEnd(30)} status=${r.status} len=${r.body.length} 含关键词=${r.text.includes(KEY)} 含txt-list=${r.text.includes('txt-list')}`);
    } catch (e) {
      console.log(`${label.padEnd(30)} ERROR ${e.message}`);
    }
  }
})();
