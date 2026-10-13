'use strict';
/**
 * GUI 启动器：`pnpm start` / `npm start` 走这里。
 *
 * 为什么不直接用 `electron .`：
 *   本机实测（Windows）electron.exe **自身路径含非 ASCII 字符**时（本项目位于
 *   `D:\AI\工作区\novel-reader`，pnpm 的真实文件在 `node_modules\.pnpm\...`），
 *   Chromium 一启动就崩溃，退出码 0x80000003（STATUS_BREAKPOINT）或
 *   0xC0000005（ACCESS_VIOLATION），且没有任何输出。
 *   另外本会话环境预设了 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 退化成纯 Node。
 * 所以这里统一通过 src/util/electron-exe.js 解析出一个纯 ASCII 的 exe，并清理环境。
 */

const path = require('path');
const { spawn } = require('child_process');

const { resolveElectronExe, cleanEnv } = require('../src/util/electron-exe');

let resolved;
try {
  resolved = resolveElectronExe();
} catch (e) {
  console.error('✗ 无法定位 electron：' + e.message);
  console.error('  请先安装依赖：pnpm install');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const extra = process.argv.slice(2);

const child = spawn(resolved.exe, [root, ...extra], {
  cwd: root,
  env: cleanEnv(),
  stdio: 'inherit',
  detachable: false,
});

child.on('exit', (code) => process.exit(code === null ? 0 : code));
child.on('error', (e) => {
  console.error('✗ 启动 Electron 失败：' + e.message);
  process.exit(1);
});
