'use strict';
// 定位 Electron 启动失败到底是「哪一段路径含中文」导致的。
// 四组：exe 路径 / app 脚本路径 / cwd 各自独立切换 ASCII 与中文。
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ASCII_DIR = 'C:\\Windows\\Temp\\el-matrix';
const CN_DIR = 'D:\\AI\\工作区\\novel-reader';

// 保证 ASCII 侧素材齐全
fs.mkdirSync(ASCII_DIR, { recursive: true });
if (!fs.existsSync(path.join(ASCII_DIR, 'dist', 'electron.exe'))) {
  fs.cpSync(path.join(CN_DIR, 'node_modules', 'electron', 'dist'), path.join(ASCII_DIR, 'dist'), {
    recursive: true,
  });
}
fs.copyFileSync(path.join(CN_DIR, 'test', 'electron-minimal.js'), path.join(ASCII_DIR, 'app.js'));

const EXE_ASCII = path.join(ASCII_DIR, 'dist', 'electron.exe');
const EXE_CN = path.join(CN_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const APP_ASCII = path.join(ASCII_DIR, 'app.js');
const APP_CN = path.join(CN_DIR, 'test', 'electron-minimal.js');

const cases = [
  ['exe=ASCII  app=ASCII  cwd=ASCII', EXE_ASCII, APP_ASCII, ASCII_DIR],
  ['exe=ASCII  app=ASCII  cwd=中文 ', EXE_ASCII, APP_ASCII, CN_DIR],
  ['exe=ASCII  app=中文   cwd=ASCII', EXE_ASCII, APP_CN, ASCII_DIR],
  ['exe=中文   app=ASCII  cwd=ASCII', EXE_CN, APP_ASCII, ASCII_DIR],
  ['exe=中文   app=中文   cwd=中文 ', EXE_CN, APP_CN, CN_DIR],
];

const baseEnv = { ...process.env };
delete baseEnv.ELECTRON_RUN_AS_NODE;

for (const [label, exe, app, cwd] of cases) {
  const out = path.join(os.tmpdir(), `el-m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  const r = spawnSync(exe, [app], {
    cwd,
    env: { ...baseEnv, SMOKE_OUT: out },
    timeout: 25000,
    windowsHide: true,
    stdio: 'ignore',
  });
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
  const ok = payload && payload.stage === 'window' && payload.ok;
  const code = r.status === null ? `signal=${r.signal}` : `0x${(r.status >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  console.log(`${label}  exit=${code.padEnd(12)} ${ok ? '✓ 窗口正常' : '✗ ' + (payload ? payload.stage + ' ' + (payload.error || '') : '无输出')}`);
}
