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
        /// <summary>程序根目录（Fail 在 CLI 模式下只写日志不弹框）。</summary>
        private static string _root;
        private static bool _runCli;
        /// <summary>边车文件里指定的数据目录（可空）：注入 SHUYUAN_DATA 给 Node 用。</summary>
        private static string _dataDir;

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
                if (args[i] == "--cli") { cliMode = true; _runCli = true; args.RemoveAt(i); break; }
            }

            string root = null;
            try
            {
                string rootVia;
                root = FindProjectRoot(out rootVia, out _dataDir);
                string nodeVia;
                string node = FindNode(root, out nodeVia);

                if (cliMode)
                {
                    // CLI 也认边车文件里的数据目录（否则 --cli 看到的和 GUI 不是同一份书架）。
                    // 透传交给子进程的 argv：启动器可能是在另一个 shell 里被单独调用，
                    // 只设 Process 级环境变量时 SHUYUAN_DATA 传不到 node（实测会被吞掉）。
                    if (!string.IsNullOrEmpty(_dataDir) && !HasDataArg(args))
                    {
                        args.Add("--data");
                        args.Add(_dataDir);
                    }
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

        /// <summary>命令行里是否已经带了 --data / --data=。</summary>
        private static bool HasDataArg(List<string> args)
        {
            for (int i = 0; i < args.Count; i++)
            {
                if (args[i] == "--data" || args[i].StartsWith("--data=")) return true;
            }
            return false;
        }

        /* ==================== 项目根定位 ==================== */

        private static string FindProjectRoot(out string via, out string dataDir)
        {
            via = null;
            dataDir = null;
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
                        // 允许写 %USERPROFILE%\ShuyuanReader 这类环境变量引用（绿色版分发包就是这么写的，
                        // 把数据目录指到用户目录，避开程序目录里的读写权限问题）。
                        // 格式：`<项目根>` 或 `<项目根>|<数据目录>`（后者是绿色版用的，
                        // 把一个纯 ASCII 的用户目录同时当作项目根和数据目录）。
                        string rootPart = line.Trim();
                        string dataPart = null;
                        int bar = rootPart.IndexOf('|');
                        if (bar >= 0)
                        {
                            dataPart = rootPart.Substring(bar + 1).Trim();
                            rootPart = rootPart.Substring(0, bar).Trim();
                        }
                        // 根留空（形如 `|D:\data`）表示「沿用 exe 所在目录」：
                        // 项目根必须含 package.json + scripts/start.js，散包里那玩意儿就在 exe 旁边，
                        // 不能指到用户目录去（指过去 IsProjectRoot 会判失败、退回 exe 目录）。
                        string expanded = Environment.ExpandEnvironmentVariables(rootPart);
                        string target = string.IsNullOrEmpty(expanded)
                            ? exeDir
                            : (Path.IsPathRooted(expanded) ? expanded : Path.Combine(dir, expanded));
                        if (IsProjectRoot(target))
                        {
                            if (!string.IsNullOrEmpty(dataPart))
                            {
                                string d = Environment.ExpandEnvironmentVariables(dataPart);
                                dataDir = Path.IsPathRooted(d) ? d : Path.Combine(Path.GetFullPath(target), d);
                            }
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
                // 边车文件指定了数据目录时注入进去（散包把书架放用户目录，与程序目录分离）。
                if (!string.IsNullOrEmpty(_dataDir))
                {
                    try { psi.EnvironmentVariables["SHUYUAN_DATA"] = _dataDir; }
                    catch { }
                }
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
                    // node/electron 正常运行时几乎不写 stdout，别把空行灌进日志（以前每行都记，
                    // 日志里全是空的 [out]，真正有用的那行崩溃信息反而被挤掉）。
                    if (e.Data != null && e.Data.Trim().Length > 0) Log(root, "[out] " + e.Data);
                };
                // stderr 是崩溃信息的主通道（chromium 的 ERROR 行都往这走），一律保留
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
            if (redirect)
            {
                // WaitForExit()（无参）不等异步输出事件排空，加个超时版把残留的 stderr 收干净；
                // 否则那一行 Chromium 报错常常还没写进日志就退出了。
                p.WaitForExit(5000);
            }
            int code = p.ExitCode;

            if (code != 0)
            {
                Log(root, "[launcher] 子进程退出码 " + code);
                Fail("启动失败（退出码 " + code + "）。\r\n\r\n" +
                     "详细信息见日志：\r\n" + _logFile + "\r\n\r\n" +
                     Suggest(root, node));
            }
            return code;
        }

        /// <summary>
        /// 失败时给出可操作的排查建议。
        ///
        /// 实测最常见的两种失败，日志里一眼能认出来：
        ///   1) node 版本太老 —— 本包用了多个 Node 16+ 才有 API（fs.cpSync / fs.rmSync），
        ///      老版本 node 会以 SyntaxError/TypeError 直接退出，启动器只能看到退出码。
        ///   2) 首次启动要从程序目录复制约 270MB 的 electron 运行时（.electron-runtime\），
        ///      磁盘空间不足或杀毒软件拦了复制，同样是非零退出。
        /// 这两条与「让用户回车关掉一个纯文本窗口」相比，直接讲清楚更好。
        /// </summary>
        private static string Suggest(string root, string node)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("如果看不懂上面的日志，多半是这两种情况：\r\n\r\n");
            sb.Append("1) Node.js 版本太老。本机应使用随包的 runtime\\node\\node.exe：\r\n");
            sb.Append("   " + node + "\r\n");
            sb.Append("   可在终端里手动运行下面两行确认：\r\n");
            sb.Append("     cd /d " + root + "\r\n");
            sb.Append("     \"" + node + "\" -v\r\n");
            sb.Append("   低于 v16.7 的话请删掉 runtime 目录重新解压整个包。\r\n\r\n");
            sb.Append("2) 首次启动会复制约 270MB 运行时到 " + Path.Combine(root, ".electron-runtime") + "，\r\n");
            sb.Append("   磁盘空间不足或杀毒软件拦截时也会失败。可先手动运行：\r\n");
            sb.Append("     cd /d " + root + "\r\n");
            sb.Append("     \"" + node + "\" scripts\\start.js\r\n");
            sb.Append("   这条命令会把完整的报错打在窗口里，方便贴出来排查。");
            return sb.ToString();
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
                    // 散包把数据目录指到用户目录时，日志也跟着过去（否则程序目录只读就写不了日志，
                    // 用户按提示去找 %USERPROFILE%\ShuyuanReader\data\launcher.log 会扑空）。
                    string baseDir = string.IsNullOrEmpty(_dataDir) ? root : _dataDir;
                    string dir = string.IsNullOrEmpty(_dataDir) ? Path.Combine(baseDir, "data") : baseDir;
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

        /// <summary>
        /// 弹窗报错。--cli 调用时只写日志不弹框：CLI 通常是在脚本/终端里跑，
        /// 弹窗会卡住调用方（实测会让自动化测试挂在这里等回车）。
        /// </summary>
        private static void Fail(string message)
        {
            if (_runCli)
            {
                try { Log(_root ?? AppDomain.CurrentDomain.BaseDirectory, "[launcher] " + message.Replace("\r\n", " | ")); } catch (Exception) { }
                return;
            }
            MessageBoxW(IntPtr.Zero, message, AppTitle + " — 启动失败", 0x00000010 /* MB_ICONERROR */);
        }
    }
}
