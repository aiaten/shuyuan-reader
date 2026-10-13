# 书源阅读器（Shuyuan Reader）

一款基于 **Legado（阅读）3.x 书源规范** 的桌面小说阅读软件。

对标分析对象：`D:\Program Files (x86)\小强阅读\`（Windows C++ + 内嵌浏览器 +
写死站点规则 + SQLite + 导出 TXT）。本软件保留其全部可用能力，并把「封闭的
自研书源表」替换为 **可导入、可扩展的 Legado 书源 JSON 引擎**。

逆向分析详见 [`docs/小强阅读逆向分析.md`](docs/小强阅读逆向分析.md)。

## 四大交付点

| # | 需求 | 实现 |
|---|------|------|
| 1 | 分析小强阅读并开发小说阅读软件 | 逆向报告 `docs/小强阅读逆向分析.md` + 全项目实现 |
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
│  ├─ store/
│  │   ├─ library.js     书架与章节落盘
│  │   └─ downloader.js  批量下载（限流、断点续传、并发控制）
│  ├─ export/
│  │   └─ txt.js         TXT 导出（3 布局 × 2 编码）
│  ├─ util/
│  │   ├─ encoding.js    编码识别与解码（GBK 假 utf-8 回退 gb18030）
│  │   └─ electron-exe.js  Electron 可执行文件解析（规避中文路径崩溃）
│  ├─ app.js             应用门面（把上面全部串起来）
│  └─ cli.js             命令行入口
├─ electron/             桌面 UI（main / preload / renderer）
├─ scripts/start.js      `pnpm start` 入口
├─ docs/                 文档
└─ test/                 测试（8 unit + 3 net + 2 e2e + 1 gui）
```

## 本地存储

**不使用 SQLite**。数据以 JSON + 纯文本落盘，结构镜像小强阅读的 `chm/` 缓存布局：

```
data/
├─ shelf.json                       书架索引
├─ sources/
│   ├─ sources.json                 已安装书源（含探测结果）
│   ├─ rss.json                     已安装订阅源（Legado RSS）
│   └─ probe.json                   探测报告
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

## 已知环境约束

- **Windows 上 `electron.exe` 路径不能含非 ASCII 字符**，否则 Chromium 启动瞬间崩溃
  （`0x80000003` / `0xC0000005`，零输出）。本项目用 `src/util/electron-exe.js` 在
  `pnpm start` 时自动把 Electron 复制到纯 ASCII 缓存目录（默认
  `C:\Users\<用户>\.shuyuan-reader\`）再启动。目录联结（junction）无效。
- Electron 是 GUI 子系统程序，**stdout/stderr 不可捕获**，脚本交互一律走结果文件。
- 需清理 `ELECTRON_RUN_AS_NODE` 环境变量，否则 `require('electron')` 返回路径字符串。

## 测试

```
node test/run.js unit     # 9 个纯离线单元测试（秒级）
node test/run.js net      # 3 个联网测试（真实站点）
node test/run.js e2e      # 2 个端到端（搜索→下载→导出）
node test/run.js --all    # 全部 15 项（含 GUI 93 项断言）
```

覆盖：Cookie 域语义、编码识别（GBK 假 utf-8 回退）、Legado 规则引擎（索引/切片/
正则替换/组合符/jsoup 扩展）、URL 编码三套保留表、TXT 导出（3 布局 × 2 编码）、
书架原子落盘与损坏容错、书源库 key 归一化与 BOM 导入、订阅源库结构与增删改、
在线书源列表解析（含 yckceo 订阅源卡片与 syncLatest 时间窗口）、
真实站点抓取、可读性探测拒绝路径、全链路下载导出。

GUI 冒烟除渲染断言外，还通过真实 IPC 走一遍交付点 ②③④：拒收结构非法与域名
不存在的书源（并确认书源库不变）、接受手写书源并确认 5 个探测阶段全过、搜索 →
加书架 → 下载 2 章 → 导出 TXT 并确认产物字节数；再验证 m04402 三功能：
「🔄 更新」（真网 1 天窗口同步）、「🩺 校验书源」（重跑 GUI自写源探测）、
「📥 订阅源」（在线列表 → 安装 193 → 文本导入 → 清理归零）；以及 m04946
标红：seed 植入「不允许添加」探测记录后，在线列表中该书源卡片红字标题 +
「⛔ 不可添加」徽标 + 红字原因（`probeStatus` IPC → `.card.rejected`）。
