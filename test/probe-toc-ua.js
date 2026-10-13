/* 探测 zuizhong.net 目录页在不同 UA 下的结构差异 */
const http = require('../src/net/http.js');
const fs = require('fs');

const UAS = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 13; SM-S9080) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  none: '',
};

const URL = 'https://www.zuizhong.net/book/60434/1.html';

(async () => {
  for (const [name, ua] of Object.entries(UAS)) {
    try {
      const r = await http.get(URL, { headers: ua ? { 'User-Agent': ua } : { 'User-Agent': '' } });
      const t = r.text;
      const info = (t.match(/info_dv3/g) || []).length;
      const nonclick = (t.match(/onclick="read_tz\(/g) || []).length;
      const hrefCh = (t.match(/<a href="[^"]*yuedu-\d+\.html"/g) || []).length;
      const read_tz_def = /function\s+read_tz/.test(t);
      console.log(`[${name}] len=${t.length} info_dv3=${info} onclick_read_tz=${nonclick} a[href*=yuedu]=${hrefCh} hasReadTzFn=${read_tz_def}`);
      fs.writeFileSync(`test/.cache/7941-toc-${name}.html`, t);
    } catch (e) {
      console.log(`[${name}] ERR`, e.message);
    }
  }
})();
