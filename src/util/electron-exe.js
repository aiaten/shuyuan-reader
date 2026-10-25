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

/**
 * 缓存根目录：优先用 `SHUYUAN_ELECTRON_CACHE`，否则退到用户主目录。
 *
 * 两条硬约束（真机实测）：
 *   1) electron.exe 的**完整路径**里只要有一个非 ASCII 字符，Chromium 就在启动瞬间退出，
 *      退出码 0xC0000409（-1073740791），日志 / 弹窗 / stderr 全空。所以候选目录必须整条路径 ASCII
 *      —— `D:\\AI\\工作区\\...` 这类项目目录默认不可用，散包必须靠 SHUYUAN_ELECTRON_CACHE 指过去。
 *   2) 启动器（C#）给 Node 传的是中文工作目录，自己另起子进程时没法只换可执行文件路径，
 *      所以这里也不能退到「当前工作目录」——那一定是项目根，必然含中文。
 */
function defaultCacheRoot() {
  const env = process.env.SHUYUAN_ELECTRON_CACHE;
  if (env) {
    try {
      fs.mkdirSync(env, { recursive: true });
      // 不校验 env 是否 ASCII：散包把它指向程序目录（用户放哪都有可能），
      // 而且用户主目录本身可能带中文，校验只会让唯一的显式配置被静默丢掉。
      return env;
    } catch (_) {
      /* 建不出来就退回下面的默认位置 */
    }
  }
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
/** 目录是否为空（不存在也算空） */
function isEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch (_) {
    return true;
  }
}

/**
 * 从候选目录里挑第一个**整条路径都是 ASCII** 的当缓存根。
 *
 * 为什么要这一步：散包把缓存指向程序目录（`.electron-runtime`），可用户可能把整个包
 * 解压到桌面、`下载` 这类含中文的路径下 —— 那时 Chromium 会以 0xC0000409 秒退。
 * 所以让调用方准备好一串候选（程序目录 → 用户主目录 → 系统临时目录），在这里筛。
 */
function chooseCacheRoot(candidates) {
  for (const c of candidates || []) {
    if (!c) continue;
    if (!isAsciiPath(c)) continue;
    try {
      fs.mkdirSync(c, { recursive: true });
      return path.resolve(c);
    } catch (_) {
      /* 试下一个 */
    }
  }
  return null;
}

/**
 * 把目录整体复制（Node 16.7+ 的 cpSync）。
 *
 * 旧副本的删除要容忍失败：上一次 Electron 还没退干净时文件是锁着的，
 * 直接 rmSync 会抛 EPERM 让整个启动挂掉。删不掉就换个新目录名（带时间戳），
 * 反正缓存目录只增不改，下次启动会挑最新的那份用。
 */
function copyDir(src, dst) {
  if (!isEmptyDir(dst) && !fs.existsSync(path.join(dst, '.copied-from'))) {
    dst = dst + '-build-' + Date.now();
  }
  fs.rmSync(dst, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  return dst;
}

/**
 * 在 cacheRoot 下找一份现成可用的 electron 副本。
 * 判据：目录名以 `electron-<version>-<arch>` 开头、里面有 electron.exe、
 * 且 `.copied-from` 记的就是当前来源（来源变了说明是另一处装的 electron，不能混用）。
 */
function pickExisting(cacheRoot, version, original) {
  const prefix = `electron-${version}-${process.arch}`;
  let names;
  try {
    names = fs.readdirSync(cacheRoot);
  } catch (_) {
    return null;
  }
  const hits = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const dir = path.join(cacheRoot, name);
    const exe = path.join(dir, path.basename(original));
    if (!isAsciiPath(exe) || !fs.existsSync(exe)) continue;
    let from = '';
    try {
      from = fs.readFileSync(path.join(dir, '.copied-from'), 'utf8').trim();
    } catch (_) {
      continue;
    }
    if (from !== original) continue;
    hits.push(dir);
  }
  if (!hits.length) return null;
  // 名字里带 -build-<时间戳> 的是后建的，取最新的那份
  hits.sort();
  return hits[hits.length - 1];
}

/**
 * 把 electron 运行时复制到 cacheRoot 下的版本子目录，并返回目标 exe 路径。
 *
 * 单独抽出来是为了两个场景共用：
 *   1) resolveElectronExe —— 路径含非 ASCII 时自动复制（Chromium 会崩）；
 *   2) ensureElectronCached —— 「准备运行环境」(npm run prepare-runtime)，
 *      打包前先把副本准备好，这样分发包可以只带约 100MB 的 electron 压缩包，
 *      而不是展开后的 270MB。
 *
 * @param {string} original electron.exe 的原始路径
 * @param {string} cacheRoot 纯 ASCII 的缓存根目录
 * @returns {{exe:string, destDist:string, copied:boolean}}
 */
function copyElectronInto(original, cacheRoot) {
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

  // 优先复用已有的可用副本：缓存里可能有多份（复制中断留下的半份、
  // 或上次删除失败时换名建的新目录），挑那份文件齐、且标记来源一致的。
  const preferred = pickExisting(cacheRoot, version, original);
  if (preferred) return { exe: path.join(preferred, path.basename(original)), destDist: preferred, copied: false };

  const destDist = path.join(cacheRoot, `electron-${version}-${process.arch}`);
  const destExe = path.join(destDist, path.basename(original));
  const marker = path.join(destDist, '.copied-from');

  let copied = false;
  let markerOk = false;
  try {
    // 标记里记的是复制来源；来源没变且路径仍是纯 ASCII 才算可复用。
    // 光比来源不够：缓存目录本身可能从 ASCII 位置挪到了含中文的盘上。
    markerOk =
      fs.existsSync(marker) &&
      fs.readFileSync(marker, 'utf8').trim() === original &&
      isAsciiPath(destExe) &&
      fs.existsSync(destExe);
  } catch (_) {
    markerOk = false;
  }

  let finalDist = destDist;
  if (!markerOk) {
    finalDist = copyDir(srcDist, destDist);
    fs.writeFileSync(path.join(finalDist, '.copied-from'), original, 'utf8');
    copied = true;
  }
  return { exe: path.join(finalDist, path.basename(original)), destDist: finalDist, copied };
}

/**
 * 把 electron 运行时复制进 cacheRoot（默认取 SHUYUAN_ELECTRON_CACHE）。
 * 打包脚本用它，让分发包里的 .electron-runtime 提前备好。
 */
function ensureElectronCached(opts = {}) {
  const root = opts.cacheRoot || defaultCacheRoot();
  if (!root) throw new Error('无法找到纯 ASCII 的缓存目录来安放 electron.exe');
  const electronPath = opts.electronPath || require('electron');
  const r = copyElectronInto(path.resolve(electronPath), root);
  return { ...r, cacheRoot: root };
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

  // 绿色版分发包要求「一律复制到程序目录」，即使原路径本身已经是纯 ASCII：
  // 打包目录可能被解压到桌面等非 ASCII 路径下（Chromium 会崩），统一复制副本更稳。
  if (!opts.forceCopy && isAsciiPath(original)) {
    // 源和目标同一个文件时不能复制，直接返回
    const cr0 = opts.cacheRoot;
    if (!cr0 || !path.resolve(original).startsWith(path.resolve(cr0) + path.sep)) {
      say('原路径已是纯 ASCII，直接使用 ' + original);
      return { exe: original, copied: false, original, cacheRoot: null };
    }
  }

  const cacheRoot = opts.cacheRoot || defaultCacheRoot();
  if (!cacheRoot) throw new Error('无法找到纯 ASCII 的缓存目录来安放 electron.exe');

  say(`复制 ${path.dirname(original)} → ${cacheRoot}`);
  const r = copyElectronInto(original, cacheRoot);
  if (r.copied) say('已复制到 ' + r.destDist);
  else say('复用已有副本 ' + r.exe);
  return { exe: r.exe, copied: r.copied, original, cacheRoot };
}

/** 子进程用的干净环境：清掉会让 Electron 退化成纯 Node 的变量 */
function cleanEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

module.exports = { resolveElectronExe, ensureElectronCached, copyElectronInto, isAsciiPath, cleanEnv, defaultCacheRoot, chooseCacheRoot };
