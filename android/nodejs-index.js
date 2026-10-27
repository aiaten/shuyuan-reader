'use strict';
/**
 * 安卓版引擎入口（capacitor-nodejs）。
 *
 * 桌面版是 Electron 主进程用 ipcMain 暴露 58 个方法（见 electron/main.js），
 * 这里把同一套方法挂到 capacitor-nodejs 的 EVENT_CHANNEL 上，
 * 让 www/api-bridge.js 能用一模一样的方式调用引擎，界面代码零改动。
 *
 * 协议（和 electron 的 {ok, data|error} 完全一致）：
 *   界面 -> 引擎： channel.send('invoke', id, channelName, args[])
 *   引擎 -> 界面： channel.send('reply', id, {ok:true,data} | {ok:false,error})
 *   引擎 -> 界面： channel.send('event', eventName, payload)   // 下载/搜索进度
 */

const fs = require('fs');
const path = require('path');

/* Node 18 没有 Web 全局 File/Blob，而 cheerio 依赖的 undici 一加载就要用。
   不补这两个全局，require('cheerio') 直接 ReferenceError: File is not defined。 */
const buf = require('buffer');
if (typeof globalThis.File === 'undefined' && buf.File) globalThis.File = buf.File;
if (typeof globalThis.Blob === 'undefined' && buf.Blob) globalThis.Blob = buf.Blob;

const bridge = require('bridge');
const channel = bridge.channel;

/* 数据目录由 Java 侧注入（<filesDir>/nodejs/data），卸载应用前一直保留。 */
const dataDir = bridge.getDataPath();

const App = require('./src/app.js').App;
const AppModule = require('./src/app.js');
const BrowserStore = require('./src/browser/store.js').BrowserStore;
const sites = require('./src/browser/sites.js');

function sendEvent(eventName, payload) {
  try {
    channel.send('event', eventName, payload);
  } catch (e) {
    console.log('[bridge] 事件发送失败 ' + eventName + ': ' + (e && e.message));
  }
}

/** 首次启动把内置书源灌进数据目录（只补不覆盖），和桌面版 seedBundledData 同义 */
function seedBundledData(dir) {
  const bundled = path.join(__dirname, 'data');
  for (const rel of [path.join('sources', 'sources.json'), path.join('sources', 'rss.json')]) {
    const from = path.join(bundled, rel);
    const to = path.join(dir, rel);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    } catch (e) {
      console.log('[seed] ' + rel + ' 灌入失败: ' + (e && e.message));
    }
  }
}

let facade = null;
let store = null;

function getApp() {
  if (!facade) {
    seedBundledData(dataDir);
    facade = new App({
      dataDir,
      logger: (m) => console.log('[app] ' + m),
      onDownloadEvent: (ev) => sendEvent('download:event', ev),
    });
  }
  return facade;
}

function getStore() {
  if (!store) store = new BrowserStore(dataDir);
  return store;
}

/** 导出目录：安卓没有「选目录」对话框，统一落到 <数据目录>/export */
function exportDir() {
  const dir = path.join(dataDir, 'export');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* 目录已存在 */
  }
  return dir;
}

/* ==================== 通道表（与 electron/main.js 一一对应） ==================== */

const HANDLERS = {
  'app:info': (a) => a.info(),

  /* 安卓没有系统对话框：界面侧拿这个目录当「导出目录」显示 */
  'app:paths': () => ({ dataDir, exportDir: exportDir() }),

  'online:list': (a, opts) => a.onlineList(opts || {}),
  'online:get': (a, id) => a.onlineDownload(id),
  'online:install': (a, id, opts) => a.installFromOnline(id, opts || {}),
  'online:syncUpdates': (a, opts) => a.syncOnlineUpdates(opts || {}),
  'source:check': (a, opts) => a.checkSources(opts || {}),
  'probe:status': (a) => a.probeStatusMap(),
  'online:route': (a, opts) => a.onlineRoute(opts || {}),

  'rss:onlineList': (a, opts) => a.onlineRssList(opts || {}),
  'rss:list': (a) => a.listRss(),
  'rss:install': (a, id, opts) => a.installRssFromOnline(id, opts || {}),
  'rss:importText': (a, text, opts) => a.importRss(text, opts || {}),
  'rss:remove': (a, key) => ({ removed: a.removeRss(key) }),

  'source:list': (a) => a.listSources(),
  'source:add': (a, source, opts) => a.addSource(source, opts || {}),
  'source:test': (a, source, opts) => a.testSource(source, opts || {}),
  'source:remove': (a, key) => ({ removed: a.removeSource(key) }),
  'source:get': (a, key) => a.getSource(key),
  'source:export': (a, keys) => a.exportSources(keys),
  'source:importText': (a, text) => a.importSources(text),
  'source:autogen': (a, url, opts) => a.autogenSource(url, opts || {}),

  'search:one': (a, key, kw, page) => a.search(key, kw, page || 1),
  'search:all': (a, kw, keys, page, opts) => a.searchAll(kw, keys, page || 1, opts || {}),
  'search:everywhere': (a, kw, opts = {}) =>
    a.searchEverywhere(kw, Object.assign({}, opts, {
      onStart: (ev) => sendEvent('search:event', Object.assign({ type: 'start' }, ev)),
      onResult: (ev) => sendEvent('search:event', Object.assign({ type: 'result' }, ev)),
    })),
  'search:perf': (a, key) => a.sourcePerf(key),
  'search:resetPerf': (a) => ({ reset: a.resetSourcePerf() }),

  'shelf:list': (a) => a.shelf(),
  'shelf:book': (a, id) => a.book(id),
  'shelf:remove': (a, id) => ({ removed: a.removeBook(id) }),
  'shelf:toc': (a, id) => a.toc(id),
  'shelf:add': (a, key, book, opts) => a.addToShelf(key, book, opts || {}),
  'shelf:download': (a, id, opts) => a.download(id, opts || {}),
  'shelf:downloadWindow': (a, id, index, opts) => a.downloadWindow(id, index, opts || {}),
  'download:enqueue': (a, id, opts) => a.enqueueDownload(id, opts || {}),
  'download:list': (a) => a.listDownloads(),
  'download:cancel': (a, jobId) => a.cancelDownload(jobId),
  'download:pause': (a, jobId) => a.pauseDownload(jobId),
  'download:resume': (a, jobId) => a.resumeDownload(jobId),
  'download:clear': (a) => a.clearFinishedDownloads(),
  'shelf:windowBusy': (a, id) => ({ busy: a.windowBusy(id) }),
  'shelf:chapter': (a, id, index) => a.chapter(id, index),
  'shelf:progress': (a, id) => a.progress(id),
  'shelf:saveProgress': (a, id, p) => a.saveProgress(id, p),
  'shelf:sourceCandidates': (a, id, opts) => a.sourceCandidates(id, opts || {}),
  'shelf:changeSource': (a, id, key, opts) => a.changeSource(id, key, opts || {}),
  'shelf:checkUpdates': (a, opts) => a.checkUpdates(opts || {}),
  'shelf:checkBook': (a, id, opts) => a.checkBook(id, opts || {}),

  'export:book': (a, id, opts) => a.exportBook(id, Object.assign({ outDir: exportDir() }, opts || {})),
  'export:shelf': (a, opts) => a.exportShelf(Object.assign({ outDir: exportDir() }, opts || {})),
  'export:defaults': () => App.exportDefaults(),

  /* 安卓没有系统文件对话框：读文件走界面里的 <input type=file>，
     写文件统一落到 <数据目录>/export。 */
  'dialog:saveFile': (_a, name, content) => {
    const safe = String(name || 'sources.json').replace(/[\\/:*?"<>|]/g, '_');
    const p = path.join(exportDir(), safe);
    fs.writeFileSync(p, String(content == null ? '' : content), 'utf8');
    return { canceled: false, path: p };
  },
  'shell:showItem': () => ({ done: true }),
  'shell:openExternal': () => ({ done: true }),

  /* 浏览器页签：安卓没有 <webview>，书签/历史/会话照样能用（纯 fs），
     导航交给系统浏览器（界面侧处理，见 api-bridge.js）。 */
  'browser:listSites': () => ({ sites: sites.listSites(), policy: sites.POLICY }),
  'browser:normalize': (_a, raw) => {
    const u = require('./src/browser/store.js').normalizeInput(raw);
    if (!u) return { ok: false, error: '请输入网址，例如 www.xxx.com' };
    return { ok: true, url: u };
  },
  'browser:bookmarks': () => getStore().bookmarks(),
  'browser:history': (_a, limit) => getStore().history(limit || 50),
  'browser:stats': () => getStore().stats(),
  'browser:addBookmark': (_a, it) => getStore().addBookmark(it || {}),
  'browser:removeBookmark': (_a, url) => getStore().removeBookmark(url),
  'browser:renameBookmark': (_a, url, title) => getStore().renameBookmark(url, title),
  'browser:clearBookmarks': () => getStore().clearBookmarks(),
  'browser:pushHistory': (_a, it) => getStore().pushHistory(it || {}),
  'browser:clearHistory': () => getStore().clearHistory(),
  'browser:session': () => getStore().session(),
  'browser:saveSession': (_a, tabs) => getStore().saveSession(tabs || []),
};

/* ==================== 收消息 ==================== */

channel.addListener('invoke', async (id, channelName, args) => {
  const list = Array.isArray(args) ? args : [];
  let payload;
  try {
    const fn = HANDLERS[channelName];
    if (!fn) throw new Error('未实现的通道：' + channelName);
    const data = await fn(getApp(), ...list);
    payload = { ok: true, data };
  } catch (e) {
    payload = { ok: false, error: (e && e.message) || String(e), stack: e && e.stack };
  }
  try {
    channel.send('reply', id, payload);
  } catch (e) {
    console.log('[bridge] 回包失败 ' + channelName + ': ' + (e && e.message));
  }
});

console.log('[node] 引擎已启动，数据目录 ' + dataDir);