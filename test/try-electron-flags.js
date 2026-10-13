'use strict';
// 用不同命令行开关试跑 Electron，找出本机能启动的组合。
// 在 pwsh 里跑：& node test/try-electron-flags.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const app = path.join(root, 'test', 'electron-minimal.js');

const combos = [
  ['(无开关)', []],
  ['--no-sandbox', ['--no-sandbox']],
  ['--disable-gpu', ['--disable-gpu']],
  ['--no-sandbox --disable-gpu', ['--no-sandbox', '--disable-gpu']],
  ['--disable-gpu --disable-software-rasterizer', ['--disable-gpu', '--disable-software-rasterizer']],
  ['--in-process-gpu --no-sandbox', ['--in-process-gpu', '--no-sandbox']],
  ['--disable-gpu-sandbox', ['--disable-gpu-sandbox']],
  ['--single-process --no-sandbox', ['--single-process', '--no-sandbox']],
  ['--no-sandbox --disable-gpu --disable-dev-shm-usage', ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']],
  ['--disable-features=RendererCodeIntegrity', ['--disable-features=RendererCodeIntegrity']],
  ['--no-zygote --no-sandbox', ['--no-zygote', '--no-sandbox']],
];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

console.log('electron.exe =', exe, fs.existsSync(exe) ? '(存在)' : '(缺失)');
console.log('app        =', app);
console.log('');

for (const [label, flags] of combos) {
  const out = path.join(os.tmpdir(), `el-flag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  const e = { ...env, SMOKE_OUT: out };
  const t0 = Date.now();
  const r = spawnSync(exe, [...flags, app], {
    cwd: root,
    env: e,
    timeout: 25000,
    windowsHide: true,
    stdio: 'ignore',
  });
  const ms = Date.now() - t0;
  let payload = null;
  if (fs.existsSync(out)) {
    try {
      payload = JSON.parse(fs.readFileSync(out, 'utf8'));
    } catch (_) {
      payload = { stage: 'unparsable' };
    }
    try {
      fs.unlinkSync(out);
    } catch (_) {
      /* ignore */
    }
  }
  const code = r.status === null ? `signal=${r.signal}` : String(r.status);
  let verdict;
  if (payload && payload.stage === 'window' && payload.ok) {
    verdict = `✓ 窗口正常 (electron ${payload.versions.electron} / chrome ${payload.versions.chrome})`;
  } else if (payload && payload.stage) {
    verdict = `△ 走到 ${payload.stage}：${payload.error || JSON.stringify(payload).slice(0, 120)}`;
  } else {
    verdict = '✗ 无输出文件';
  }
  const hex = r.status === null ? '' : ` (0x${(r.status >>> 0).toString(16).toUpperCase()})`;
  console.log(`${label.padEnd(42)} exit=${code}${hex}  ${String(ms).padStart(6)}ms  ${verdict}`);
}
