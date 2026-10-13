'use strict';
/**
 * 预加载脚本：在隔离上下文中安全地把 IPC 暴露成 window.api。
 * 渲染进程只拿到这些方法，拿不到 Node / electron 模块。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 统一调用：主进程返回 {ok, data, error} */
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r) throw new Error('主进程没有响应：' + channel);
  if (!r.ok) {
    const err = new Error(r.error || '未知错误');
    err.channel = channel;
    throw err;
  }
  return r.data;
}

contextBridge.exposeInMainWorld('api', {
  /* 概览 */
  info: () => call('app:info'),

  /* 在线书源库 */
  onlineList: (opts) => call('online:list', opts),
  onlineGet: (id) => call('online:get', id),
  onlineInstall: (id, opts) => call('online:install', id, opts),
  /* 在线「更新 / 校验」（m04402） */
  onlineSyncUpdates: (opts) => call('online:syncUpdates', opts),
  sourceCheck: (opts) => call('source:check', opts),
  /** 探测状态表：{ urlKey: {allowed, reason, score, at} }（在线列表标红用） */
  probeStatus: () => call('probe:status'),
  /** 在线线路（镜像站）：{shuyuan, rss, candidates}；opts.retry=true 强制重探 */
  onlineRoute: (opts) => call('online:route', opts),

  /* 本地书源 */
  sourceList: () => call('source:list'),
  sourceAdd: (source, opts) => call('source:add', source, opts),
  sourceTest: (source, opts) => call('source:test', source, opts),
  sourceRemove: (key) => call('source:remove', key),
  sourceGet: (key) => call('source:get', key),
  sourceExport: (keys) => call('source:export', keys),
  sourceImportText: (text) => call('source:importText', text),

  /* 订阅源（yckceo RSS） */
  rssOnlineList: (opts) => call('rss:onlineList', opts),
  rssList: () => call('rss:list'),
  rssInstall: (id, opts) => call('rss:install', id, opts),
  rssImportText: (text, opts) => call('rss:importText', text, opts),
  rssRemove: (key) => call('rss:remove', key),

  /* 搜索 */
  searchOne: (key, kw, page) => call('search:one', key, kw, page),
  searchAll: (kw, keys, page) => call('search:all', kw, keys, page),
  /** 全书源聚合搜索（并发 + 增量 + 熔断）；onEvent 收到每个源的进度 */
  searchEverywhere: (kw, opts) => call('search:everywhere', kw, opts),
  sourcePerf: (key) => call('search:perf', key),
  resetSourcePerf: () => call('search:resetPerf'),
  /** 订阅单个源搜索进度事件（返回取消订阅函数） */
  onSearchEvent: (cb) => {
    const fn = (_e, ev) => cb(ev);
    ipcRenderer.on('search:event', fn);
    return () => ipcRenderer.removeListener('search:event', fn);
  },

  /* 书架 */
  shelf: () => call('shelf:list'),
  book: (id) => call('shelf:book', id),
  removeBook: (id) => call('shelf:remove', id),
  toc: (id) => call('shelf:toc', id),
  addToShelf: (key, book, opts) => call('shelf:add', key, book, opts),
  download: (id, opts) => call('shelf:download', id, opts),
  /** 懒加载：读到第 index 章时把后面若干章下下来（同一本书同时只跑一个） */
  downloadWindow: (id, index, opts) => call('shelf:downloadWindow', id, index, opts),
  windowBusy: (id) => call('shelf:windowBusy', id),
  chapter: (id, index) => call('shelf:chapter', id, index),
  progress: (id) => call('shelf:progress', id),
  saveProgress: (id, p) => call('shelf:saveProgress', id, p),
  /** 换源：列出其他书源上同一本书的候选 */
  sourceCandidates: (id, opts) => call('shelf:sourceCandidates', id, opts),
  /** 换源：把这本书切到指定书源（默认保留阅读进度、不迁移旧正文） */
  changeSource: (id, key, opts) => call('shelf:changeSource', id, key, opts),

  /* 导出 */
  exportBook: (id, opts) => call('export:book', id, opts),
  exportShelf: (opts) => call('export:shelf', opts),
  exportDefaults: () => call('export:defaults'),

  /* 系统 */
  pickFiles: () => call('dialog:openFile'),
  saveFile: (name, content) => call('dialog:saveFile', name, content),
  pickDir: () => call('dialog:pickDir'),
  showInFolder: (p) => call('shell:showItem', p),
  openExternal: (url) => call('shell:openExternal', url),

  /* ==================== 内置浏览器 ====================
   * 只做「把用户送到站点官方页面 + 书签/历史」，不抓正文、不绕付费墙。 */
  browser: {
    /** 预置站点表 + 合规文案 */
    listSites: () => call('browser:listSites'),
    /** 地址归一化（`qidian.com` → `https://qidian.com`） */
    normalize: (input) => call('browser:normalize', input),

    /* 标签 ↔ webview guest 绑定 */
    bind: (tabId, guestId) => call('browser:bind', tabId, guestId),
    unbind: (tabId) => call('browser:unbind', tabId),

    /* 导航 */
    navigate: (tabId, url) => call('browser:navigate', tabId, url),
    back: (tabId) => call('browser:back', tabId),
    forward: (tabId) => call('browser:forward', tabId),
    reload: (tabId, ignoreCache) => call('browser:reload', tabId, ignoreCache),
    stop: (tabId) => call('browser:stop', tabId),
    state: (tabId) => call('browser:state', tabId),

    /* 书签 */
    bookmarks: () => call('browser:bookmarks'),
    addBookmark: (bm) => call('browser:addBookmark', bm),
    removeBookmark: (url) => call('browser:removeBookmark', url),
    renameBookmark: (url, title) => call('browser:renameBookmark', url, title),
    clearBookmarks: () => call('browser:clearBookmarks'),

    /* 历史 */
    history: (limit) => call('browser:history', limit),
    pushHistory: (h) => call('browser:pushHistory', h),
    clearHistory: () => call('browser:clearHistory'),

    /* 会话（上次开的标签，下次进浏览器页签接上） */
    session: () => call('browser:session'),
    saveSession: (tabs) => call('browser:saveSession', tabs),
    stats: () => call('browser:stats'),

    /** 用系统浏览器打开（内置视图打不开时的退路） */
    openInSystem: (url) => call('browser:openExternal', url),

    /** 订阅页面内导航事件（地址栏/前进后退跟着走）；返回取消订阅函数 */
    onEvent: (cb) => {
      const fn = (_e, ev) => cb(ev);
      ipcRenderer.on('browser:event', fn);
      return () => ipcRenderer.removeListener('browser:event', fn);
    },
    /** 站点里 target=_blank 想开新标签时收到通知 */
    onOpenTab: (cb) => {
      const fn = (_e, ev) => cb(ev);
      ipcRenderer.on('browser:openTab', fn);
      return () => ipcRenderer.removeListener('browser:openTab', fn);
    },
  },
});
