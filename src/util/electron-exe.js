'use strict';
/**
 * Electron 可执行文件定位器。
 *
 * 背景（实测结论）：Windows 上若 `electron.exe` **自身的路径含非 ASCII 字符**
 * （例如本项目位于 `D:\AI\工作区\novel-reader`），Chromium 会在启动瞬间崩溃，
 * 退出码 0x80000003（STATUS_BREAKPOINT）或 0xC0000005（ACCESS_VIOLATION），
 * 且不产生任何输出。`cwd` 与「被执行的 app 脚本路径」含中文则不受影响。
 *
 * 因此这里把 electron 的 dist 目录复制（或建立目录联接）到一个纯 ASCII 位置，
 * 再返回那份 exe 的路径。同一版本只复制一次。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const NON_ASCII = /[^\x00-\x7F]/;

/** 路径是否全为 ASCII */
function isAsciiPath(p) {
  return !NON_ASCII.test(String(p));
}

/** 缓存根目录：优先用户主目录（本机为纯 ASCII），退化到临时目录 */
function defaultCacheRoot() {
  const candidates = [path.join(os.homedir(), '.shuyuan-reader'), path.join(os.tmpdir(), 'shuyuan-reader')];
  for (const c of candidates) {
    if (!isAsciiPath(c)) continue;
    try {
      fs.mkdirSync(c, { recursive: true });
      return c;
    } catch (_) {
      /* 试下一个 */
    }
  }
  return null;
}

/** 把目录整体复制（Node 16.7+ 的 cpSync） */
function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

/**
 * 返回一个可用的、路径为纯 ASCII 的 electron.exe。
 *
 * @param {object} [opts]
 * @param {string} [opts.electronPath] 显式指定 electron 包路径或 exe 路径
 * @param {string} [opts.cacheRoot]    复制缓存目录
 * @param {boolean} [opts.verbose]     打印诊断
 * @returns {{exe:string, copied:boolean, original:string, cacheRoot:string|null}}
 */
function resolveElectronExe(opts = {}) {
  const verbose = !!opts.verbose;
  const say = (m) => verbose && console.error('[electron-exe] ' + m);

  // require('electron') 在普通 Node 下返回 exe 路径字符串
  let original = opts.electronPath;
  if (!original) {
    try {
      original = require('electron');
    } catch (e) {
      throw new Error('找不到 electron 包，请先安装依赖：' + e.message);
    }
  }
  if (typeof original !== 'string') {
    throw new Error('require("electron") 没有返回路径字符串（是否设置了 ELECTRON_RUN_AS_NODE？）');
  }

  // 可能给的是包目录
  if (fs.existsSync(path.join(original, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(original, 'package.json'), 'utf8'));
    if (pkg && pkg.main) original = path.join(original, pkg.main);
    else original = path.join(original, 'dist', 'electron.exe');
  }
  original = path.resolve(original);

  if (!fs.existsSync(original)) {
    throw new Error('electron 可执行文件不存在：' + original);
  }

  if (isAsciiPath(original)) {
    say('原路径已是纯 ASCII，直接使用');
    return { exe: original, copied: false, original, cacheRoot: null };
  }

  const cacheRoot = opts.cacheRoot || defaultCacheRoot();
  if (!cacheRoot) throw new Error('无法找到纯 ASCII 的缓存目录来安放 electron.exe');

  // 版本号做子目录名，便于多版本共存
  const srcDist = path.dirname(original);
  let version = 'unknown';
  try {
    version = fs.readFileSync(path.join(srcDist, 'version'), 'utf8').trim() || 'unknown';
  } catch (_) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(srcDist, '..', 'package.json'), 'utf8'));
      version = pkg.version || 'unknown';
    } catch (_) {
      /* 保持 unknown */
    }
  }

  const destDist = path.join(cacheRoot, `electron-${version}-${process.arch}`);
  const destExe = path.join(destDist, path.basename(original));
  const marker = path.join(destDist, '.copied-from');

  let copied = false;
  const markerOk =
    fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === original && fs.existsSync(destExe);

  if (!markerOk) {
    say(`复制 ${srcDist} → ${destDist}`);
    copyDir(srcDist, destDist);
    fs.writeFileSync(marker, original, 'utf8');
    copied = true;
  } else {
    say(`复用缓存 ${destExe}`);
  }

  return { exe: destExe, copied, original, cacheRoot };
}

/** 子进程用的干净环境：清掉会让 Electron 退化成纯 Node 的变量 */
function cleanEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

module.exports = { resolveElectronExe, isAsciiPath, cleanEnv, defaultCacheRoot };
