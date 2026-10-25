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

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { resolveElectronExe, ensureElectronCached, cleanEnv, chooseCacheRoot } = require('../src/util/electron-exe');

const root = path.join(__dirname, '..');

// electron 副本必须放在**整条路径都是 ASCII** 的地方，否则 Chromium 秒退（0xC0000409）。
// 优先用程序目录下的 .electron-runtime（卸载删文件夹即可）；但它整条路径必须 ASCII，
// （本机项目目录就是 D:\\AI\\工作区\\novel-reader，用户也可能解压到桌面），不合格就换下一个候选：
// <用户主目录>\\.shuyuan-reader → 系统临时目录。
const cacheRoot = chooseCacheRoot([
  path.join(root, '.electron-runtime'),
  path.join(os.homedir(), '.shuyuan-reader'),
  path.join(os.tmpdir(), 'shuyuan-reader'),
]);

let resolved;
try {
  resolved = resolveElectronExe({ cacheRoot, forceCopy: true });
} catch (e) {
  // 绿色版分发包里的 electron 是「未展开」的 dist 目录，缓存里还没有副本时，
  // resolveElectronExe 会尝试复制；如果连 electron 包都找不到，这里再兜一次底，
  // 并把真正的错误原文交给用户，而不是吞掉变成 TypeError。
  try {
    const prepared = ensureElectronCached({ cacheRoot });
    resolved = { exe: prepared.exe, copied: prepared.copied, original: prepared.exe, cacheRoot: prepared.cacheRoot };
  } catch (e2) {
    console.error('✗ 无法定位 electron：' + String((e && e.message) || e));
    console.error('  ' + String((e2 && e2.message) || e2));
    console.error('  开发环境请先安装依赖：pnpm install');
    console.error('  绿色版分发包：确认 node_modules\\electron\\dist\\electron.exe 存在，或重新解压整个包。');
    process.exit(1);
  }
}

// 给 Electron 主进程用：它自己也按这个目录找缓存（见 electron/main.js）。
const env = cleanEnv();
if (resolved.cacheRoot) env.SHUYUAN_ELECTRON_CACHE = resolved.cacheRoot;
const extra = process.argv.slice(2);

const child = spawn(resolved.exe, [root, ...extra], {
  cwd: root,
  env,
  stdio: 'inherit',
  detachable: false,
});
child.on('exit', (code) => process.exit(code === null ? 0 : code));
child.on('error', (e) => {
  console.error('✗ 启动 Electron 失败：' + e.message);
  process.exit(1);
});
