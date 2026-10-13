'use strict';
/** 测试同一搜索页在不同 UA 下是否返回不同模板（.txt-list 是否存在） */
const http = require('../src/net/http');
const { CookieJar } = require('../src/net/cookiejar');

const KEY = '诡秘之主';
const UAS = {
  '默认(我们的Android UA)': undefined,
  '桌面 Chrome': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'iPhone Safari': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  'Android Chrome': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  '空 UA': '',
};

const cheerio = require('cheerio');

(async () => {
  for (const [label, ua] of Object.entries(UAS)) {
    try {
      const jar = new CookieJar();
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (ua !== undefined) headers['User-Agent'] = ua;
      const r = await http.request('https://www.zuizhong.net/search.html', {
        method: 'POST', body: `s=${KEY}`, headers, jar,
      });
      const $ = cheerio.load(r.text);
      console.log(`${label.padEnd(24)} len=${String(r.body.length).padStart(6)} .txt-list=${$('.txt-list').length} a.list=${$('a.list').length} li=${$('li').length} 含关键词=${r.text.includes(KEY)}`);
    } catch (e) {
      console.log(`${label.padEnd(24)} ERROR ${e.message}`);
    }
  }
})();
