'use strict';
/**
 * 打绿色版分发包（免安装 zip，给朋友直接双击测试）。
 *
 *   node tools/build-dist.js                 # 生成 dist/书源阅读器-<version>-win64.zip
 *   node tools/build-dist.js --keep          # 保留未压缩的 dist/书源阅读器-<version>/ 目录
 *   node tools/build-dist.js --no-electron  # 不带 electron 运行时（仅本机调试用，朋友机器跑不起来）
 *
 * 产物的「自包含」边界：
 *   · runtime\node\node.exe —— node.exe 取自开发者机器（约 93MB），朋友的机器上不需要装 Node
 *   · node_modules\          —— 从 pnpm 的 .pnpm 目录**展开成扁平 npm 布局**，
 *                               只含 src/ 与 electron/ 真正 require 到的第三方包（cheerio / iconv-lite 及其依赖）
 *                               不含 electron、不含 @types（那 270MB 只属于开发环境）
 *   · data\                  —— 只放「能离线跑起来」的最小初始数据（书源库/订阅源/空书架）
 *
 * 为什么 data 必须去敏：
 *   本机 data\ 里有 47MB 个人书架、已下载正文、阅读进度与下载历史。直接打包会把
 *   个人阅读记录发给朋友，所以这里只复制 data\sources\ 下的**书源**，书架/正文/
 *   浏览器历史/下载记录一概不带。
 *
 * 为什么 data 要重定向出安装目录：
 *   data 默认落在 <项目根>\data，含中文的安装路径本身没问题（只有 electron.exe 的
 *   路径不能含中文），但把个人数据写在程序目录里，朋友升级/重装就会丢。所以 zip
 *   里带一个纯 ASCII 的边车文件 `.shuyuan-root`，内容是 `%USERPROFILE%\ShuyuanReader`，
 *   启动器（tools/launcher/Program.cs 的 FindProjectRoot）读到它就把项目根指到用户
 *   目录，data 也就落在那里；卸载只要删那个文件夹。
 *
 * 为什么还要带 electron 的缓存：
 *   src/util/electron-exe.js 会在 <用户主目录>\.shuyuan-reader\electron-<版本>-x64\
 *   放一份纯 ASCII 路径的 electron.exe 副本。这个 cacheRoot 是**代码里写死的**，
 *   所以只要用户主目录是纯 ASCII 就能正常复制；若主目录含中文（Windows 允许），
 *   resolveElectronExe 会退到 %TEMP%。这一点在 README 里写明。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP_NAME = '书源阅读器';
const OUT_BASE = path.join(ROOT, 'dist');
const STAGE = path.join(OUT_BASE, APP_NAME + '-' + PKG.version);

const KEEP = process.argv.includes('--keep');
const WITH_ELECTRON = process.argv.includes('--with-electron');

// 分发包里 electron 以「未展开的 dist 目录 + version 文件」的形式保存，启动时由
// src/util/electron-exe.js 的 ensureElectronCached 复制到程序目录的 .electron-runtime\。
// 为什么不直接放展开后的 270MB：
//   1) 启动器/脚本只需要一个纯 ASCII 的可执行路径，副本最终都要复制一次，多放一份纯属浪费磁盘；
//   2) zip 用存储模式（不压缩），未展开的 dist 和展开的 dist 一样大，但少一次解压等待。
const DIST_ELECTRON = !process.argv.includes('--no-electron');

function log(...a) { console.log(...a); }
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

/* ---------------- 1. 目标 node.exe ---------------- */

function findNodeExe() {
  if (process.env.SHUYUAN_NODE && fs.existsSync(process.env.SHUYUAN_NODE)) return process.env.SHUYUAN_NODE;
  if (process.execPath && /node\.exe$/i.test(process.execPath)) return process.execPath;
  fail('找不到 node.exe：请用 node 运行本脚本，或设置 SHUYUAN_NODE');
}

/* ---------------- 2. 依赖闭包 ---------------- */

/** 从入口文件出发，列出 src/ electron/ 真正 require 到的「包名 → 包目录」 */
function collectPackages(entries) {
  const todo = entries.slice();
  const seenFiles = new Set();
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

  while (todo.length) {
    const f = todo.pop();
    if (seenFiles.has(f)) continue;
    seenFiles.add(f);
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      const req = m[1];
      if (!req.startsWith('.')) continue;
      let p;
      try { p = require.resolve(path.resolve(path.dirname(f), req)); } catch (_) { continue; }
      if (p.includes('node_modules')) continue;
      todo.push(p);
    }
  }

  const pkgs = new Map(); // name → real dir
  for (const f of seenFiles) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      const req = m[1];
      if (req.startsWith('.') || req.startsWith('node:')) continue;
      if (!WITH_ELECTRON && req === 'electron') continue;
      const top = req.startsWith('@') ? req.split('/').slice(0, 2).join('/') : req.split('/')[0];
      if (top === 'electron' && !WITH_ELECTRON) continue;
      let p;
      try { p = require.resolve(req, { paths: [path.dirname(f)] }); } catch (_) { continue; }
      const i = p.lastIndexOf('node_modules' + path.sep);
      const dir = i >= 0 ? p.slice(0, i + 'node_modules'.length + 1) + top : null;
      if (!dir || !fs.existsSync(path.join(dir, 'package.json'))) continue;
      // 同一个包名可能被不同依赖方解析到不同版本（pnpm 下 entities 有 4.2.0/6.0.0/7.0.1 三份）。
      // 扁平布局只能留一份，而「先到先得」会留下错的：htmlparser2@10 需要 entities@7（才能
      // require('entities/decode')），先登记的 entities@4.2.0 会把它顶掉，运行时报
      // `ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './decode'`。
      // 所以同一名字出现时，比谁的 package.json 里 name 所指的版本号更高 —— 高版本是
      // 更上层依赖要用的那个，且向下兼容性通常更好。
      const prev = pkgs.get(top);
      if (!prev || cmpVersion(versionOf(dir), versionOf(prev)) > 0) pkgs.set(top, dir);
    }
  }
  return pkgs;
}

/** 递归展开一个包的 dependencies / optionalDependencies / peerDependencies（扁平化到 destination） */
function expandDependencies(pkgs) {
  const queue = Array.from(pkgs.keys()).map((name) => ({ name, dir: pkgs.get(name) }));
  const done = new Set();

  while (queue.length) {
    const { name, dir } = queue.shift();
    const key = name + '@' + dir;
    if (done.has(key)) continue;
    done.add(key);
    // 高版本优先（见 collectPackages）
    const cur = pkgs.get(name);
    if (!cur || cmpVersion(versionOf(dir), versionOf(cur)) >= 0) pkgs.set(name, dir);
    else continue;

    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (_) { continue; }
    const wanted = Object.assign({}, pkg.dependencies, pkg.optionalDependencies);
    for (const dep of Object.keys(wanted)) {
      if (dep === 'electron' && !WITH_ELECTRON) continue;
      let p;
      try { p = require.resolve(dep, { paths: [dir] }); } catch (_) {
        // optional 依赖装不上是正常的（例如 encoding 的 iconv-lite 分支）
        if (pkg.optionalDependencies && pkg.optionalDependencies[dep]) continue;
        log('  ! 依赖解析失败（跳过）：' + dep + ' ← ' + name);
        continue;
      }
      const i = p.lastIndexOf('node_modules' + path.sep);
      const depDir = i >= 0 ? p.slice(0, i + 'node_modules'.length + 1) + dep : null;
      if (!depDir || !fs.existsSync(path.join(depDir, 'package.json'))) continue;
      const prev = pkgs.get(dep);
      if (!prev) {
        queue.push({ name: dep, dir: depDir });
      } else if (cmpVersion(versionOf(depDir), versionOf(prev)) > 0 && !done.has(dep)) {
        // 见 collectPackages 里的注释：同名多版本时扁平布局只留最高版本。
        queue.push({ name: dep, dir: depDir });
      }
    }
  }
  return pkgs;
}

/* ---------------- 2a. 版本比较 ---------------- */

function versionOf(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch (_) { return '0.0.0'; }
}

/** 粗略比较 semver（够用就行：只比数字段，忽略预发布标签） */
function cmpVersion(a, b) {
  const pa = String(a).split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/* ---------------- 2b. 包文件清单（按 npm 的 files 字段） ---------------- */

/**
 * 一个包该分发哪些文件：package.json 的 files 字段 + 总是包含的约定文件。
 *
 * 为什么必须按 files 而不是「复制整包再删点东西」：
 *   pnpm 的 .pnpm 目录里留着一堆没被 files 白名单收进去的开发产物
 *   （entities@4.2.0 的顶层 decode.js / esm/ / generated/ 等），而它的 exports
 *   只暴露 lib/index.js 和 lib/decode.js。第一次打包后运行直接报
 *   `ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './decode' is not defined`——
 *   因为顶层 decode.js 被一起复制了过去，同时 lib/decode.js 被后写的同名顶层文件盖掉。
 *   照 files 白名单来，既不会漏、也不会多。
 */
function packageFiles(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const out = new Set(['package.json', 'LICENSE', 'LICENCE', 'license', 'licence', 'NOTICE']);
  const files = pkg.files;
  if (!Array.isArray(files) || files.length === 0) return null; // null = 整包
  for (const raw of files) {
    const entry = String(raw || '').trim().replace(/^\.\//, '');
    if (!entry) continue;
    out.add(entry.replace(/\/+$/, ''));
    out.add(entry);
  }
  return out;
}

/** 把「whitelist（可含目录前缀）」展开成确定的文件集合 */
function expandWhitelist(dir, whitelist) {
  const picked = new Set();
  // files 里的条目是**类 glob**：'lib/**/*'、'lib'、'dist/*.js'、'*.json' 都合法。
  // 第一版当成纯前缀匹配，结果 domutils 的 files=['lib/**/*'] 被解析成字面目录 lib/**/*，
  // 只复制到 package.json 和 LICENSE，装好后报 `Cannot find module ...domutils\lib\index.js`。
  // 类 glob 白名单：'lib/**/*' / 'lib/*.js' / 'dist' / '*.json'
  // ** 匹配任意多级（包括零级），* 只匹配一级里的任意字符。
  // 教训：前两版用正则替换造 glob，占位符被后续的正则转义吃掉，'lib/**/*' 被编译成
  // ^lib/.*/[^/]*$，匹配不到 lib/index.js —— 打出来的包缺 domutils\lib\*.js，
  // 运行时报 `Cannot find module ...domutils\lib\index.js`。现在改成手写匹配，不再经过正则。
  // 类 glob 白名单：'lib/**/*' / 'lib/*.js' / 'dist' / '*.json'
  // 语义：'lib' 命中 lib 本身及 lib/ 下的全部内容；'lib/**/*' 里 ** 匹配零到多级目录，
  // 因此 lib/index.js 与 lib/esm/index.js 都命中；'*' 只在一级目录内通配。
  // 教训：前两版用正则替换拼 glob，占位符被后续正则转义吃掉，'lib/**/*' 被编译成
  // ^lib/.*/[^/]*$，漏掉 lib/index.js —— 打出来的包缺 domutils\lib\*.js，
  // 运行时报 `Cannot find module ...domutils\lib\index.js`。现在改成按段手写匹配，不走正则。
  const toRegExp = (w) => {
    const pat = String(w).replace(/^\.\//, '').replace(/\/+$/, '');
    const ps = pat.split('/');
    const hit = (rel) => {
      if (rel === pat) return true;
      if (rel.indexOf(pat + '/') === 0) return true;
      if (ps.indexOf('**') < 0) {
        // 无 ** 的普通 pattern：按段逐个比，* 只在一段内部通配
        const rs = rel.split('/');
        if (ps.length !== rs.length) return false;
        for (let i = 0; i < ps.length; i++) {
          if (ps[i] === rs[i]) continue;
          if (ps[i].indexOf('*') < 0) return false;
          if (!segMatch(ps[i], rs[i])) return false;
        }
        return true;
      }
      // 含 **：前缀固定段 → ** 吞掉零到多级 → 剩余 pattern 段去匹配 rel 的末尾
      const starAt = ps.indexOf('**');
      const rs = rel.split('/');
      const prefix = ps.slice(0, starAt);
      const tail = ps.slice(starAt + 1);
      if (rs.length < prefix.length + tail.length) return false;
      for (let i = 0; i < prefix.length; i++) {
        if (prefix[i] === rs[i]) continue;
        if (prefix[i].indexOf('*') < 0) return false;
        if (!segMatch(prefix[i], rs[i])) return false;
      }
      for (let i = 0; i < tail.length; i++) {
        const seg = rs[rs.length - tail.length + i];
        if (tail[i] === seg) continue;
        if (tail[i].indexOf('*') < 0) return false;
        if (!segMatch(tail[i], seg)) return false;
      }
      return true;
    };
    return { test: hit };
  };

  /** 单段通配：把 'a*b' 编译成 '^a[\s\S]*b$' */
  function segMatch(pattern, str) {
    const parts = pattern.split('*').map((x) => x.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
    return new RegExp('^' + parts.join('[\\s\\S]*') + '$').test(str);
  }
  const regs = Array.from(whitelist).map(toRegExp);
  const walk = (abs, rel) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), rel ? rel + '/' + name : name);
      return;
    }
    if (regs.some((re) => re.test(rel))) {
      picked.add(rel);
      if (process.env.SHUYUAN_DEBUG_PICK) console.log("      pick " + rel);
    }
  };
  walk(dir, '');
  return picked;
}
function copyPackage(src, dst) {
  const whitelist = packageFiles(src);
  if (!whitelist) {
    copyTree(src, dst);
    return;
  }
  const picked = expandWhitelist(src, whitelist);
  let n = 0;
  for (const rel of picked) {
    const from = path.join(src, rel);
    const to = path.join(dst, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    n++;
  }
  log('        ' + path.basename(src) + '：' + n + ' 个文件（按 files 白名单）');
}

/* ---------------- 3. 复制工具 ---------------- */

/** 复制目录，可过滤 */
function copyTree(src, dst, filter) {
  // 开发机上 data\ 里会有 launcher.log 之类的运行残留，分发包只带「干净」的书源数据，
  // 免得朋友第一次打开就看到别人家的日志。
  if (filter && !filter(src, dst, path.basename(src))) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === '.git' || name === '.pnpm') continue;
      const s = path.join(src, name);
      const d = path.join(dst, name);
      copyTree(s, d, filter);
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

/** 包内不需要分发的东西（体积 / 平台相关的构建产物） */
function skipInPackage(p, d, base) {
  if (base === 'node_modules' || base === '.pnpm') return false;
  const rel = p.slice(d.length - base.length);
  // ⚠ 只按 package.json 的 files 字段挑，绝不按后缀/目录名猜：
  //   第一版按「去掉 .md/.map/.ts」过滤，结果把 entities 的 lib/decode.js 之外的东西删坏，
  //   导致 ERR_PACKAGE_PATH_NOT_EXPORTED。依赖包里的每个文件都可能是 exports 的落点。
  return true;
}

/* ---------------- 4. 主流程 ---------------- */

function main() {
  log('== 打包 ' + APP_NAME + ' v' + PKG.version + ' ==');

  // 4a. 清空暂存目录
  fs.mkdirSync(OUT_BASE, { recursive: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  // 4b. 源码
  log('[1/5] 复制源码 src/ electron/ scripts/ tools/launcher …');
  for (const dir of ['src', 'electron', 'scripts']) {
    copyTree(path.join(ROOT, dir), path.join(STAGE, dir));
  }
  copyTree(path.join(ROOT, 'tools', 'launcher'), path.join(STAGE, 'tools', 'launcher'));
  for (const f of ['package.json', 'README.md']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(STAGE, f));
  }


  // 4c. 启动器 exe
  log('[2/5] 复制启动器 exe …');
  const exe = path.join(ROOT, APP_NAME + '.exe');
  if (!fs.existsSync(exe)) fail('缺少启动器 ' + exe + '，先运行：node tools/build-launcher.js --no-link');
  fs.copyFileSync(exe, path.join(STAGE, APP_NAME + '.exe'));

  // 4d. runtime\node\node.exe
  log('[3/5] 复制 node.exe …');
  const nodeExe = findNodeExe();
  fs.mkdirSync(path.join(STAGE, 'runtime', 'node'), { recursive: true });
  fs.copyFileSync(nodeExe, path.join(STAGE, 'runtime', 'node', 'node.exe'));
  log('      ' + nodeExe + ' → runtime\\node\\node.exe（' + (fs.statSync(nodeExe).size / 1048576).toFixed(0) + 'MB）');

  // 4e. 依赖
  log('[4/5] 展开依赖（扁平 npm 布局）…');
  const entries = [
    path.join(ROOT, 'src', 'app.js'),
    path.join(ROOT, 'electron', 'main.js'),
    path.join(ROOT, 'electron', 'preload.js'),
  ];
  const pkgs = expandDependencies(collectPackages(entries));
  const nm = path.join(STAGE, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  for (const [name, dir] of pkgs) {
    const target = path.join(nm, name);
    copyPackage(dir, target);
    log('      + ' + name);
  }

  // 4f. data：只带书源，不带个人书架
  log('[5/7] 准备初始 data（去敏）…');
  const dataDir = path.join(STAGE, 'data');
  fs.mkdirSync(path.join(dataDir, 'sources'), { recursive: true });
  const srcDir = path.join(ROOT, 'data', 'sources');
  for (const f of ['sources.json', 'rss.json']) {
    const p = path.join(srcDir, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dataDir, 'sources', f));
  }
  fs.writeFileSync(path.join(dataDir, 'shelf.json'), JSON.stringify({ version: 1, books: [], layout: 'list', sort: 'addedAt' }, null, 2), 'utf8');

  // 4g. electron 运行时（未展开）：node_modules\electron\{package.json,version,dist\}
  if (DIST_ELECTRON) {
    log('[6/7] 复制 electron 运行时 …');
    const elDir = path.dirname(require.resolve('electron'));
    const elPkg = JSON.parse(fs.readFileSync(path.join(elDir, 'package.json'), 'utf8'));
    const elDst = path.join(nm, 'electron');
    fs.mkdirSync(elDst, { recursive: true });
    fs.writeFileSync(path.join(elDst, 'package.json'), JSON.stringify({
      name: 'electron', version: elPkg.version, main: 'index.js',
    }, null, 2), 'utf8');
    // 绿色版里 index.js 找不到 exe 时直接读我们写好的 path.txt，不再 require dist/electron.exe 的笨办法
    fs.writeFileSync(path.join(elDst, 'index.js'), [
      "'use strict';",
      "// 绿色版：electron 的 exe 放在同目录的 dist\\ 下（由 tools/build-dist.js 写入）",
      "const path = require('path');",
      "module.exports = path.join(__dirname, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');",
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(elDst, 'version'), elPkg.version, 'utf8');
    copyTree(path.join(elDir, 'dist'), path.join(elDst, 'dist'));
    log('      electron ' + elPkg.version + ' → node_modules\\electron\\dist');
  } else {
    log('      （--no-electron：不带 electron 运行时，需要本机 node_modules 里有 electron）');
  }

  // 边车文件：`.shuyuan-root` 里只有一行 `<项目根>|<数据目录>`。
  //
  // 关键约束：**项目根必须还是 exe 所在目录**。启动器（FindProjectRoot）要求项目根下同时有
  // package.json 和 scripts/start.js，否则不算项目根、会退回 exe 目录 —— 边车等于白写。
  // 所以这里把「根」留空（空 = 沿用 exe 所在目录），只把**数据目录**指到用户主目录：
  //   · 程序目录被删 / 被更新解压覆盖时，书架还在；
  //   · 程序被解压到 Program Files 这类只读位置也能跑。
  // electron 副本的位置不用管：start.js 用 chooseCacheRoot() 自动挑第一个纯 ASCII 的候选
  // （程序目录 → <用户主目录>\.shuyuan-reader → %TEMP%），解压到中文路径也会自己躲开。
  const userData = '%USERPROFILE%\\ShuyuanReader\\data';
  fs.writeFileSync(path.join(STAGE, '.shuyuan-root'), '|' + userData, 'utf8');

  // 4h. 使用说明
  fs.writeFileSync(path.join(STAGE, '使用说明.txt'), readme(), 'utf8');

  log('');
  log('暂存目录：' + STAGE);
  log('打包…');
  const zip = path.join(OUT_BASE, APP_NAME + '-' + PKG.version + '-win64.zip');
  fs.rmSync(zip, { force: true });
  /**
   * 打真 zip（存储模式，不压缩）。
   *
   * 以前用 `tar.exe -a -c -f xxx.zip`：Windows 自带的 bsdtar **只有解压 zip 的能力，
   * 不支持写 zip**，于是 -a 静默退化成写 tar —— 产物扩展名是 .zip、内容其实是 tar，
   * 资源管理器双击打不开（朋友拿到会以为文件坏了）。改用 Python 的 zipfile，
   * 和 make-icon.py 一样只依赖打包机上的 python，ZIP_STORED 存储模式几秒就能出包。
   */
  const py = `
import os, sys, zipfile
stage, out_dir, base = sys.argv[1], sys.argv[2], sys.argv[3]
out = os.path.join(out_dir, base + '-win64.zip')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED, allowZip64=True) as z:
    for root, dirs, files in os.walk(stage):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, os.path.dirname(stage))
            z.write(full, rel)
print('zip bytes', os.path.getsize(out))
`;
  const pyFile = path.join(os.tmpdir(), 'shuyuan-build-zip.py');
  fs.writeFileSync(pyFile, py, 'utf8');
  execFileSync('python', [pyFile, STAGE, OUT_BASE, path.basename(STAGE)], { stdio: 'inherit' });
  fs.rmSync(pyFile, { force: true });

  if (!KEEP) fs.rmSync(STAGE, { recursive: true, force: true });
  log('');
  log('✓ 完成：' + zip + '（' + (fs.statSync(zip).size / 1048576).toFixed(1) + 'MB）');
}

function readme() {
  return [
    '书源阅读器 v' + PKG.version + '（Windows 64 位，免安装）',
    '',
    '【怎么用】',
    '  1. 把整个文件夹解压到一个固定位置（路径里有没有中文都行）；',
    '  2. 双击  书源阅读器.exe  即可启动，不需要装 Node.js，也不用联网装依赖；',
    '  3. 书架、书源、下载的正文都存在 %USERPROFILE%\\ShuyuanReader\\data，',
    '     不在程序目录里 —— 程序整个删掉/重新解压，数据都还在。',
    '',
    '【里面有什么】',
    '  runtime\\node\\node.exe   随包便携版 Node.js',
    '  node_modules\\           cheerio / iconv-lite 及其依赖（书源规则引擎用）',
    '  node_modules\\electron\\   未展开的 Electron 33 运行时（第一次启动自动展开）',
    '  data\\sources\\           预置的在线书源（首次启动自动灌进用户目录，共 18 个）',
    '  .shuyuan-root           数据目录指向用户目录的标记文件，别删',
    '',
    '【Electron 运行时是怎么放的】',
    '  解压目录里没有 .electron-runtime，第一次启动才会释放一份（约 270MB）：',
    '    · 程序目录路径全是英文数字 → 释放到  <程序目录>\\.electron-runtime\\',
    '    · 否则（桌面、中文文件夹）→ 释放到  %USERPROFILE%\\.shuyuan-reader\\',
    '  两个位置都可以随时删掉，下次启动自动重建。',
    '',
    '【启动失败怎么办】',
    '  弹窗显示退出码时，先看日志最后几行：',
    '    %USERPROFILE%\\ShuyuanReader\\data\\launcher.log',
    '  · 报 Cannot find module / ERR_PACKAGE_PATH_NOT_EXPORTED → 包没解压完整，重新解压整个 zip；',
    '  · 报 找不到 electron 包 → 缺 node_modules\\electron，同样重新解压；',
    '  · 有 [err] 行写着 network service crashed / GPU 相关 → 先更新显卡驱动，或把程序目录加入杀毒白名单；',
    '  · 没有任何输出、只是退出码非 0 → 多半是杀毒拦截，把程序目录加入白名单；',
    '  · 首次启动要写约 270MB，磁盘空间不足也会失败。',
    '  还不行就在终端里跑下面两行，把窗口里的报错发回来：',
    '    cd /d <程序目录>',
    '    runtime\\node\\node.exe scripts\\start.js',
    '',
    '【注意】',
    '  · 只针对 Windows 64 位；',
    '  · 程序目录里的东西别单独挪动，尤其 .shuyuan-root 和 exe 要在同一层。',
    '',
  ].join('\r\n');
}

main();
