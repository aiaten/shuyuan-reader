'use strict';
/**
 * 编译桌面启动器 `书源阅读器.exe`。
 *
 *   node tools/build-launcher.js            # 编译 + 写注册表 + 建桌面快捷方式
 *   node tools/build-launcher.js --no-link  # 只编译，不碰注册表和桌面
 *
 * 为什么用 .NET Framework 自带的 csc.exe：
 *   本机没有 dotnet SDK，也没有 Roslyn / VS BuildTools，只有
 *   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe（随系统自带）。
 *   它只认 C# 5 语法 —— 所以 tools/launcher/Program.cs 里不能出现字符串插值、
 *   表达式体成员、?.、nameof 这些 C# 6+ 特性。
 *
 * 产物：项目根下的 `书源阅读器.exe`（WinExe 子系统，双击不弹控制台）。
 *
 * ⚠ 编译后必须重置文件的「完整性级别」（integrity level）——见 §3b。
 *   本项目所在目录 D:\AI\工作区 曾被 DSH 沙箱打上 Low 完整性标签
 *   （`Mandatory Label\Low Mandatory Level` 的 (OI)(CI)(NW) ACE），
 *   于是目录里新生成的文件全部继承 Low IL。Windows 规定：
 *   **可执行文件的 IL 低于启动它的进程时，子进程会被降到该文件的 IL。**
 *   结果就是「双击 exe → 启动器运行在 Low IL → 它拉起的 electron 也在 Low IL
 *   → Chromium 的沙箱自检 (IsSandboxedProcess) 直接 STATUS_BREAKPOINT 崩溃」，
 *   表现为窗口一闪即退、退出码 -2147483645 (0x80000003)、electron 进程数为 0。
 *   把 exe 的 IL 提回 Medium 即可根治 —— 见 ensureMediumIntegrity()。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE_NAME = '书源阅读器.exe';

const SRC = path.join(__dirname, 'launcher', 'Program.cs');
const MANIFEST = path.join(__dirname, 'launcher', 'app.manifest');
const ICON = path.join(ROOT, 'build', 'app.ico');
const OUT = path.join(ROOT, EXE_NAME);

const REG_KEY = 'HKCU\\Software\\ShuyuanReader';

const noLink = process.argv.includes('--no-link');

function log(...a) { console.log(...a); }
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

/* ---------------- 1. 找 csc.exe ---------------- */

function findCsc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v3.5', 'csc.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/* ---------------- 2. 编译 ---------------- */

const csc = findCsc();
if (!csc) {
  fail('找不到 csc.exe（.NET Framework 编译器）。\n' +
       '  请确认系统装有 .NET Framework 4.x，或改装 .NET SDK 后改用 `dotnet build`。');
}
if (!fs.existsSync(SRC)) fail('源码不存在：' + SRC);
if (!fs.existsSync(MANIFEST)) fail('清单不存在：' + MANIFEST);
if (!fs.existsSync(ICON)) {
  fail('图标不存在：' + ICON + '\n' +
       '  先运行：python tools\\make-icon.py');
}

log('编译器 : ' + csc);
log('源码   : ' + SRC);
log('图标   : ' + ICON);
log('输出   : ' + OUT);
log('');

// 先删旧产物：csc 偶尔会因文件被占用而静默留着旧 exe
if (fs.existsSync(OUT)) {
  try { fs.unlinkSync(OUT); } catch (e) {
    fail('旧 exe 删不掉（可能正在运行）：' + OUT + '\n  ' + e.message);
  }
}

const args = [
  '/nologo',
  '/target:winexe',          // GUI 子系统：双击不弹黑框
  '/platform:anycpu',
  '/optimize+',
  '/utf8output',
  '/warn:4',
  '/win32icon:' + ICON,
  '/win32manifest:' + MANIFEST,
  // Microsoft.Win32.Registry 在 .NET Framework 下就在 System.dll 里
  '/reference:System.dll',
  '/out:' + OUT,
  SRC,
];

const r = spawnSync(csc, args, { encoding: 'utf8', windowsHide: true });

if (r.stdout) log(r.stdout.trim());
if (r.stderr) console.error(r.stderr.trim());

if (r.error) fail('无法运行 csc：' + r.error.message);
if (r.status !== 0) fail('编译失败（csc 退出码 ' + r.status + '）');
if (!fs.existsSync(OUT)) fail('csc 报告成功但没有生成 ' + OUT);

const size = fs.statSync(OUT).size;
log('');
log('✓ 编译成功  ' + OUT);
log('  ' + size + ' 字节（' + (size / 1024).toFixed(1) + ' KB）');

/* ---------------- 3. 提升完整性级别（关键，见文件头注释） ---------------- */

/**
 * 把文件的完整性级别设为 Medium。
 *
 * 用系统自带的 icacls，不引外部依赖。`/setintegritylevel Medium` 会覆盖
 * 从目录继承来的 Low 标签；随后再查一遍确认标签真的变成了 Medium
 * （只在设置成功时才相信结果）。
 *
 * 完整性级别对应的 SID 是固定值：
 *   Low = S-1-16-4096、Medium = S-1-16-8192、High = S-1-16-12288。
 * 查询时两种写法都认：非中文系统上显示名可能是 "Medium Mandatory Level"，
 * 中文系统上也可能显示成 "中等强制级别"，所以优先匹配 SID。
 *
 * @returns {{ok: boolean, detail: string}} ok=true 表示已确认标签为 Medium。
 */
function ensureMediumIntegrity(target) {
  if (!fs.existsSync(target)) return { ok: false, detail: '文件不存在：' + target };
  const r = spawnSync('icacls', [target, '/setintegritylevel', 'Medium'],
    { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    return { ok: false, detail: (r.stdout || '') + (r.stderr || '') };
  }
  const q = spawnSync('icacls', [target], { encoding: 'utf8', windowsHide: true });
  const text = (q.stdout || '') + (q.stderr || '');
  const isMedium = /S-1-16-8192|Medium Mandatory Level/.test(text);
  return { ok: isMedium, detail: text };
}

{
  const res = ensureMediumIntegrity(OUT);
  log('');
  if (res.ok) {
    log('✓ 完整性级别已设为 Medium（避免 Chromium 沙箱自检崩溃）');
  } else {
    log('⚠ 完整性级别设置失败' + (res.detail ? '：' + String(res.detail).trim().split('\n')[0] : ''));
    log('  若双击 exe 后窗口一闪即退（退出码 -2147483645），请手动执行：');
    log('    icacls "' + OUT + '" /setintegritylevel Medium');
  }
}

/* ---------------- 4. 注册表（兜底定位） ---------------- */

if (!noLink) {
  log('');
  const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
  log('写入注册表 HKCU\\Software\\ShuyuanReader …');
  const items = [
    ['Root', ROOT],
    ['Node', process.execPath],
  ];
  for (const [name, value] of items) {
    const rr = spawnSync('reg', ['add', REG_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
      { encoding: 'utf8', windowsHide: true });
    if (rr.status === 0) {
      log('  ✓ ' + name + ' = ' + value);
    } else {
      log('  ⚠ ' + name + ' 写入失败（不影响使用，exe 会自行按目录向上查找）');
    }
  }
}

/* ---------------- 5. 桌面快捷方式 ---------------- */

if (!noLink) {
  log('');
  const desktop = path.join(os.homedir(), 'Desktop');
  const lnk = path.join(desktop, '书源阅读器.lnk');

  if (!fs.existsSync(desktop)) {
    log('⚠ 桌面目录不存在，跳过快捷方式：' + desktop);
  } else {
    const ps = [
      '$ws = New-Object -ComObject WScript.Shell;',
      '$s = $ws.CreateShortcut(' + psQuote(lnk) + ');',
      '$s.TargetPath = ' + psQuote(OUT) + ';',
      '$s.WorkingDirectory = ' + psQuote(ROOT) + ';',
      '$s.IconLocation = ' + psQuote(OUT + ',0') + ';',
      '$s.Description = ' + psQuote('书源阅读器 — Legado 3.x 书源驱动的桌面小说阅读软件') + ';',
      '$s.Save();',
      'Write-Output "ok"',
    ].join(' ');

    const pr = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', windowsHide: true });

    if (pr.status === 0 && fs.existsSync(lnk)) {
      log('✓ 桌面快捷方式已创建：' + lnk);
    } else {
      log('⚠ 桌面快捷方式创建失败' + (pr.stderr ? '：' + pr.stderr.trim() : ''));
      log('  可手动创建：右键 ' + EXE_NAME + ' → 发送到 → 桌面快捷方式');
    }
  }

  // 顺带把 node 位置也记一份到项目里，方便排查
  try {
    const notes = {
      builtAt: new Date().toISOString(),
      launcher: OUT,
      projectRoot: ROOT,
      node: process.execPath,
      electronCache: path.join(os.homedir(), '.shuyuan-reader'),
    };
    fs.writeFileSync(path.join(ROOT, 'build', 'launcher-build.json'),
      JSON.stringify(notes, null, 2) + '\n', 'utf8');
  } catch { /* 忽略 */ }
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

log('');
log('完成。双击「' + EXE_NAME + '」即可启动；命令行加 --cli 可当 CLI 入口用。');
