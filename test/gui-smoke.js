'use strict';
/**
 * Electron GUI 冒烟测试：
 *   node test/gui-smoke.js
 *
 * 启动真实的 electron/main.js（含 preload + 渲染页），在渲染进程里跑断言，
 * 结果由 test/gui-smoke-main.js 写入临时 JSON 文件，本脚本轮询读取并汇报。
 *
 * 两个 Windows 特有的坑（本机实测）：
 *  1. `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成纯 Node —— 必须从子进程环境里删掉。
 *  2. Electron 是 GUI 子系统程序，父进程拿不到它的 stdout —— 结果走文件。
 *  3. electron.exe 自身路径含非 ASCII（本项目在 `D:\AI\工作区\`）会导致 Chromium 启动崩溃
 *     （0x80000003）—— 用 src/util/electron-exe.js 换到纯 ASCII 路径上。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { resolveElectronExe, cleanEnv } = require('../src/util/electron-exe');

const OUT = path.join(os.tmpdir(), `shuyuan-gui-smoke-${process.pid}.json`);
try {
  fs.unlinkSync(OUT);
} catch (_) {
  /* 不存在也无所谓 */
}

let resolved;
try {
  resolved = resolveElectronExe();
} catch (e) {
  console.error('✗ 无法定位 electron：' + e.message);
  process.exit(1);
}
console.log(`electron: ${resolved.exe}`);
if (resolved.copied) console.log(`  （原路径含非 ASCII，已复制一份到纯 ASCII 路径：${resolved.original}）`);

const child = spawn(resolved.exe, [path.join(__dirname, 'gui-smoke-main.js')], {
  cwd: path.join(__dirname, '..'),
  env: cleanEnv({
    SHUYUAN_SMOKE_OUT: OUT,
    // 关键：给这次冒烟一个**独立的 Electron 用户目录**。
    // main.js 里有 app.requestSingleInstanceLock()，而单实例锁是按 userData
    // 目录判定的。若沿用默认 profile，上一个还没退干净的实例会持有锁，
    // 新实例在 whenReady 之前就 app.quit()，结果「退出且没有结果文件」——
    // 表现成随机超时/失败（本机实测：连跑 4~5 次必现）。
    // 每个进程用 pid 隔开，互不干扰，也不会和用户手动开的软件抢锁。
    ELECTRON_USER_DATA_DIR: path.join(os.tmpdir(), `shuyuan-smoke-userdata-${process.pid}`),
  }),
  stdio: 'ignore',
});

const MAX_MS = 120000;
const t0 = Date.now();
let done = false;

function finish(ok, payload) {
  if (done) return;
  done = true;
  try {
    child.kill();
  } catch (_) {
    /* ignore */
  }
  console.log('\n' + '─'.repeat(64));
  if (payload && payload.lines) {
    console.log(payload.lines.join('\n'));
  } else if (payload && payload.reason) {
    console.log('原因: ' + payload.reason);
    if (payload.seed) console.log('seed: ' + JSON.stringify(payload.seed));
    if (payload.consoleErrors && payload.consoleErrors.length) {
      console.log('渲染控制台错误: ');
      for (const ce of payload.consoleErrors.slice(0, 10)) console.log('  ' + ce);
    }
  }
  console.log('─'.repeat(64));
  console.log(ok ? '✓ GUI 冒烟测试通过' : '✗ GUI 冒烟测试失败');
  process.exit(ok ? 0 : 1);
}

const timer = setInterval(() => {
  if (done) return;
  if (fs.existsSync(OUT)) {
    let payload = null;
    try {
      payload = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    } catch (_) {
      return; // 还在写，下轮再读
    }
    clearInterval(timer);
    finish(!!payload.ok, payload);
    return;
  }
  if (Date.now() - t0 > MAX_MS) {
    clearInterval(timer);
    finish(false, { reason: `超时（${MAX_MS / 1000}s）：Electron 没有写出结果文件 ${OUT}` });
  }
}, 400);

child.on('exit', (code) => {
  if (done) return;
  setTimeout(() => {
    if (done) return;
    if (fs.existsSync(OUT)) {
      let payload = null;
      try {
        payload = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      } catch (_) {
        /* ignore */
      }
      if (payload) {
        clearInterval(timer);
        finish(!!payload.ok, payload);
        return;
      }
    }
    clearInterval(timer);
    const hex = code === null ? 'null' : `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
    finish(false, { reason: `Electron 退出（code=${code} / ${hex}）且没有结果文件` });
  }, 500);
});

child.on('error', (e) => {
  clearInterval(timer);
  finish(false, { reason: 'spawn 失败: ' + e.message });
});
