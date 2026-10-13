'use strict';
/** http.js + encoding.js + cookiejar.js 冒烟测试 */
const path = require('path');
const { get, request, preconnect } = require(path.join(__dirname, '..', 'src', 'net', 'http'));
const { CookieJar } = require(path.join(__dirname, '..', 'src', 'net', 'cookiejar'));

const targets = [
  'https://www.zuizhong.net/',
  'https://www.yck2026.fun/yuedu/shuyuan/index.html',
  'https://www.shenwen.org/',
  'https://www.uushuk.com/',
];

(async () => {
  for (const url of targets) {
    const t0 = Date.now();
    try {
      const r = await get(url, { timeout: 30000 });
      const ms = Date.now() - t0;
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.text);
      console.log(`OK  ${url}`);
      console.log(`    ${ms}ms status=${r.status} bytes=${r.body.length} charset=${r.charset} textlen=${r.text.length}`);
      console.log(`    title=${title ? title[1].trim().slice(0, 60) : '(none)'}`);
      console.log(`    set-cookie=${(r.headers['set-cookie'] || []).length}`);
    } catch (e) {
      console.log(`ERR ${url}`);
      console.log(`    ${Date.now() - t0}ms ${e.code || ''} ${e.message}`);
    }
  }

  // cookie 往返
  const jar = new CookieJar();
  jar.setFromResponse('https://www.zuizhong.net/a/b', ['SID=abc123; Path=/; HttpOnly', 'lang=zh; Path=/a']);
  console.log('jar header:', jar.getCookieHeader('https://www.zuizhong.net/a/b/c'));
  console.log('jar exclude :', JSON.stringify(jar.getCookieHeader('https://www.zuizhong.net/x')));
  console.log('jar get SID :', jar.get('SID', 'https://www.zuizhong.net/'));
})();
