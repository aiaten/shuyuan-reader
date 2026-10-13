// 直接看 7036 起点 / 7908 神文 的搜索请求原始返回，判定是「网络层失败」还是「规则层失败」
const fs = require('fs');
const path = require('path');
const H = require('../src/net/http');

const RECON = 'D:/AI/工作区/_recon';

function load(id) {
  const raw = JSON.parse(fs.readFileSync(path.join(RECON, `src_${id}.json`), 'utf8'));
  return Array.isArray(raw) ? raw[0] : raw;
}

(async () => {
  for (const id of ['7036', '7908']) {
    const s = load(id);
    console.log('='.repeat(70));
    console.log(`[${id}] ${s.bookSourceName}  searchUrl=`);
    console.log('  ' + String(s.searchUrl).slice(0, 400));
    console.log(`  header=${JSON.stringify(s.header)}`);
    let url = String(s.searchUrl);
    // 去掉 <js> 预处理块，只留 URL 部分做裸连通性测试
    url = url.replace(/<js>[\s\S]*?<\/js>/g, '').trim();
    const comma = url.indexOf(',{');
    let optObj = null;
    if (comma > 0) {
      url = url.slice(0, comma);
      try { optObj = JSON.parse(url.slice(comma)); } catch (e) { /* ignore */ }
    }
    const finalUrl = url.replace(/\{\{\s*key\s*\}\}/g, encodeURIComponent('诡秘之主')).replace(/\{\{\s*page\s*\}\}/g, '1');
    console.log(`  → 实测 URL: ${finalUrl}`);
    try {
      const res = await H.request(finalUrl, {
        method: 'GET',
        headers: { ...(s.header ? JSON.parse(s.header) : {}), Referer: s.bookSourceUrl },
        timeout: 25000,
      });
      console.log(`  ← status=${res.status} len=${res.body.length} charset=${res.charset} finalUrl=${res.url}`);
      console.log('  --- 前 300 字 ---');
      console.log('  ' + String(res.text).replace(/\s+/g, ' ').slice(0, 300));
    } catch (e) {
      console.log(`  ← 失败: ${e.message} code=${e.code || ''}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
