'use strict';
/**
 * Electron 主进程：把 src/app.js 的门面通过 IPC 暴露给渲染进程。
 * 所有业务逻辑都在 src/ 里，本文件只做窗口管理与 IPC 转发。
 */

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');

const { App } = require('../src/app');

let win = null;
let facade = null;

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
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
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
