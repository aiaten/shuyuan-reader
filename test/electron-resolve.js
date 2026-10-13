'use strict';
// 验证 src/util/electron-exe.js 能给出可用的 ASCII 路径，并跑通最小 Electron 应用。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveElectronExe, cleanEnv } = require('../src/util/electron-exe');

console.log('ELECTRON_RUN_AS_NODE =', process.env.ELECTRON_RUN_AS_NODE || '(未设置)');

const t0 = Date.now();
const r = resolveElectronExe({ verbose: true });
console.log(`解析耗时 ${Date.now() - t0}ms`);
console.log('original =', r.original);
console.log('exe      =', r.exe);
console.log('copied   =', r.copied);
console.log('');

const app = path.join(__dirname, 'electron-minimal.js');
const out = path.join(os.tmpdir(), `el-resolved-${Date.now()}.json`);
const t1 = Date.now();
const res = spawnSync(r.exe, [app], {
  cwd: path.join(__dirname, '..'),
  env: cleanEnv({ SMOKE_OUT: out }),
  timeout: 30000,
  windowsHide: true,
  stdio: 'ignore',
});
const ms = Date.now() - t1;
let payload = null;
if (fs.existsSync(out)) {
  payload = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
}
const code = res.status === null ? `signal=${res.signal}` : `0x${(res.status >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
console.log(`启动 exit=${code}  ${ms}ms`);
console.log(JSON.stringify(payload, null, 2));
process.exit(payload && payload.ok ? 0 : 1);
