# 安卓版（Capacitor + nodejs-mobile）

这是桌面版引擎的**原样复用**：`src/`（书源引擎、规则、书架、下载队列）一行不改地跑在
Android 里的 Node 18.20.4 上，界面复用 `electron/renderer/` 的 HTML/CSS/JS，
通信层把 Electron 的 IPC 换成 capacitor-nodejs 的消息通道。

这份目录只放**移植层**（真正需要手写的那几个文件），Android 原生工程由 Capacitor 生成。

## 文件对照

| 这里的文件 | 在 Android 工程里的位置 | 作用 |
| --- | --- | --- |
| `www-api-bridge.js` | `www/api-bridge.js` | 在界面侧造出 `window.api`，把 Electron preload 的 58 个方法映射成消息通道调用 |
| `nodejs-index.js` | `www/nodejs/index.js` | 安卓侧 Node 入口：加载 `src/app.js`，把 77 个 IPC 通道接到 `App` 的方法上 |
| `nodejs-package.json` | `www/nodejs/package.json` | 引擎侧的依赖声明（cheerio / iconv-lite） |
| `capacitor.config.json` | `capacitor.config.json` | appId / appName / webDir / nodeDir |
| `app-build.gradle` | `android/app/build.gradle` | 签名配置、ABI 拆分（arm64 / arm32 / universal） |
| `package.json` | `package.json` | Capacitor 8.5.3 + capacitor-nodejs 的构建依赖 |

## 目录结构（Capacitor 工程）

```
android/            Capacitor 生成的安卓原生工程
www/                界面（index.html / app.js / style.css / api-bridge.js）
www/nodejs/         跑在设备里的 Node 工程
  index.js          入口（消息通道 ↔ App）
  src/              桌面版 src/ 原样拷入
  node_modules/     cheerio / iconv-lite 闭包
  data/             随包书源（首次启动种子化）
```

## 三个移植要点

### 1. Node 18 缺 `File`/`Blob` 全局

`cheerio` 的依赖链会拉 `undici`，而 `undici@7` 用了 Node 20 才有的 Web 全局 `File`。
不补就会在 `require('cheerio')` 时直接崩：

```
ReferenceError: File is not defined
    at .../undici/lib/web/webidl/index.js:537
```

`nodejs-index.js` 第一行补上即可，**不需要换 `cheerio/slim`**：

```js
const buf = require('buffer');
if (typeof globalThis.File === 'undefined' && buf.File) globalThis.File = buf.File;
if (typeof globalThis.Blob === 'undefined' && buf.Blob) globalThis.Blob = buf.Blob;
```

（`cheerio/slim` 也能跑，但它默认把中文序列化成 `&#x7b2c;` 实体，会让 `@html` 规则失配。）

### 2. 没有 `<webview>`，浏览器页签降级

Electron 用 `<webview>` 做内置浏览器；安卓的 Capacitor 主 WebView 会把非同源地址
直接交给系统浏览器（`Bridge.launchIntent` → `ACTION_VIEW`），做不了内嵌浏览器。

所以 `api-bridge.js` 里 `browser.hasWebview = false`，`app.js` 看到这个标记就跳过
`document.createElement('webview')` 那段，改成 `openExternal`。书签 / 历史 / 会话照常可用。

### 3. 没有选目录对话框

桌面版用 `dialog.showOpenDialog` 让用户挑导出目录；安卓没有这个概念。
`nodejs-index.js` 固定导出到 `<数据目录>/export/`，`dialog:pickDir` 直接返回它。

## 通信协议

```
界面 → 引擎   channel.send('invoke', id, channelName, args[])
引擎 → 界面   channel.send('reply', id, { ok: true, data } | { ok: false, error, stack })
引擎 → 界面   channel.send('event', eventName, payload)   // download:event / search:event
```

`{ ok, data | error }` 这一层信封是和 `electron/main.js` 的 `handle()` 对齐的，
所以 `www-api-bridge.js` 里解包之后的行为和 `electron/preload.js` 完全一致
（失败时 throw `Error`，带 `err.channel`）。

## 构建步骤

需要 JDK 21、Android SDK（platform 36 / build-tools 36 / NDK 27）、Gradle 8.14.3。

本机工具链统一装在 D 盘（约定：环境/工具不装 C 盘）：

| 组件 | 路径 |
| --- | --- |
| JDK 21 | `D:\AI\data\android\jdk21\jdk-21.0.2` |
| Android SDK | `D:\AI\data\android\sdk` |
| Gradle 8.14.3 | `D:\AI\data\android\gradle8143\gradle-8.14.3` |
| Gradle 缓存 | `D:\AI\data\android\gradle-home` |
| Capacitor 工程 | `D:\AI\data\android\app` |
| keystore | `D:\AI\data\android\shuyuan.keystore` |
| AVD | `D:\AI\data\android\.android\avd` |

`adb` / `gradle` / `java` 已加入用户 PATH；`TMP`/`TEMP` 也指向 `D:\AI\data\temp`。

```bash
npm install                 # @capacitor/* + capacitor-nodejs.tgz + cheerio + iconv-lite
npx cap add android         # 首次
npx cap sync android        # 每次改完 www/ 或 www/nodejs/ 都要跑

# 引擎目录装依赖（nodejs-mobile 里没有 npm）
cd www/nodejs && npm install && cd ../..

# 出包
cd android && gradle assembleRelease
```

产物在 `android/app/build/outputs/apk/release/`：

- `app-arm64-v8a-release.apk` ≈ 55 MB —— 绝大多数手机装这个
- `app-armeabi-v7a-release.apk` ≈ 51 MB —— 老 32 位机
- `app-universal-release.apk` ≈ 153 MB —— 三个 ABI 都带，体积大但不会装错

APK 大是因为 `libnode.so` 每个 ABI 都 60 MB 上下——Node 运行时本身就这个量级。

签名：`android/app/build.gradle` 里读环境变量 `SHUYUAN_KEYSTORE` / `SHUYUAN_STOREPASS` /
`SHUYUAN_KEYALIAS` / `SHUYUAN_KEYPASS`，缺省指向 `D:/AI/data/android/shuyuan.keystore`（本机调试用，别的机器请用环境变量覆盖）。

## 界面适配（手机）

安卓壳（以及任何宽度 ≤720px 的窗口）会切到「左侧竖排导航」布局：

- `applyLayoutMode()` 判断 `window.api.__android`（api-bridge.js 里写的标记）或 `window.innerWidth <= 720`，为真时给 `<html>` 加 `data-layout="rail"`。
- `style.css` 里 `html[data-layout="rail"]` 把顶栏变成 `position:fixed; left:0; width:88px; height:100%; flex-direction:column`，页签自上而下排列，`main` 用 `margin-left:88px` 让开。
- 进入阅读器时 `setReading(true)` 加 `data-reading="1"`，CSS 把整条导航 `display:none` 并把 `margin-left` 归零，把屏幕全给正文；点返回或切页签时 `setReading(false)` 自动恢复。
- 桌面端（无安卓标记且窗口够宽）行为不变：仍是顶部横排，`data-layout` 被移除。
## 已知限制

- **Node 18 已 EOL**。上游 nodejs-mobile 停在 18.20.4，且 capacitor-nodejs 作者已标注
  「新项目不再推荐」。这个版本能用，但不适合长期演进。
- **首次启动会解压**：APK 里的 Node 工程（含 node_modules 约 1200 个文件）要复制到
  `/data/data/<pkg>/files/nodejs/public`，冷启动会多花一两秒。升级 APK 会重解压，
  但 `files/nodejs/data`（书架、正文、书源）保留。
- **没有后台下载**：界面关掉后下载队列会停（和桌面版行为一致）。
- 内置浏览器页签只能把站点交给系统浏览器，不能内嵌。
