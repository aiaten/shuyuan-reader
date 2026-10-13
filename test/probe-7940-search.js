// 追踪 7940 uu书库 search 各步骤
const { SourceEngine, resolveUrlRule } = require('../src/engine/source');
const { JsRuntime, Prefetcher } = require('../src/rules/jsrt');
const { CookieJar } = require('../src/net/cookiejar');
const R = require('../src/rules/rule');
const fs = require('fs');
const path = require('path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '_recon', 'src_7940.json'), 'utf8'));
const src = Array.isArray(raw) ? raw[0] : raw;

(async () => {
  const engine = new SourceEngine(src, {});
  const keyword = '诡秘之主';
  const vars = { key: keyword, searchKey: encodeURIComponent(keyword), page: '1', searchPage: '1', baseUrl: engine.baseUrl };

  // 手动跑一遍 resolveUrlRule（非 _runWithPrefetch 内），看 JS 报什么错
  const jar = new CookieJar();
  const pref = new Prefetcher({ jar, getSync: () => '' });
  const rt = new JsRuntime({ jar, source: src, prefetcher: pref, logger: console });
  const evalJs = (code, res) => rt.runRaw(code, { ...vars, result: res, cookie: jar, source: src, baseUrl: engine.baseUrl });

  const { urlRaw, options, jsErrors } = resolveUrlRule(String(src.searchUrl), evalJs, vars);
  console.log('urlRaw =', urlRaw);
  console.log('options =', JSON.stringify(options));
  console.log('jsErrors =', JSON.stringify(jsErrors, null, 1));
  console.log('misses =', JSON.stringify(pref.takeMisses(), null, 1));
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
