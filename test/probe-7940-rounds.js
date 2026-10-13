// 逐轮追踪 7940 search 的预取-重跑
const { SourceEngine } = require('../src/engine/source');
const fs = require('fs');
const path = require('path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '_recon', 'src_7940.json'), 'utf8'));
const src = Array.isArray(raw) ? raw[0] : raw;

(async () => {
  const engine = new SourceEngine(src, {});
  const origFetch = engine._fetch.bind(engine);
  let n = 0;
  engine._fetch = async (url, options) => {
    n++;
    const r = await origFetch(url, options);
    console.log(`  [fetch#${n}] ${options && options.method || 'GET'} ${url} → status=${r && r.status} len=${r && r.text ? r.text.length : 0}`);
    return r;
  };
  const list = await engine.search('诡秘之主');
  console.log('结果条数 =', list.length);
  console.log('诊断 =', JSON.stringify(engine.lastDiagnostics, null, 1));
  console.log('请求数 =', engine.requestCount);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
