'use strict';
/* 抓正文页并落盘：node test/fetch-chapter.js [url] [out] */
const fs = require('fs');
const path = require('path');
const http = require('../src/net/http.js');

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const url = process.argv[2] || 'https://www.zuizhong.net/book/60434/yuedu-15920759.html';
const out = process.argv[3] || path.join(__dirname, '.cache', '7941-chapter.html');

(async () => {
  const res = await http.request(url, { headers: { 'User-Agent': DESKTOP_UA }, timeout: 30000, charset: 'utf-8' });
  console.log('status=', res.status, 'len=', res.body.length, 'charset=', res.charset);
  fs.writeFileSync(out, res.text, 'utf8');
  console.log('落盘:', out, res.text.length);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
