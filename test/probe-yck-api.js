'use strict';
/** 验证 yck2026.fun 的 JSON 下载端点与列表分页/搜索参数 */
const http = require('../src/net/http');

(async () => {
  // 1. JSON 下载端点
  for (const id of [7941, 7940]) {
    const r = await http.get(`https://www.yck2026.fun/yuedu/shuyuan/json/id/${id}.json`);
    console.log(`[json ${id}] status=${r.status} ct=${r.headers['content-type']} len=${r.text.length}`);
    console.log('   ' + r.text.replace(/\s+/g, ' ').slice(0, 160));
    try {
      const j = JSON.parse(r.text);
      const arr = Array.isArray(j) ? j : [j];
      console.log(`   → 解析成功，${arr.length} 条，首条 name="${arr[0].bookSourceName}" url="${arr[0].bookSourceUrl}"`);
    } catch (e) {
      console.log('   → JSON 解析失败: ' + e.message);
    }
  }

  // 2. 列表分页
  const p2 = await http.get('https://www.yck2026.fun/yuedu/shuyuan/index.html?page=2');
  console.log(`\n[列表 page=2] status=${p2.status} len=${p2.text.length}`);

  // 3. 搜索
  const s = await http.get('https://www.yck2026.fun/yuedu/shuyuan/index.html?keys=' + encodeURIComponent('番茄'));
  console.log(`[搜索 keys=番茄] status=${s.status} len=${s.text.length} 含content/id=${/content\/id\//.test(s.text)}`);
  const m = s.text.match(/content\/id\/(\d+)\.html">([^<]+)</g);
  console.log('  命中: ' + (m ? m.slice(0, 5).join('  ') : '(无)'));

  // 4. 排序
  const d = await http.get('https://www.yck2026.fun/yuedu/shuyuan/index.html?order1=down&order2=1');
  console.log(`[按下载量排序] status=${d.status} len=${d.text.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
