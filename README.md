# 书源阅读器（Shuyuan Reader）

一款基于 **Legado（阅读）3.x 书源规范** 的桌面小说阅读软件。

核心是一套可导入、可扩展的 **Legado 书源 JSON 引擎**：书源不写死在代码里，
而是通过书源 JSON 描述站点结构，由统一引擎解释执行 —— 搜书、详情、目录、正文
全部走同一套规则求值管线。

## 四大交付点

| # | 需求 | 实现 |
|---|------|------|
| 1 | 桌面小说阅读软件 | `src/` 引擎 + `electron/` 桌面 UI + `src/cli.js` 命令行 |
| 2 | 使用 yck2026.fun 提供的书源 | `src/source/yck.js`（列表/分页/下载/合集 + **最近更新同步**）+ `src/source/store.js`（本地书源库） |
| 3 | 自定义书源 + **可读性探测**（读不了不能加） | `src/source/probe.js` — 5 阶段真实探测 + 评分准入；「校验书源」对本地库批量重跑 |
| 4 | 打包导出 TXT | `src/export/txt.js` — 单文件/分章/分卷 + 编码/换行/目录可选 |

> 另支持 **Legado 订阅源**（yckceo.com `/yuedu/rss/`，`sourceName/sourceUrl` 结构）：
> GUI「在线书源 → 📥 订阅源」或 CLI `rss list/install/import/local/remove`，
> 与书源分开存放在 `data/sources/rss.json`。
>
> 在线书源列表会**自动标红**历史上探测失败（不允许添加）的书源：红字标题 +
> 「⛔ 不可添加」徽标 + 红字原因（依据本地 `probe.json` 探测记录实时判定）。

## 目录结构

```
novel-reader/
├─ src/
│  ├─ net/
│  │   ├─ http.js        HTTP 客户端（keepAlive 连接池、30x、gzip/br、UA、POST form 分支）
│  │   ├─ cookiejar.js   Cookie 管理（域/路径/过期/父子域匹配）
│  │   └─ encode.js      URL 编码（query/form/escape 三套保留表，逐字对齐 Legado）
│  ├─ rules/
│  │   ├─ rule.js        Legado 规则求值引擎（选择器/索引/切片/正则替换/组合符）
│  │   └─ jsrt.js        @js: 运行时（java.* 桥接、加密、前后端 JS 沙箱）
│  ├─ engine/
│  │   └─ source.js      五操作编排：search / bookInfo / toc / content / explore
│  ├─ source/
│  │   ├─ yck.js         yck2026.fun 书源库 + yckceo.com 订阅源库（列表页解析、下载、合集、最近更新同步）
│  │   ├─ store.js       本地书源库 + 订阅源库（导入/导出/校验/去重）
│  │   └─ probe.js       可读性探测（5 阶段 + 准入判定）
│  ├─ browser/
│  │   ├─ sites.js       内置浏览器预置站点表（起点/飞卢/刺猬猫/菠萝包/晋江…）
│  │   └─ store.js       书签 / 历史 / 会话持久化
│  ├─ store/
│  │   ├─ library.js     书架与章节落盘
│  │   ├─ updater.js     书架检查更新（抓最新目录 → 比对 → 纯追加落盘）
│  │   ├─ downloader.js  批量下载（限流、断点续传、并发控制、stub 错误页守卫）
│  │   └─ download-queue.js 下载任务队列（入队即返回 / 同书去重 / 串行执行 / 进度轮询 / 中断恢复）
│  ├─ export/
│  │   └─ txt.js         TXT 导出（3 布局 × 2 编码）
│  ├─ util/
│  │   ├─ encoding.js    编码识别与解码（GBK 假 utf-8 回退 gb18030）
│  │   └─ electron-exe.js  Electron 可执行文件解析（规避中文路径崩溃）
│  ├─ app.js             应用门面（把上面全部串起来）
│  └─ cli.js             命令行入口
├─ electron/             桌面 UI（main / preload / renderer）
├─ scripts/start.js      `pnpm start` 入口
├─ docs/                 文档（Legado 规则规范）
└─ test/                 测试（17 unit + 3 net + 2 e2e + 1 gui）
```

## 本地存储

**不使用 SQLite**。数据以 JSON + 纯文本落盘，每章一个文件，便于增量下载与断点续传：

```
data/
├─ shelf.json                       书架索引（含查看方式 layout / 排序 sort）
├─ sources/
│   ├─ sources.json                 已安装书源（含探测结果）
│   ├─ rss.json                     已安装订阅源（Legado RSS）
│   └─ probe.json                   探测报告
├─ browser/
│   ├─ bookmarks.json               浏览器书签
│   └─ history.json                 浏览器历史
├─ books/<bookId>/
│   ├─ meta.json                    书名/作者/分类/封面/来源
│   ├─ toc.json                     完整目录（含 isVolume 标记）
│   ├─ chapters/00000.txt …         每章一个文件（正文已清洗为纯文本）
│   └─ progress.json                阅读进度（章节序号 / 滚动偏移 / 百分比）
└─ export/                          TXT 导出目录
```

`bookId` 为 `site_url + book_url` 的稳定哈希，重复添加同一本书不会产生新目录。

## 运行

```bash
node src/cli.js --help     # 命令行
pnpm start                 # 桌面应用
node test/run.js           # 测试（unit + net）
node test/run.js --all     # 全部测试
```

### CLI 速览

```
online list [--page N] [--keys 词] [--order time|down]   浏览在线书源
online install <id> [--keyword 词]                       安装（默认做可读性探测）
online update [--kind shuyuan|rss] [--days N] [--pages N]
                            [--no-probe] [--force]       刷新 yckceo 最近 N 天更新的书源并同步安装
source add <file.json|-> [--no-probe] [--force]          导入自定义书源
source test <file.json|->                                只探测不落盘
source check [--keyword 词] [--keys k1,k2]               本地书源批量重跑可读性探测
rss list [--page N]                                      浏览 yckceo 在线订阅源
rss install <id>                                         安装在线订阅源
rss import <file.json|->                                 导入订阅源 JSON
rss local                                                本地订阅源列表
rss remove <key>                                         删除本地订阅源
check [--book <bookId>] [--dry-run] [--concurrency N]  检查书架小说有没有更新
search <关键词> [--source KEY] [--all]                    搜索
add <sourceKey> <bookUrl> [--download] [--to N]          加书架（可顺带下载）
download <bookId> [--from N] [--to N] [--force]          下载/续传
read <bookId> [章节序号]                                  阅读
export <bookId|--all> [--layout single|chapter|volume]   导出 TXT
```

环境变量 `SHUYUAN_DATA` 可指定数据目录（默认 `<项目>/data`）。

## 书源兼容性

支持 Legado 3.x 书源 JSON 的下列规则语法（全部经真实书源实测）：

| 类别 | 语法 |
|------|------|
| 默认规则 | `class.x.0@tag.a.list`、`id.x@text`、`tag.div@href`、`text.目录@href` |
| 前缀 | `@css:`、`@XPath:`、`@json:`、`@js:`、`@rule:` |
| 取值操作 | `text`、`textNodes`、`ownText`、`html`、`all`、`@任意属性` |
| 索引语法 | `.N`、`.-1`（负索引）、`!N`（排除）、`[1:3]`（区间）、`[0:4:2]`（步长）、`[!0,2]` |
| 切片 | `p[1:-2]`（Legado 的 `ElementsSingle.findIndexSet` 语义） |
| 组合 | `\|\|`（取首个非空短路）、`&&`（并联取全部）、`%%`（按结果集下标交错） |
| 正则 | `##regex`、`##regex##replacement`、`##regex##replacement###`（replaceFirst） |
| 占位符 | `{{key}}`、`{{searchKey}}`、`{{page}}`、`<js>…</js>` 内联块 |
| URL 规则 | `<js>…</js>` 与前后文本串联（`@result` 承接上一块输出）、`<a,b>` 分页、`url,{options}` |
| jsoup 扩展 | `[attr~=regex]` 属性正则匹配（cheerio 原生不支持，已自行实现） |
| JS 桥接 | `java.ajax/get/post/getCookie/base64Decode/md5Encode/aesEncodeToBase64String/…`、`source.*`、`cookie.*`、`C.*`、`J.*`、`Packages.*`（部分） |

**支持的 `Packages.*`**：`javax.crypto.*`（Cipher/Mac/SecretKeySpec/GCMParameterSpec）、
`java.security.MessageDigest`、`java.util.Base64`、`android.util.Base64`、
`java.io.ByteArrayOutputStream`、`java.lang.String`、`java.util.HashMap`。

**不支持的**（探测阶段会明确标注，不会静默失败）：
`java.startBrowserAwait` / `J.webView` 等 WebView 类 API、
`java.getVerificationCode`（人机验证）、`Packages.android.*` 中依赖 Android 运行时的部分、
URL 选项里的 `webView: true` / `js:` / `bodyJs:`（无内嵌浏览器可选）。

> 实测示例：起点中文网（书源 7036）的搜索地址带 `"webView": true`，站点返回一个
> JS 反爬探针页（`status=202` + `<script src="/…/probe.js">`），本引擎无 WebView
> 故取不到内容 —— 这属于能力边界，`probe.js` 会判定为不可读并拒绝添加。

## 界面功能

| 功能 | 说明 |
|------|------|
| 书架查看方式 | 右上角分段按钮切换 **列表 / 图标** 两种布局，选择持久化到 `localStorage` |
| 书架排序 | 下拉选「最近添加 / 书名 / 作者 / 阅读进度」 |
| 自动检查更新 | **每次打开软件**自动抓一遍书架内所有书的最新目录（后台跑，不阻塞首屏）；卡片上出现「🆕 有更新 +N 章 / 已是最新 / 目录有变动 / 检查失败」徽标，工具栏显示本次结果与检查时间 |
| 检查更新按钮 | 书架工具栏 `🔄 检查更新` 整架检查；每张卡片另有「检查更新」只查这一本。远端只是**纯追加**时自动把新章节补进本地目录（已下载正文不受影响）；若检测到中间插入/删章/重排，只标「目录有变动」而不覆盖本地目录（避免正文串章），由用户自行换源或重新抓取 |
| 日夜模式 | 顶栏 `🌙 夜间`（快捷键 **Alt+T**）切换；首次启动跟随系统 `prefers-color-scheme`；选择持久化；切换前用纯 CSS 兜底防白闪 |
| 阅读设置 | 阅读页 `Aa` 打开：**字体样式**（7 种预设：系统默认/宋体/黑体/楷体/微软雅黑/思源/等宽）、**字号 12–32px**、行距、页宽；实时预览 + 恢复默认；持久化到 `localStorage` |
| 换源 | 书架卡片「换源」→ 并发搜索其他书源上的同一本书 → 按「书名+作者一致度」打分排序 → 一键切源（默认保留阅读进度、可顺带迁移已下载正文） |
| 内置浏览器 | 书架后独立页签：预置起点中文网、飞卢小说网、刺猬猫、菠萝包、晋江文学城等**收费阅读网站**；支持地址栏、后退/前进/刷新、书签与历史持久化。**只做浏览，不抓取正文** |
| 书源网站跳转 | 在线书源列表每条卡片有 `🌐 打开网站`：在内置浏览器里打开该书源自身的 `bookSourceUrl`；同域站点复用已有标签，不重复堆标签 |
| 网页转书源 | 在线书源工具栏 `🛠 网页转书源`：输入任意小说网址，自动嗅探页面结构（搜索表单 → 列表容器/条目 → 详情页 → 目录 → 正文/分页）生成 Legado 3.x 书源 JSON；逐步骤展示进度，生成结果仍要过可读性探测闸门才允许添加。正文为纯动态加载（AJAX 壳页）的站点会被红线拒收 |
| 章节刷新 / 重新下载 | 阅读页工具栏 `↻ 刷新`（重读本地缓存）与 `⇩ 重新下载`（从书源强制重下本章并覆盖）。有些站会把「获取章节内容失败」这类错误页当正文返回——下载器现已识别这种 **stub 错误页**（极短且命中错误词表 → 记失败不落盘，续传时自动重试）；旧数据里已存档的错误页在正文顶部显示黄条警示并给出一键重下按钮 |
| 下载页签（后台队列） | 书架点「下载」只是**入队**后立刻返回，界面不再被遮罩锁死；进度统一在新「下载」页签里看：每本一张任务卡（书名/状态/已下章节/百分比进度条/速度），支持 `全部/进行中/已完成` 过滤、`↻ 刷新`、`🧹 清空已完成`，导航栏「下载」页签上有进行中数量的红点。任务串行执行（同一本书自动去重），关软件时正在跑的会被标记为「已中断」，下次打开可续传（已完成的不重下） |

## 已知环境约束

- **Windows 上 `electron.exe` 路径不能含非 ASCII 字符**，否则 Chromium 启动瞬间崩溃
  （`0x80000003` / `0xC0000005`，零输出）。本项目用 `src/util/electron-exe.js` 在
  `pnpm start` 时自动把 Electron 复制到纯 ASCII 缓存目录（默认
  `C:\Users\<用户>\.shuyuan-reader\`）再启动。目录联结（junction）无效。
- Electron 是 GUI 子系统程序，**stdout/stderr 不可捕获**，脚本交互一律走结果文件。
- 需清理 `ELECTRON_RUN_AS_NODE` 环境变量，否则 `require('electron')` 返回路径字符串。
- **单实例锁按 `userData` 目录判定**：`electron/main.js` 有
  `app.requestSingleInstanceLock()`。同目录再开一个实例会在 `whenReady` 之前
  `app.quit()`（quit 异步，退出码仍是 0）。GUI 冒烟因此每次用独立的
  `ELECTRON_USER_DATA_DIR`（带 pid），既避免自己撞自己，也让测试实例与用户
  手动打开的软件可以并存。
- **GUI 冒烟的时间预算**：断言里有等真站（yck 书源列表、站点页加载）的步骤，
  正常耗时 103~114s。`MAX_MS` 取 180s（可用 `SHUYUAN_SMOKE_TIMEOUT_MS` 覆盖）；
  取 120s 会把「慢」误报成「没有结果文件」。探针里的 `r.seg` 记录分段耗时。
- **`github.com:443` 可能被间歇性阻断**（`api.github.com` / `codeload` 正常，
  `github.com` 直连超时或拒绝）。本机已把 `gh` 配成 git 凭据助手，见下节。

### 推送（本机实测可用的配置）

`github.com:443` 会被间歇阻断，HTTPS 推送偶发 `Failed to connect to github.com:443`。
`gh` 已登录（账号 aiaten，token 带 `repo` scope），在 `~/.gitconfig` 里配成凭据助手后
推送走该凭据即可（注意 `gh.exe` 路径含空格，`helper` 值要用 `!'...'` 包起来）：

```ini
[credential "https://github.com"]
	helper =
	helper = "!'C:/Program Files/GitHub CLI/gh.exe' auth git-credential"
```

git 不在 PATH，全路径为 `C:\Program Files\Git\cmd\git.exe`。

### 推送被阻断时的兜底：`tools/api-push.js`

`github.com:443` 被阻断时 `git push` 会重试无效（而 `api.github.com` 一直可用）。
`tools/api-push.js` 改走 REST API 推单个文件：上传 blob → 基于父树建新树 → 建提交 →
移动 ref，只需 token 的 `repo` scope。

```
node tools/api-push.js <owner/repo> <ref> <父提交sha> <文件相对路径> <本地文件路径> "<commit message>"
```

它会打印 `new tree`。**若该 SHA 与 `git rev-parse HEAD^{tree}` 完全一致，则远端内容与
本地逐字节相同**（树 SHA 是内容寻址的），可据此确认推送正确。推完用
`git fetch origin <branch>` + `git reset --soft origin/<branch>` 对齐本地 ref
（提交 SHA 会因时间戳不同而与本地原提交不同，但树相同）。

## 测试

```
node test/run.js unit     # 17 个纯离线单元测试（秒级）
node test/run.js net      # 3 个联网测试（真实站点）
node test/run.js e2e      # 2 个端到端（搜索→下载→导出）
node test/run.js --all    # 全部 23 项（含 GUI 208 项断言）
```

覆盖：Cookie 域语义、编码识别（GBK 假 utf-8 回退）、Legado 规则引擎（索引/切片/
正则替换/组合符/jsoup 扩展）、URL 编码三套保留表、TXT 导出（3 布局 × 2 编码）、
书架原子落盘与损坏容错、书源库 key 归一化与 BOM 导入、订阅源库结构与增删改、
在线书源列表解析（含 yckceo 订阅源卡片与 syncLatest 时间窗口）、懒加载滑动窗口、
书架检查更新（目录比对 / 纯追加才落盘 / 变动不覆盖 / 失败只记错 / 汇总）、
下载队列（入队即返回 / 同一本书去重 / 多本串行 / 进度到 100% / 单本失败不影响后续 / 取消 / 清空只清已结束 / 重启把 running 标成 interrupted）、
书架换源（候选筛选/进度保留/失败回滚）、内置浏览器（站点表/书签历史会话/脏数据容错）、
网页转书源嗅探（搜索表单/URL 模板/列表容器打分/条目规则/正文红线，假站点离线全链路）、
真实站点抓取、可读性探测拒绝路径、全链路下载导出、站点错误页(stub)守卫
（错误提示不落盘、只剩标题的空壳章记失败、force 重下可覆盖）。

GUI 冒烟除渲染断言外，还通过真实 IPC 走一遍交付点 ②③④：拒收结构非法与域名
不存在的书源（并确认书源库不变）、接受手写书源并确认 5 个探测阶段全过、搜索 →
加书架 → 下载 2 章 → 导出 TXT 并确认产物字节数；再验证「🔄 更新」（真网 1 天窗口
同步）、「🩺 校验书源」、「📥 订阅源」（在线列表 → 安装 → 文本导入 → 清理归零）；
标红：seed 植入「不允许添加」探测记录后，在线列表中该书源卡片红字标题 +
「⛔ 不可添加」徽标 + 红字原因（`probeStatus` IPC → `.card.rejected`）；
以及**下载页签**（页签/面板/列表/过滤/刷新/清空都在；`enqueueDownload` 必须 120ms 内返回、不再阻塞书架；
任务立刻出现在 `listDownloads()` 与页面卡片里且带进度条）、
以及日夜模式、书架查看方式与排序、阅读设置、换源、内置浏览器、网页转书源对话框、
检查更新（按钮 / API / 单本检查结果写回书架条目）、
（前端拦截非法输入、后端拒绝空网址、添加按钮在无结果时置灰——全程不依赖外网）；
阅读器 `↻ 刷新`/`⇩ 重新下载` 按钮绑定与站点错误页(stub)警示条渲染
（临时替换渲染端全局判据函数走警示分支，不依赖外网）。
