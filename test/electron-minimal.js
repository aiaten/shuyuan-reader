'use strict';
// 最小 Electron 主进程自检：确认 Electron 能在本机启动并写出文件。
// 结果写到 process.env.SMOKE_OUT 指向的文件（Windows 上 Electron 的 stdout 拿不到）。
const fs = require('fs');
const out = process.env.SMOKE_OUT || 'minimal-electron-out.json';

function write(obj) {
  try {
    fs.writeFileSync(out, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) {
    /* ignore */
  }
}

let electronApi = null;
try {
  electronApi = require('electron');
} catch (e) {
  write({ stage: 'require', error: e.message });
  process.exit(2);
}

if (typeof electronApi !== 'object' || !electronApi.app) {
  write({
    stage: 'require',
    error: 'require("electron") 没返回 API 对象',
    gotType: typeof electronApi,
    gotValue: String(electronApi).slice(0, 200),
    runAsNode: process.env.ELECTRON_RUN_AS_NODE || null,
    argv: process.argv.slice(0, 5),
  });
  process.exit(3);
}

const { app, BrowserWindow } = electronApi;

write({
  stage: 'loaded',
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  argv: process.argv.slice(0, 5),
});

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      width: 600,
      height: 400,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    await win.loadURL('data:text/html,<h1>ok</h1>');
    const title = await win.webContents.executeJavaScript('document.body.innerText', true);
    write({
      stage: 'window',
      ok: true,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      bodyText: title,
      windowCount: BrowserWindow.getAllWindows().length,
    });
    app.exit(0);
  })
  .catch((e) => {
    write({ stage: 'whenReady', error: e.message, stack: e.stack });
    app.exit(4);
  });
