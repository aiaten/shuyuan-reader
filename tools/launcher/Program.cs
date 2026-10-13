using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace ShuyuanReader
{
    /// <summary>
    /// 书源阅读器桌面启动器（C# 5 语法，兼容 .NET Framework 4.0 自带的 csc.exe）。
    ///
    /// 编译为 WinExe 子系统 —— 双击时不会先弹一个黑色控制台窗口。
    ///
    /// 它做四件事：
    ///   1. 定位项目根目录（命令行 --root → 边车文件 → exe 目录向上查找 → 注册表）
    ///   2. 定位一个可用的 node.exe（环境变量 → 随包 runtime → PATH → 注册表 → 常见位置）
    ///   3. 用干净环境拉起 scripts\start.js，并把它的输出落到 data\launcher.log
    ///   4. 失败时弹窗说清楚原因（WinExe 没有控制台，不弹窗就什么都看不到）
    ///
    /// 为什么不直接拉起 electron.exe：
    ///   electron.exe 自身路径含非 ASCII 字符时 Chromium 会瞬间崩溃（0x80000003 /
    ///   0xC0000005，零输出）。scripts/start.js 已封装「拷到纯 ASCII 目录再启动」
    ///   这套逻辑，这里复用它，不重复实现。
    ///
    /// 为什么重定向子进程输出：
    ///   保留父进程存活期间管道不关闭；同时也留一份日志便于排查。
    /// </summary>
    internal static class Program
    {
        private const string AppTitle = "书源阅读器";
        private const string ProjectMarker = "package.json";
        private const string ProjectName = "shuyuan-reader";
        private const string SidecarName = ".shuyuan-root";
        private const string RegPath = @"Software\ShuyuanReader";
        private const int LogMaxBytes = 2 * 1024 * 1024;

        private static readonly object LogLock = new object();
        private static string _logFile;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(uint dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AllocConsole();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FreeConsole();

        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "MessageBoxW")]
        private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

        [STAThread]
        private static int Main(string[] rawArgs)
        {
            List<string> args = new List<string>(rawArgs);

            bool cliMode = false;
            for (int i = 0; i < args.Count; i++)
            {
                if (args[i] == "--cli") { cliMode = true; args.RemoveAt(i); break; }
            }

            string root = null;
            try
            {
                string rootVia;
                root = FindProjectRoot(out rootVia);
                string nodeVia;
                string node = FindNode(root, out nodeVia);

                if (cliMode)
                {
                    return RunCli(root, node, args);
                }

                Log(root, "[launcher] " + AppTitle + " 启动");
                Log(root, "[launcher] 项目根 = " + root + "（来源：" + rootVia + "）");
                Log(root, "[launcher] node   = " + node + "（来源：" + nodeVia + "）");
                return RunGui(root, node);
            }
            catch (Exception ex)
            {
                if (root != null) Log(root, "[launcher] 错误: " + ex.Message);
                Fail(ex.Message);
                return 1;
            }
        }

        /* ==================== 项目根定位 ==================== */

        private static string FindProjectRoot(out string via)
        {
            via = null;
            string exePath = Process.GetCurrentProcess().MainModule.FileName;
            string exeDir = Path.GetDirectoryName(exePath);

            // 1) 命令行 --root <dir>
            string[] argv = Environment.GetCommandLineArgs();
            for (int i = 1; i < argv.Length - 1; i++)
            {
                if (argv[i] == "--root" && IsProjectRoot(argv[i + 1]))
                {
                    via = "命令行 --root";
                    return Path.GetFullPath(argv[i + 1]);
                }
            }

            // 2) 边车文件 .shuyuan-root（允许把 exe 复制到桌面等任意位置使用）
            foreach (string dir in CandidateDirs(exeDir))
            {
                string sidecar = Path.Combine(dir, SidecarName);
                if (File.Exists(sidecar))
                {
                    string line = FirstNonEmptyLine(sidecar);
                    if (!string.IsNullOrEmpty(line))
                    {
                        string target = Path.IsPathRooted(line) ? line : Path.Combine(dir, line);
                        if (IsProjectRoot(target))
                        {
                            via = "边车文件 " + SidecarName;
                            return Path.GetFullPath(target);
                        }
                    }
                }
            }

            // 3) exe 自身目录 / 逐级向上
            foreach (string dir in CandidateDirs(exeDir))
            {
                if (IsProjectRoot(dir))
                {
                    via = "exe 所在目录";
                    return Path.GetFullPath(dir);
                }
            }

            // 4) 注册表（由构建脚本写入）
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RegPath))
                {
                    if (k != null)
                    {
                        string r = k.GetValue("Root") as string;
                        if (IsProjectRoot(r))
                        {
                            via = @"注册表 HKCU\" + RegPath;
                            return Path.GetFullPath(r);
                        }
                    }
                }
            }
            catch
            {
                // 注册表不可读时静默跳过
            }

            throw new Exception(
                "找不到项目目录。\r\n\r\n" +
                "期望在下列位置之一发现 package.json（name = " + ProjectName + "）：\r\n" +
                "  · exe 所在目录或其上 4 级父目录\r\n" +
                "  · exe 同目录下的 " + SidecarName + " 文件（内容为项目绝对路径）\r\n" +
                "  · 注册表 HKCU\\" + RegPath + " 的 Root 值\r\n\r\n" +
                "当前 exe 位置：\r\n" + exePath + "\r\n\r\n" +
                "也可以命令行指定：\"" + exePath + "\" --root \"D:\\path\\to\\novel-reader\"");
        }

        /// <summary>exe 同目录 → 向上 4 级 → 当前工作目录</summary>
        private static IEnumerable<string> CandidateDirs(string exeDir)
        {
            string d = exeDir;
            for (int i = 0; i < 5 && !string.IsNullOrEmpty(d); i++)
            {
                yield return d;
                DirectoryInfo p = Directory.GetParent(d);
                if (p == null) break;
                d = p.FullName;
            }
            string cwd = Environment.CurrentDirectory;
            if (!string.IsNullOrEmpty(cwd) && !string.Equals(cwd, exeDir, StringComparison.OrdinalIgnoreCase))
            {
                yield return cwd;
            }
        }

        /// <summary>该目录是否为本项目根：package.json 含 name=shuyuan-reader 且含 scripts/start.js</summary>
        private static bool IsProjectRoot(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return false;
            try
            {
                string pkg = Path.Combine(dir, ProjectMarker);
                if (!File.Exists(pkg)) return false;
                string text = File.ReadAllText(pkg, Encoding.UTF8);
                // 宽松判定（认 name 或认启动脚本），避免 package.json 被人重新格式化后误判
                return text.IndexOf(ProjectName, StringComparison.OrdinalIgnoreCase) >= 0
                    && text.IndexOf("scripts/start.js", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch
            {
                return false;
            }
        }

        private static string FirstNonEmptyLine(string file)
        {
            try
            {
                string[] lines = File.ReadAllLines(file);
                foreach (string line in lines)
                {
                    string t = line.Trim();
                    if (t.Length > 0 && !t.StartsWith("#")) return t;
                }
            }
            catch { }
            return null;
        }

        /* ==================== node 定位 ==================== */

        private static string FindNode(string root, out string via)
        {
            via = null;

            // 1) 环境变量显式覆盖
            string env = Environment.GetEnvironmentVariable("SHUYUAN_NODE");
            if (IsExe(env)) { via = "环境变量 SHUYUAN_NODE"; return Path.GetFullPath(env); }

            // 2) 随包 runtime（把 node.exe 放进 runtime\node\ 即可做成绿色版）
            string exeDir = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
            string[] baseDirs = new string[] { exeDir, root };
            foreach (string baseDir in baseDirs)
            {
                if (string.IsNullOrEmpty(baseDir)) continue;
                string[] rels = new string[]
                {
                    @"runtime\node\node.exe",
                    @"runtime\node\bin\node.exe",
                    @"runtime\node.exe"
                };
                foreach (string rel in rels)
                {
                    string p = Path.Combine(baseDir, rel);
                    if (IsExe(p)) { via = "随包 runtime"; return Path.GetFullPath(p); }
                }
            }

            // 3) PATH
            string fromPath = SearchOnPath("node.exe");
            if (fromPath != null) { via = "PATH"; return fromPath; }

            // 4) 注册表（构建脚本写入）
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RegPath))
                {
                    if (k != null)
                    {
                        string r = k.GetValue("Node") as string;
                        if (IsExe(r)) { via = @"注册表 HKCU\" + RegPath; return Path.GetFullPath(r); }
                    }
                }
            }
            catch { }

            // 5) 常见安装位置
            string[] guesses = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"nodejs\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
            };
            foreach (string g in guesses)
            {
                if (IsExe(g)) { via = "常见安装位置"; return Path.GetFullPath(g); }
            }

            throw new Exception(
                "找不到 node.exe。\r\n\r\n" +
                "可选解决办法（任选其一）：\r\n" +
                "  · 安装 Node.js 并确保 node 在 PATH 中\r\n" +
                "  · 把 node.exe 放到  项目根\\runtime\\node\\  下（绿色版）\r\n" +
                "  · 设置环境变量 SHUYUAN_NODE 指向 node.exe\r\n" +
                "  · 重新运行构建脚本以写入注册表：\r\n" +
                "      node tools\\build-launcher.js");
        }

        private static bool IsExe(string p)
        {
            try { return !string.IsNullOrEmpty(p) && File.Exists(p); }
            catch { return false; }
        }

        private static string SearchOnPath(string fileName)
        {
            string pathVar = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(pathVar)) return null;
            foreach (string dir in pathVar.Split(';'))
            {
                if (string.IsNullOrEmpty(dir)) continue;
                try
                {
                    string full = Path.Combine(dir.Trim(), fileName);
                    if (File.Exists(full)) return Path.GetFullPath(full);
                }
                catch { }
            }
            return null;
        }

        /* ==================== 启动 ==================== */

        /// <summary>子进程基础设置：清掉会让 Electron 退化成纯 Node 的变量</summary>
        private static ProcessStartInfo BasePsi(string root, string node, bool touchEnv)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false;
            if (touchEnv)
            {
                // 注意：访问 EnvironmentVariables 会让 .NET 重建整个环境块。
                // 排障开关 SHUYUAN_LAUNCH_MODE=raw 时不碰它，用于区分是不是这一步造成差异。
                try { psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE"); }
                catch { }
            }
            return psi;
        }

        private static int RunGui(string root, string node)
        {
            bool debug = Environment.GetEnvironmentVariable("SHUYUAN_DEBUG") == "1";

            string mode = Environment.GetEnvironmentVariable("SHUYUAN_LAUNCH_MODE");
            if (mode == null) mode = "";

            ProcessStartInfo psi = BasePsi(root, node, mode != "raw");
            psi.Arguments = Quote(Path.Combine(root, @"scripts\start.js"));
            psi.CreateNoWindow = (!debug) && (mode != "window");

            bool redirect = mode != "noredir";
            if (redirect)
            {
                // 重定向并异步排空，避免管道写满后子进程阻塞
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
            }

            Process p = new Process();
            p.StartInfo = psi;
            if (redirect)
            {
                p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) Log(root, "[out] " + e.Data);
                };
                p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) Log(root, "[err] " + e.Data);
                };
            }

            p.Start();
            if (redirect)
            {
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
            }

            p.WaitForExit();
            int code = p.ExitCode;

            if (code != 0)
            {
                Log(root, "[launcher] 子进程退出码 " + code);
                Fail("启动失败（退出码 " + code + "）。\r\n\r\n" +
                     "详细信息见日志：\r\n" + _logFile + "\r\n\r\n" +
                     "也可以在终端里手动运行查看完整报错：\r\n" +
                     "  cd /d " + root + "\r\n" +
                     "  \"" + node + "\" scripts\\start.js");
            }
            return code;
        }

        private static int RunCli(string root, string node, List<string> args)
        {
            // WinExe 没有控制台：优先附加到调用者的终端，否则新建一个
            bool allocated = AttachConsole(0xFFFFFFFF);
            if (!allocated) allocated = AllocConsole();

            ProcessStartInfo psi = BasePsi(root, node, true);
            StringBuilder sb = new StringBuilder();
            sb.Append(Quote(Path.Combine(root, @"src\cli.js")));
            foreach (string a in args) sb.Append(' ').Append(Quote(a));
            psi.Arguments = sb.ToString();
            psi.CreateNoWindow = false;

            int code = 1;
            try
            {
                Process p = Process.Start(psi);
                p.WaitForExit();
                code = p.ExitCode;
            }
            finally
            {
                Console.WriteLine();
                Console.Write("按回车键关闭…");
                try { Console.ReadLine(); } catch { }
                if (allocated) FreeConsole();
            }
            return code;
        }

        private static string Quote(string s)
        {
            string t = s == null ? "" : s;
            return "\"" + t.TrimEnd('\\') + "\"";
        }

        /* ==================== 日志与报错 ==================== */

        private static void Log(string root, string line)
        {
            try
            {
                if (_logFile == null)
                {
                    string dir = Path.Combine(root, "data");
                    Directory.CreateDirectory(dir);
                    _logFile = Path.Combine(dir, "launcher.log");
                    if (File.Exists(_logFile) && new FileInfo(_logFile).Length > LogMaxBytes)
                    {
                        File.Delete(_logFile);
                    }
                }
                lock (LogLock)
                {
                    File.AppendAllText(_logFile,
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + "\r\n",
                        new UTF8Encoding(false));
                }
            }
            catch
            {
                // 日志失败不影响主流程
            }
        }

        private static void Fail(string message)
        {
            MessageBoxW(IntPtr.Zero, message, AppTitle + " — 启动失败", 0x00000010 /* MB_ICONERROR */);
        }
    }
}
