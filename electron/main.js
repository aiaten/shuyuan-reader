'use strict';
/**
 * Electron 主进程：把 src/app.js 的门面通过 IPC 暴露给渲染进程。
 * 所有业务逻辑都在 src/ 里，本文件只做窗口管理与 IPC 转发。
 */

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, webContents } = require('electron');

const { App } = require('../src/app');
const { listSites, POLICY, getSite } = require('../src/browser/sites');
const { BrowserStore, normalizeInput } = require('../src/browser/store');

let win = null;
let facade = null;

/**
 * 内置浏览器用的是渲染进程里的 <webview> 标签（guest webContents）。
 * 这里只做三件事：放行响应头、把 guest 的导航事件回传给界面、
 * 以及在窗口关闭时记住「上次开着哪几个标签」。
 * 一切正文都留在站点自己的网页里，主进程不读、不存、不解析页面内容。
 */

/** 给所有 guest（webview）放行响应头。缺了它 Chromium 会拒渲染页面。 */
function installGuestWebPreferences() {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.on('did-finish-load', () => {
      try {
        contents.setWindowOpenHandler(({ url }) => {
          // 站点里的 target=_blank / window.open 不另开窗口，让宿主标签接过去；
          // 交给渲染进程决定是同标签跳还是开新标签。
          if (/^https?:\/\//i.test(url) && win && !win.isDestroyed()) {
            win.webContents.send('browser:openTab', { url });
          } else if (/^https?:\/\//i.test(url)) {
            shell.openExternal(url);
          }
          return { action: 'deny' };
        });
      } catch (_) {
        /* 有些早期时机拿不到，忽略即可 */
      }
    });
  });
}

/** 统一的“往界面推事件”出口；窗口没了就静默丢弃 */
function sendToBrowser(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * tabId ↔ guest webContents.id 的映射。
 * 界面每建一个 <webview> 就 browser:bind 一次，主进程据此知道
 * 「这个 guest 属于哪个标签」，之后 navigate/back/forward 才能定向下发。
 */
const tabGuests = new Map(); // tabId(string) → webContents.id(number)

function tabIdOfGuest(guestId) {
  for (const [tid, wid] of tabGuests) if (wid === guestId) return tid;
  return null;
}

/** 拿到某个标签的 guest；标签没绑定/已销毁都返回 null */
function guestOf(tabId) {
  const id = tabGuests.get(String(tabId));
  if (!id) return null;
  const wc = webContents.fromId(id);
  return wc && !wc.isDestroyed() ? wc : null;
}

/** 懒建浏览器存储（只在真正用到浏览器页签时才读盘） */
let browserStore = null;
function store() {
  if (!browserStore) browserStore = new BrowserStore(getApp().dataDir);
  return browserStore;
}

function getApp() {
  if (!facade) {
    facade = new App({
      dataDir: process.env.SHUYUAN_DATA || undefined,
      logger: (m) => console.log('[app]', m),
    });
  }
  return facade;
}

/** 统一的 IPC 处理：把返回值/异常都包成 {ok, data|error} */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      const data = await fn(getApp(), ...args);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e), stack: e && e.stack };
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: '书源阅读器',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 内置浏览器页签用 <webview> 承载站点页面（见「浏览器」IPC 段）
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  /* 内置浏览器：把每个 webview(guest) 的导航状态回传给界面，
     让地址栏 / 前进后退按钮跟着真实状态走。
     这里只转发「地址、标题、能否前进后退」——不碰页面内容。 */
  win.webContents.on('did-attach-webview', (_e, guest) => {
    const emit = (type, extra) => {
      const tabId = tabIdOfGuest(guest.id);
      if (!tabId) return; // 还没认领的 guest（例如刚创建）先丢
      sendToBrowser('browser:event', {
        type,
        tabId,
        url: guest.getURL(),
        title: guest.getTitle(),
        canGoBack: guest.navigationHistory ? guest.navigationHistory.canGoBack() : guest.canGoBack(),
        canGoForward: guest.navigationHistory ? guest.navigationHistory.canGoForward() : guest.canGoForward(),
        ...extra,
      });
    };
    guest.on('did-start-loading', () => emit('loading'));
    guest.on('did-stop-loading', () => emit('loaded'));
    guest.on('did-navigate', (_ev, url) => emit('navigate', { url }));
    guest.on('did-navigate-in-page', (_ev, url, isMainFrame) => {
      if (isMainFrame) emit('navigate', { url });
    });
    guest.on('page-title-updated', (_ev, title) => emit('title', { title }));
    guest.on('did-fail-load', (_ev, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = 用户主动中止，不是错误
      emit('fail', { url, error: `${desc}（${code}）` });
    });
    guest.on('render-process-gone', () => emit('fail', { error: '页面进程已退出，刷新可恢复' }));
    // 关掉 guest 时把它从 tabId 表里摘掉，避免 id 被复用时认错人
    guest.once('destroyed', () => {
      for (const [tid, wid] of tabGuests) if (wid === guest.id) tabGuests.delete(tid);
    });
  });

  win.on('closed', () => {
    tabGuests.clear();
    win = null;
  });
  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ==================== IPC 注册 ==================== */

function registerIpc() {
  /* 概览 */
  handle('app:info', (a) => a.info());

  /* 在线书源库 */
  handle('online:list', (a, opts) => a.onlineList(opts || {}));
  handle('online:get', (a, id) => a.onlineDownload(id));
  handle('online:install', (a, id, opts) => a.installFromOnline(id, opts || {}));
  /* 在线「更新 / 校验」（m04402） */
  handle('online:syncUpdates', (a, opts) => a.syncOnlineUpdates(opts || {}));
  handle('source:check', (a, opts) => a.checkSources(opts || {}));
  handle('probe:status', (a) => a.probeStatusMap());
  /* 线路（镜像站故障转移）：查看当前线路 / 强制重新探测 */
  handle('online:route', (a, opts) => a.onlineRoute(opts || {}));

  /* 订阅源（yckceo RSS） */
  handle('rss:onlineList', (a, opts) => a.onlineRssList(opts || {}));
  handle('rss:list', (a) => a.listRss());
  handle('rss:install', (a, id, opts) => a.installRssFromOnline(id, opts || {}));
  handle('rss:importText', (a, text, opts) => a.importRss(text, opts || {}));
  handle('rss:remove', (a, key) => ({ removed: a.removeRss(key) }));

  /* 本地书源 */
  handle('source:list', (a) => a.listSources());
  handle('source:add', (a, source, opts) => a.addSource(source, opts || {}));
  handle('source:test', (a, source, opts) => a.testSource(source, opts || {}));
  handle('source:remove', (a, key) => ({ removed: a.removeSource(key) }));
  handle('source:get', (a, key) => a.getSource(key));
  handle('source:export', (a, keys) => a.exportSources(keys));
  handle('source:importText', (a, text) => a.importSources(text));

  /* 搜索 */
  handle('search:one', (a, key, kw, page) => a.search(key, kw, page || 1));
  handle('search:all', (a, kw, keys, page) => a.searchAll(kw, keys, page || 1));
  /**
   * 全书源聚合搜索：每完成一个源就往前端推一次进度事件（增量返回），
   * 前端渲染时能「边搜边出」。返回最终聚合结果。
   */
  handle('search:everywhere', async (a, kw, opts = {}) => {
    const send = (ev) => { if (win && !win.isDestroyed()) win.webContents.send('search:event', ev); };
    return a.searchEverywhere(kw, {
      ...opts,
      onStart: (ev) => send({ type: 'start', ...ev }),
      onResult: (ev) => send({ type: 'result', ...ev }),
    });
  });
  handle('search:perf', (a, key) => a.sourcePerf(key));
  handle('search:resetPerf', (a) => ({ reset: a.resetSourcePerf() }));

  /* 书架与下载 */
  handle('shelf:list', (a) => a.shelf());
  handle('shelf:book', (a, id) => a.book(id));
  handle('shelf:remove', (a, id) => ({ removed: a.removeBook(id) }));
  handle('shelf:toc', (a, id) => a.toc(id));
  handle('shelf:add', (a, key, book, opts) => a.addToShelf(key, book, opts || {}));
  handle('shelf:download', (a, id, opts) => a.download(id, opts || {}));
  handle('shelf:downloadWindow', (a, id, index, opts) => a.downloadWindow(id, index, opts || {}));
  handle('shelf:windowBusy', (a, id) => ({ busy: a.windowBusy(id) }));
  handle('shelf:chapter', (a, id, index) => a.chapter(id, index));
  handle('shelf:progress', (a, id) => a.progress(id));
  handle('shelf:saveProgress', (a, id, p) => a.saveProgress(id, p));
  /* 换源：先给候选，再由用户挑一个换上 */
  handle('shelf:sourceCandidates', (a, id, opts) => a.sourceCandidates(id, opts || {}));
  handle('shelf:changeSource', (a, id, key, opts) => a.changeSource(id, key, opts || {}));

  /* 导出 */
  handle('export:book', (a, id, opts) => a.exportBook(id, opts || {}));
  handle('export:shelf', (a, opts) => a.exportShelf(opts || {}));
  handle('export:defaults', () => App.exportDefaults());

  /* 系统交互 */
  handle('dialog:openFile', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择书源 JSON 文件',
      filters: [{ name: '书源 JSON', extensions: ['json', 'txt'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true, files: [] };
    const fs = require('fs');
    return {
      canceled: false,
      files: r.filePaths.map((f) => ({ path: f, name: path.basename(f), text: fs.readFileSync(f, 'utf8') })),
    };
  });

  handle('dialog:saveFile', async (_a, defaultName, content) => {
    const r = await dialog.showSaveDialog(win, {
      title: '导出书源',
      defaultPath: defaultName || 'sources.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    require('fs').writeFileSync(r.filePath, content, 'utf8');
    return { canceled: false, path: r.filePath };
  });

  handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择导出目录', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    return { canceled: false, dir: r.filePaths[0] };
  });

  handle('shell:showItem', (_a, p) => {
    shell.showItemInFolder(p);
    return { done: true };
  });
  handle('shell:openExternal', (_a, url) => {
    shell.openExternal(url);
    return { done: true };
  });

  /* ==================== 内置浏览器 ====================
   * 只做「把用户送到站点官方页面 + 书签/历史」。
   * 没有、也不会有：正文抓取、付费墙绕过、页面内容落库。 */

  /** 预置站点表 + 合规文案（界面按钮与提示都从这里取） */
  handle('browser:listSites', () => ({ sites: listSites(), policy: POLICY }));

  /** 地址归一化（用户只敲 `qidian.com` 时补协议）。纯字符串处理，不联网。 */
  handle('browser:normalize', (_a, input) => {
    const url = normalizeInput(input);
    if (!url) return { ok: false, url: '', error: '请输入网址' };
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, url: '', error: '只支持 http/https 地址' };
    }
    return { ok: true, url };
  });

  /**
   * 标签 ↔ guest 绑定。界面创建 <webview> 后调用一次。
   * @param {string} tabId 界面侧的标签 id
   * @param {number} guestId webview 的 webContents id
   */
  handle('browser:bind', (_a, tabId, guestId) => {
    const t = String(tabId || '');
    const g = Number(guestId);
    if (!t || !Number.isFinite(g)) return { bound: false, reason: '缺少 tabId/guestId' };
    tabGuests.set(t, g);
    return { bound: true, tabId: t, guestId: g };
  });

  handle('browser:unbind', (_a, tabId) => {
    const t = String(tabId || '');
    return { removed: tabGuests.delete(t) };
  });

  /** 在指定标签里打开地址 */
  handle('browser:navigate', (_a, tabId, url) => {
    const wc = guestOf(tabId);
    if (!wc) return { ok: false, error: '标签页还没准备好' };
    const target = normalizeInput(url);
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: '只支持 http/https 地址' };
    wc.loadURL(target);
    return { ok: true, url: target };
  });

  /* 前进 / 后退 / 刷新 / 停止 / 回站点首页 */
  handle('browser:back', (_a, tabId) => {
    const wc = guestOf(tabId);
    if (!wc) return { ok: false };
    if (wc.navigationHistory) {
      if (!wc.navigationHistory.canGoBack()) return { ok: false, error: '已经是第一页' };
      wc.navigationHistory.goBack();
    } else {
      if (!wc.canGoBack()) return { ok: false, error: '已经是第一页' };
      wc.goBack();
    }
    return { ok: true };
  });

  handle('browser:forward', (_a, tabId) => {
    const wc = guestOf(tabId);
    if (!wc) return { ok: false };
    if (wc.navigationHistory) {
      if (!wc.navigationHistory.canGoForward()) return { ok: false, error: '已经是最后一页' };
      wc.navigationHistory.goForward();
    } else {
      if (!wc.canGoForward()) return { ok: false, error: '已经是最后一页' };
      wc.goForward();
    }
    return { ok: true };
  });

  handle('browser:reload', (_a, tabId, ignoreCache) => {
    const wc = guestOf(tabId);
    if (!wc) return { ok: false };
    if (ignoreCache) wc.reloadIgnoringCache();
    else wc.reload();
    return { ok: true };
  });

  handle('browser:stop', (_a, tabId) => {
    const wc = guestOf(tabId);
    if (wc) wc.stop();
    return { ok: true };
  });

  /** 取站点当前的地址/标题（界面切标签时同步一遍） */
  handle('browser:state', (_a, tabId) => {
    const wc = guestOf(tabId);
    if (!wc) return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
      canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
    };
  });

  /* ---- 书签 ---- */
  handle('browser:bookmarks', () => store().bookmarks());
  handle('browser:addBookmark', (_a, bm) => store().addBookmark(bm || {}));
  handle('browser:removeBookmark', (_a, url) => ({ removed: store().removeBookmark(url) }));
  handle('browser:renameBookmark', (_a, url, title) => ({ renamed: store().renameBookmark(url, title) }));
  handle('browser:clearBookmarks', () => ({ removed: store().clearBookmarks() }));

  /* ---- 历史 ---- */
  handle('browser:history', (_a, limit) => store().history(limit));
  handle('browser:pushHistory', (_a, h) => store().pushHistory(h || {}));
  handle('browser:clearHistory', () => ({ removed: store().clearHistory() }));

  /* ---- 会话（上次开的标签，重启后恢复） ---- */
  handle('browser:session', () => store().session());
  handle('browser:saveSession', (_a, tabs) => ({ saved: store().saveSession(tabs || []).length }));
  handle('browser:stats', () => store().stats());

  /** 用系统浏览器打开（内置视图里打不开的站点，给用户一个退路） */
  handle('browser:openExternal', (_a, url) => {
    const u = normalizeInput(url);
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: '只支持 http/https 地址' };
    shell.openExternal(u);
    return { ok: true };
  });
}

/* ==================== 生命周期 ==================== */

// 单实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    installGuestWebPreferences();
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
