/* 检查 zuizhong.net 详情页/目录页的 .info_dv3 个数与章节链接形态 */
const http = require('../src/net/http.js');

const urls = [
  'https://www.zuizhong.net/book/60434/',
  'https://www.zuizhong.net/book/60434/1.html',
  'https://www.zuizhong.net/book/60434/2.html',
];

(async () => {
  for (const u of urls) {
    try {
      const r = await http.get(u);
      const t = r.text;
      const c = (t.match(/info_dv3/g) || []).length;
      const ulA = (t.match(/<ul[^>]*class="[^"]*yanqing_list/g) || []).length;
      const hrefA = (t.match(/<a href="[^"]*yuedu-\d+\.html"/g) || []).length;
      const onclk = (t.match(/onclick="read_tz\(/g) || []).length;
      console.log(`${u}\n  status=${r.status} len=${t.length} info_dv3=${c} ul.yanqing_list=${ulA} a[href*=yuedu]=${hrefA} onclick_read_tz=${onclk}`);
      console.log('  finalUrl =', r.url);
    } catch (e) {
      console.log(u, 'ERR', e.message);
    }
  }
})();
