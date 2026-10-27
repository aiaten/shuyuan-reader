'use strict';
/* 安卓版：把 capacitor-nodejs 的 EVENT_CHANNEL 适配成与 Electron preload 同形的 window.api。 */
/* 界面代码（app.js）基本不用改；安卓没有的能力（<webview> 内置浏览器、选目录）在这里降级。 */
/* 协议：发 invoke(id, channel, args[]) → 收 reply(id, {ok,data|error})；事件走 event(name, payload)。 */
(function () {
  var PLUGIN_WAIT_MS = 15000;
  var READY_WAIT_MS = 25000;
  var CALL_TIMEOUT_MS = 180000;

  var pending = new Map();
  var bus = { 'search:event': [], 'download:event': [], 'browser:event': [], 'browser:openTab': [] };
  var seq = 0;
  var ready = null;

  function capPlugin() {
    var cap = window.Capacitor;
    var plugins = cap && cap.Plugins;
    return (plugins && plugins.CapacitorNodeJS) || null;
  }

  function waitPlugin() {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function tick() {
        var p = capPlugin();
        if (p) return resolve(p);
        if (Date.now() - t0 > PLUGIN_WAIT_MS) return reject(new Error('原生桥未就绪（CapacitorNodeJS 插件没有加载）'));
        setTimeout(tick, 50);
      })();
    });
  }

  function onReply(args) {
    if (!args || !args.length) return;
    var id = args[0];
    var payload = args[1];
    var box = pending.get(id);
    if (!box) return;
    pending.delete(id);
    if (box.timer) clearTimeout(box.timer);
    if (payload && payload.ok) {
      box.resolve(payload.data);
    } else {
      var err = new Error((payload && payload.error) || '引擎出错');
      if (payload && payload.stack) err.stack = payload.stack;
      box.reject(err);
    }
  }

  function onEvent(args) {
    if (!args || !args.length) return;
    var name = args[0];
    var data = args.length > 1 ? args[1] : null;
    var list = bus[name];
    if (!list) return;
    list.slice().forEach(function (fn) {
      try { fn(data); } catch (e) { console.error('[api] event handler failed: ' + name, e); }
    });
  }

  function ensureReady() {
    if (ready) return ready;
    ready = waitPlugin().then(function (p) {
      p.addListener('reply', function (data) { onReply(data && data.args); });
      p.addListener('event', function (data) { onEvent(data && data.args); });
      var wait = p.whenReady ? p.whenReady() : Promise.resolve();
      return Promise.race([wait, new Promise(function (r) { setTimeout(r, READY_WAIT_MS); })]);
    }).then(function () {
      return capPlugin();
    });
    return ready;
  }

  function invoke(channel, args) {
    return ensureReady().then(function (p) {
      return new Promise(function (resolve, reject) {
        var id = 'q' + (++seq);
        var timer = setTimeout(function () {
          pending.delete(id);
          reject(new Error('引擎没有响应：' + channel + ' 超时'));
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        try {
          p.send({ eventName: 'invoke', args: [id, channel, args || []] }).catch(function (e) {
            var box = pending.get(id);
            if (!box) return;
            pending.delete(id);
            clearTimeout(box.timer);
            box.reject(e instanceof Error ? e : new Error(String(e)));
          });
        } catch (e) {
          var b2 = pending.get(id);
          if (b2) { pending.delete(id); clearTimeout(b2.timer); }
          reject(e);
        }
      });
    });
  }

  function subscribe(name, cb) {
    var list = bus[name];
    if (!list || typeof cb !== 'function') return function () {};
    list.push(cb);
    return function () {
      var i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /* ---------- 系统交互（安卓降级） ---------- */

  function mkPick(list, canceled) {
    var arr = list.slice();
    arr.canceled = !!canceled;
    arr.files = arr;
    arr.paths = arr.map(function (f) { return f.path; });
    return arr;
  }

  /* 安卓没有系统文件对话框：用 <input type=file> + FileReader，返回 {canceled, files:[{path,name,text}]} */
  /* 同时把 canceled/files 挂在数组上，兼容两种调用方（一份等数组、一份等对象）。 */
  function pickFiles() {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.json,.txt,application/json,text/plain';
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      var done = false;
      function finish(arr) {
        if (done) return;
        done = true;
        try { input.remove(); } catch (_) {}
        resolve(arr);
      }
      input.onchange = function () {
        var fs = Array.prototype.slice.call(input.files || []);
        if (!fs.length) return finish(mkPick([], true));
        var left = fs.length;
        var out = new Array(fs.length);
        fs.forEach(function (f, idx) {
          var fr = new FileReader();
          fr.onload = function () {
            out[idx] = { path: f.name, name: f.name, text: String(fr.result || '') };
            if (--left === 0) finish(mkPick(out, false));
          };
          fr.onerror = function () {
            out[idx] = { path: f.name, name: f.name, text: '' };
            if (--left === 0) finish(mkPick(out, false));
          };
          fr.readAsText(f, 'utf-8');
        });
      };
      window.addEventListener('focus', function onFocus() {
        window.removeEventListener('focus', onFocus);
        setTimeout(function () {
          if (!done && !(input.files && input.files.length)) finish(mkPick([], true));
        }, 900);
      });
      input.click();
    });
  }

  /* 安卓没法选目录：统一落到引擎的 <数据目录>/export */
  function pickDir() {
    return invoke('app:paths').then(function (p) {
      return { canceled: false, dir: (p && p.exportDir) || '' };
    }).catch(function () {
      return { canceled: false, dir: '' };
    });
  }

  /* 用系统浏览器打开：Capacitor 的 shouldOverrideUrlLoading 会把外部地址交给 ACTION_VIEW， */
  /* 返回 true 取消 WebView 内部导航，所以主界面不会被替换掉。 */
  function openExternal(url) {
    var u = String(url || '').trim();
    if (!/^https?:/i.test(u)) return Promise.resolve({ done: true, skipped: true });
    try {
      var a = document.createElement('a');
      a.href = u;
      a.target = '_self';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      try { window.location.assign(u); } catch (_) {}
    }
    return Promise.resolve({ done: true });
  }

  /* ---------- 对外的 window.api ---------- */

  var NO_WEBVIEW = '安卓版没有内置浏览器，已用系统浏览器打开';

  var api = {
    /* 概览 */
    info: function () { return invoke('app:info'); },

    /* 在线书源库 */
    onlineList: function (opts) { return invoke('online:list', [opts]); },
    onlineGet: function (id) { return invoke('online:get', [id]); },
    onlineInstall: function (id, opts) { return invoke('online:install', [id, opts]); },
    onlineSyncUpdates: function (opts) { return invoke('online:syncUpdates', [opts]); },
    sourceCheck: function (opts) { return invoke('source:check', [opts]); },
    probeStatus: function () { return invoke('probe:status'); },
    onlineRoute: function (opts) { return invoke('online:route', [opts]); },

    /* 本地书源 */
    sourceList: function () { return invoke('source:list'); },
    sourceAdd: function (source, opts) { return invoke('source:add', [source, opts]); },
    sourceTest: function (source, opts) { return invoke('source:test', [source, opts]); },
    sourceRemove: function (key) { return invoke('source:remove', [key]); },
    sourceGet: function (key) { return invoke('source:get', [key]); },
    sourceExport: function (keys) { return invoke('source:export', [keys]); },
    sourceImportText: function (text) { return invoke('source:importText', [text]); },
    autogenSource: function (url, opts) { return invoke('source:autogen', [url, opts || {}]); },

    /* 订阅源 */
    rssOnlineList: function (opts) { return invoke('rss:onlineList', [opts]); },
    rssList: function () { return invoke('rss:list'); },
    rssInstall: function (id, opts) { return invoke('rss:install', [id, opts]); },
    rssImportText: function (text, opts) { return invoke('rss:importText', [text, opts]); },
    rssRemove: function (key) { return invoke('rss:remove', [key]); },

    /* 搜索 */
    searchOne: function (key, kw, page) { return invoke('search:one', [key, kw, page]); },
    searchAll: function (kw, keys, page, opts) { return invoke('search:all', [kw, keys, page, opts]); },
    searchEverywhere: function (kw, opts) { return invoke('search:everywhere', [kw, opts]); },
    sourcePerf: function (key) { return invoke('search:perf', [key]); },
    resetSourcePerf: function () { return invoke('search:resetPerf'); },
    onSearchEvent: function (cb) { return subscribe('search:event', cb); },

    /* 书架 */
    shelf: function () { return invoke('shelf:list'); },
    book: function (id) { return invoke('shelf:book', [id]); },
    removeBook: function (id) { return invoke('shelf:remove', [id]); },
    toc: function (id) { return invoke('shelf:toc', [id]); },
    addToShelf: function (key, book, opts) { return invoke('shelf:add', [key, book, opts]); },
    download: function (id, opts) { return invoke('shelf:download', [id, opts]); },
    downloadWindow: function (id, index, opts) { return invoke('shelf:downloadWindow', [id, index, opts]); },
    enqueueDownload: function (id, opts) { return invoke('download:enqueue', [id, opts]); },
    listDownloads: function () { return invoke('download:list'); },
    cancelDownload: function (jobId) { return invoke('download:cancel', [jobId]); },
    pauseDownload: function (jobId) { return invoke('download:pause', [jobId]); },
    resumeDownload: function (jobId) { return invoke('download:resume', [jobId]); },
    clearFinishedDownloads: function () { return invoke('download:clear'); },
    onDownloadEvent: function (cb) { return subscribe('download:event', cb); },
    windowBusy: function (id) { return invoke('shelf:windowBusy', [id]); },
    chapter: function (id, index) { return invoke('shelf:chapter', [id, index]); },
    progress: function (id) { return invoke('shelf:progress', [id]); },
    saveProgress: function (id, p) { return invoke('shelf:saveProgress', [id, p]); },
    sourceCandidates: function (id, opts) { return invoke('shelf:sourceCandidates', [id, opts]); },
    changeSource: function (id, key, opts) { return invoke('shelf:changeSource', [id, key, opts]); },
    checkUpdates: function (opts) { return invoke('shelf:checkUpdates', [opts]); },
    checkBook: function (id, opts) { return invoke('shelf:checkBook', [id, opts]); },

    /* 导出 */
    exportBook: function (id, opts) { return invoke('export:book', [id, opts]); },
    exportShelf: function (opts) { return invoke('export:shelf', [opts]); },
    exportDefaults: function () { return invoke('export:defaults'); },

    /* 系统 */
    pickFiles: pickFiles,
    saveFile: function (name, content) { return invoke('dialog:saveFile', [name, content]); },
    pickDir: pickDir,
    showInFolder: function (p) { return invoke('shell:showItem', [p]); },
    openExternal: function (url) { return openExternal(url); },

    /* 内置浏览器：安卓没有 <webview>，书签/历史/会话保留，导航交给系统浏览器 */
    browser: {
      hasWebview: false,
      listSites: function () { return invoke('browser:listSites'); },
      normalize: function (input) { return invoke('browser:normalize', [input]); },
      bind: function () { return Promise.resolve({ bound: false }); },
      unbind: function () { return Promise.resolve({ unbound: false }); },
      navigate: function (tabId, url) {
        return openExternal(url).then(function () {
          return { ok: true, external: true, note: NO_WEBVIEW };
        });
      },
      back: function () { return Promise.resolve({ ok: false, note: NO_WEBVIEW }); },
      forward: function () { return Promise.resolve({ ok: false, note: NO_WEBVIEW }); },
      reload: function () { return Promise.resolve({ ok: false, note: NO_WEBVIEW }); },
      stop: function () { return Promise.resolve({ ok: true }); },
      state: function () {
        return Promise.resolve({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false });
      },
      bookmarks: function () { return invoke('browser:bookmarks'); },
      addBookmark: function (bm) { return invoke('browser:addBookmark', [bm]); },
      removeBookmark: function (url) { return invoke('browser:removeBookmark', [url]); },
      renameBookmark: function (url, title) { return invoke('browser:renameBookmark', [url, title]); },
      clearBookmarks: function () { return invoke('browser:clearBookmarks'); },
      history: function (limit) { return invoke('browser:history', [limit]); },
      pushHistory: function (h) { return invoke('browser:pushHistory', [h]); },
      clearHistory: function () { return invoke('browser:clearHistory'); },
      session: function () { return invoke('browser:session'); },
      saveSession: function (tabs) { return invoke('browser:saveSession', [tabs]); },
      stats: function () { return invoke('browser:stats'); },
      openInSystem: function (url) { return openExternal(url); },
      onEvent: function () { return function () {}; },
      onOpenTab: function () { return function () {}; }
    }
  };

  api.__android = true;
  api.__ready = function () { return ensureReady(); };
  window.api = api;
  window.__apiBridge = { invoke: invoke, subscribe: subscribe, openExternal: openExternal };
}());
