// 检查 7940 searchUrl JS 的时间依赖（重跑是否产生不同 body）
const { JsRuntime, Prefetcher } = require('../src/rules/jsrt');
const { CookieJar } = require('../src/net/cookiejar');
const { resolveUrlRule } = require('../src/engine/source');
const fs = require('fs');
const path = require('path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '_recon', 'src_7940.json'), 'utf8'));
const src = Array.isArray(raw) ? raw[0] : raw;
const jar = new CookieJar();
const pref = new Prefetcher();
const rt = new JsRuntime({ jar, source: src, prefetcher: pref });

// 造一个假的 signJs 响应 + 00JT 响应，让 JS 走到最后
pref.cache.set('GET\u0001https://www.rrssk.com/00JT.html\u0001\u0001\u0001', {
  status: 200,
  text: '<input name="_t" value="abcdef0123456789"> <a href="?action=signJs&v=17-20261011">x</a>',
  url: 'https://www.rrssk.com/00JT.html',
});
pref.cache.set('GET\u0001https://www.rrssk.com/?action=signJs&v=17-20261011\u0001\u0001\u0001', {
  status: 200, text: 'ok', url: 'https://www.rrssk.com/?action=signJs&v=17-20261011',
});

const vars = { key: '诡秘之主', page: '1', baseUrl: 'https://www.uushuk.com' };
for (let i = 0; i < 3; i++) {
  const { urlRaw, options } = resolveUrlRule(String(src.searchUrl), (code, res) => rt.runRaw(code, { ...vars, result: res, cookie: jar, source: src, baseUrl: vars.baseUrl }), vars);
  console.log(`第 ${i + 1} 次: url=${urlRaw}  body=${options.body}`);
}
console.log('00JT 请求命中缓存，URL 只出现一次（预取 key 是按 method+url 的）');
