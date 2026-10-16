'use strict';
/**
 * 渲染进程主逻辑：视图切换 + 与 window.api（preload 暴露）交互。
 * 不直接做网络/文件访问，全部走主进程。
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------------- 阅读设置（字体样式 / 字号 / 行距 / 页宽） ---------------- */

/**
 * 阅读偏好存 localStorage：纯前端显示设置，不进数据目录、不影响导出。
 * 通过 CSS 变量下发到 .reader-body .paper（见 style.css 的 var(--reader-*)）。
 */
const READER_PREF_KEY = 'shuyuan.readerPref';

/** 字体样式预设：value 是 CSS font-family，label 给用户看 */
const READER_FONTS = [
  { value: '', label: '跟随系统' },
  { value: '"Microsoft YaHei", "PingFang SC", sans-serif', label: '微软雅黑（默认无衬线）' },
  { value: '"Source Han Serif SC", "Songti SC", SimSun, serif', label: '宋体（衬线，传统阅读）' },
  { value: 'KaiTi, "Kaiti SC", STKaiti, serif', label: '楷体' },
  { value: 'FangSong, "FangSong SC", STFangsong, serif', label: '仿宋' },
  { value: '"Noto Sans Mono CJK SC", Consolas, monospace', label: '等宽' },
  { value: 'Arial, "Helvetica Neue", sans-serif', label: '西文无衬线' },
];

const READER_PREF_DEFAULT = {
  fontSize: 17,      // px，正文 14–30
  lineHeight: 2.05,  // 倍数 1.4–3.0
  fontFamily: '',    // '' = 跟随系统
  pageWidth: 760,    // px 正文栏宽 560–1200
};

let readerPref = Object.assign({}, READER_PREF_DEFAULT);

/** 读磁盘里的偏好，逐字段校验（脏数据一律回落到默认值，不让一条坏值毁掉整个阅读界面） */
function readReaderPref() {
  try {
    const raw = JSON.parse(localStorage.getItem(READER_PREF_KEY) || '{}') || {};
    const clamp = (v, lo, hi, def) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    const fam = typeof raw.fontFamily === 'string' && READER_FONTS.some((f) => f.value === raw.fontFamily)
      ? raw.fontFamily
      : '';
    return {
      fontSize: Math.round(clamp(raw.fontSize, 14, 30, READER_PREF_DEFAULT.fontSize)),
      lineHeight: Math.round(clamp(raw.lineHeight, 1.4, 3, READER_PREF_DEFAULT.lineHeight) * 100) / 100,
      fontFamily: fam,
      pageWidth: Math.round(clamp(raw.pageWidth, 560, 1200, READER_PREF_DEFAULT.pageWidth)),
    };
  } catch {
    return Object.assign({}, READER_PREF_DEFAULT);
  }
}

/** 把偏好写进 CSS 变量（立即生效，不用重渲染正文） */
function applyReaderPref() {
  const s = document.documentElement.style;
  s.setProperty('--reader-font-size', readerPref.fontSize + 'px');
  s.setProperty('--reader-line-height', String(readerPref.lineHeight));
  s.setProperty('--reader-font-family', readerPref.fontFamily || 'inherit');
  s.setProperty('--reader-page-width', readerPref.pageWidth + 'px');
}

function saveReaderPref() {
  if (!writePref(READER_PREF_KEY, JSON.stringify(readerPref))) {
    toast('阅读设置已应用，但保存失败', 'err');
  }
}

/** 阅读设置对话框：即改即生效（不用点确定），关掉对话框设置也留着 */
function readerSettingsDialog() {
  const rows = [];
  const fontOpts = READER_FONTS
    .map((f) => `<option value="${esc(f.value)}"${f.value === readerPref.fontFamily ? ' selected' : ''}>${esc(f.label)}</option>`)
    .join('');
  rows.push(`
    <div class="rs-row">
      <label class="rs-label" for="rsFont">字体样式</label>
      <select class="input select rs-ctl" id="rsFont">${fontOpts}</select>
    </div>`);
  rows.push(`
    <div class="rs-row">
      <label class="rs-label" for="rsSize">字体大小</label>
      <input class="rs-range" id="rsSize" type="range" min="14" max="30" step="1" value="${readerPref.fontSize}" />
      <span class="rs-val" id="rsSizeVal">${readerPref.fontSize} px</span>
    </div>`);
  rows.push(`
    <div class="rs-row">
      <label class="rs-label" for="rsLine">行距</label>
      <input class="rs-range" id="rsLine" type="range" min="1.4" max="3" step="0.05" value="${readerPref.lineHeight}" />
      <span class="rs-val" id="rsLineVal">${readerPref.lineHeight}</span>
    </div>`);
  rows.push(`
    <div class="rs-row">
      <label class="rs-label" for="rsWidth">页宽</label>
      <input class="rs-range" id="rsWidth" type="range" min="560" max="1200" step="20" value="${readerPref.pageWidth}" />
      <span class="rs-val" id="rsWidthVal">${readerPref.pageWidth} px</span>
    </div>`);
  rows.push(`
    <div class="rs-preview" id="rsPreview">
      <div class="rs-preview-in">床前明月光，疑是地上霜。举头望明月，低头思故乡。</div>
    </div>`);

  modal({
    title: '阅读设置',
    body: rows.join(''),
    buttons: [
      { text: '恢复默认', onClick: () => {
          readerPref = Object.assign({}, READER_PREF_DEFAULT);
          saveReaderPref();
          applyReaderPref();
          closeModal();
          readerSettingsDialog();
          toast('已恢复默认设置', 'ok');
        } },
      { text: '关闭', class: 'primary', onClick: closeModal },
    ],
  });

  // 改完立即生效：拖动滑块时正文与预览同步变化
  const sync = () => {
    applyReaderPref();
    const pv = $('#rsPreview .rs-preview-in');
    if (pv) {
      pv.style.fontSize = readerPref.fontSize + 'px';
      pv.style.lineHeight = String(readerPref.lineHeight);
      pv.style.fontFamily = readerPref.fontFamily || 'inherit';
    }
  };
  $('#rsFont').onchange = (e) => { readerPref.fontFamily = e.target.value; saveReaderPref(); sync(); };
  $('#rsSize').oninput = (e) => {
    readerPref.fontSize = Number(e.target.value);
    $('#rsSizeVal').textContent = readerPref.fontSize + ' px';
    saveReaderPref(); sync();
  };
  $('#rsLine').oninput = (e) => {
    readerPref.lineHeight = Number(e.target.value);
    $('#rsLineVal').textContent = String(readerPref.lineHeight);
    saveReaderPref(); sync();
  };
  $('#rsWidth').oninput = (e) => {
    readerPref.pageWidth = Number(e.target.value);
    $('#rsWidthVal').textContent = readerPref.pageWidth + ' px';
    saveReaderPref(); sync();
  };
  sync();
}

/* ---------------- 主题（日间 / 夜间） ---------------- */

const THEME_KEY = 'shuyuan.theme'; // 'shuyuan.' 前缀对齐项目其它本地存储键
const THEME_DARK_Q = window.matchMedia('(prefers-color-scheme: dark)');

/** 读用户手动选择；只有 'light'/'dark' 才算数，脏数据当没存过 */
function readSavedTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch (e) {
    // 隐私模式/配额异常下 localStorage 可能直接抛，这里不能把整个脚本带崩
    console.warn('读取主题设置失败', e);
    return null;
  }
}

/** 未手动选择时跟随系统；一旦有保存值就以保存值为准 */
function preferredTheme() {
  return readSavedTheme() || (THEME_DARK_Q.matches ? 'dark' : 'light');
}

function applyTheme(theme, announce) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#btnTheme');
  // 按「点下去会变成什么」来写文案，比按当前状态写更好点
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀️ 日间' : '🌙 夜间';
    btn.title = theme === 'dark' ? '切换到日间模式（Alt+T）' : '切换到夜间模式（Alt+T）';
  }
  if (announce) toast(theme === 'dark' ? '已切换到夜间模式' : '已切换到日间模式', 'ok');
}

/** 手动切换：写盘后从此不再跟随系统 */
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (e) {
    toast('主题已切换，但保存失败（下次启动会恢复）', 'err');
  }
  applyTheme(next, true);
}

/** 系统主题变化：仅用户没手动选过时跟随，选过就不打扰 */
function onSystemThemeChange() {
  const saved = readSavedTheme();
  if (saved) return;
  applyTheme(preferredTheme(), false);
}

// 尽早落主题：脚本在 </body> 前同步执行，早于首帧绘制。
// 无保存值时跟随系统，并挂上监听（addEventListener 在老 Electron 上可能没有，退回 addListener）
if (THEME_DARK_Q.addEventListener) THEME_DARK_Q.addEventListener('change', onSystemThemeChange);
else THEME_DARK_Q.addListener(onSystemThemeChange);

applyTheme(preferredTheme(), false);

/* ---------------- 通用 UI 工具 ---------------- */

let busyCount = 0;
function busy(on, text) {
  busyCount += on ? 1 : -1;
  if (busyCount < 0) busyCount = 0;
  $('#busy').classList.toggle('show', busyCount > 0);
  if (text) $('#busyText').textContent = text;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 6000 : 3200);
}

/** 统一的异步调用包装：自动 busy + 错误 toast */
async function run(label, fn) {
  busy(true, label || '处理中…');
  try {
    return await fn();
  } catch (e) {
    toast(e && e.message ? e.message : String(e), 'err');
    console.error(label, e);
    return null;
  } finally {
    busy(false);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 模态框 */
function modal({ title, body, buttons = [] }) {
  $('#modalTitle').textContent = title || '';
  $('#modalBody').innerHTML = body || '';
  const foot = $('#modalFoot');
  foot.innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (b.class || '');
    btn.textContent = b.text;
    btn.onclick = b.onClick || (() => closeModal());
    if (b.id) btn.id = b.id;
    if (b.disabled) btn.disabled = true;
    foot.appendChild(btn);
  }
  $('#modalMask').classList.add('show');
}
function closeModal() {
  $('#modalMask').classList.remove('show');
  $('#modalBody').innerHTML = '';
}
$('#modalClose').onclick = closeModal;
$('#modalMask').onclick = (e) => {
  if (e.target === $('#modalMask')) closeModal();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

/** 数字输入小弹窗；确认返回数字，取消返回 null */
function pickNumber(title, def) {
  return new Promise((resolve) => {
    modal({
      title,
      body: `<input class="input" id="pickNumInput" type="number" min="1" max="90" value="${def}" style="width:120px" /> <span class="hint">天</span>`,
      buttons: [
        { text: '确定', class: 'primary', onClick: () => { const v = parseInt($('#pickNumInput').value, 10); closeModal(); resolve(Number.isFinite(v) && v > 0 ? v : def); } },
        { text: '取消', onClick: () => { closeModal(); resolve(null); } },
      ],
    });
    const inp = $('#pickNumInput');
    if (inp) { inp.focus(); inp.select(); }
  });
}

/* ---------------- 视图切换 ---------------- */

const loaders = {
  shelf: loadShelf,
  sources: loadSources,
  online: () => { loadOnline(); loadRoute(false); },
  browser: loadBrowser,
};

function switchView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (loaders[name]) loaders[name]();
}

$$('.tab').forEach((t) => (t.onclick = () => switchView(t.dataset.view)));

/* ==================== 书架 ==================== */

let shelfCache = [];

/**
 * 书架查看方式：list（列表，默认）/ grid（图标）。
 * 与主题一样存 localStorage——这是纯界面前端偏好，不该污染数据目录。
 */
const SHELF_LAYOUT_KEY = 'shuyuan.shelfLayout';
const SHELF_SORT_KEY = 'shuyuan.shelfSort';

function readPref(key, valid, fallback) {
  try {
    const v = localStorage.getItem(key);
    return valid.includes(v) ? v : fallback;
  } catch { return fallback; }
}

function writePref(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

let shelfLayout = readPref(SHELF_LAYOUT_KEY, ['list', 'grid'], 'list');
let shelfSort = readPref(SHELF_SORT_KEY, ['added', 'name', 'author', 'progress'], 'added');

/** 排序键：把书架列表按当前排序方式重排（不改动 shelfCache 本体） */
function sortShelf(list) {
  const arr = list.slice();
  if (shelfSort === 'name') {
    arr.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
  } else if (shelfSort === 'author') {
    arr.sort((a, b) => String(a.author || '').localeCompare(String(b.author || ''), 'zh'));
  } else if (shelfSort === 'progress') {
    // 读完的沉底，其余按已下载章节数从多到少
    arr.sort((a, b) => {
      const ta = a.chapterCount || 0;
      const tb = b.chapterCount || 0;
      const fa = ta && a.downloadedCount === ta ? 1 : 0;
      const fb = tb && b.downloadedCount === tb ? 1 : 0;
      if (fa !== fb) return fa - fb;
      return (b.downloadedCount || 0) - (a.downloadedCount || 0);
    });
  } else {
    // added：新加入的在前（created 缺失时退化为原顺序）
    arr.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
  }
  return arr;
}

/** 应用查看方式：给列表容器加/去 .grid，并同步分段控件高亮 */
function applyShelfLayout() {
  $('#shelfList').classList.toggle('grid', shelfLayout === 'grid');
  $$('#shelfLayout .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.layout === shelfLayout));
}

async function loadShelf() {
  const books = (await run('读取书架…', () => window.api.shelf())) || [];
  shelfCache = books;
  renderShelf();
}

function renderShelf() {
  applyShelfLayout();
  const kw = $('#filterShelf').value.trim();
  const filtered = kw ? shelfCache.filter((b) => (b.name || '').includes(kw) || (b.author || '').includes(kw)) : shelfCache;
  const list = sortShelf(filtered);
  const box = $('#shelfList');
  if (!list.length) {
    box.innerHTML = `<p class="empty">${shelfCache.length ? '没有匹配的书籍' : '书架是空的<br/>去「搜索」里找一本书加入书架吧'}</p>`;
    return;
  }
  box.innerHTML = '';
  const grid = shelfLayout === 'grid';
  for (const b of list) {
    const total = b.chapterCount || 0;
    const got = b.downloadedCount || 0;
    const pct = total ? Math.round((got / total) * 100) : 0;
    const el = document.createElement('div');
    el.className = 'card';
    // 图标模式多一行封面位（用书名首字占位，不联网取图）
    const cover = grid ? `<div class="cover">${esc(String(b.name || '书').trim().slice(0, 1))}</div>` : '';
    el.innerHTML = `
      ${cover}
      <div class="card-main">
        <div class="card-title">${esc(b.name)}</div>
        <div class="card-sub">
          ${b.author ? esc(b.author) : '<i>未知作者</i>'}
          <span class="badge info">${esc(b.sourceName || '')}</span>
          <span class="badge ${got && got === total ? 'ok' : ''}">${got}/${total} 章</span>
        </div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>
      <div class="card-actions">
        <button class="btn primary" data-act="read">阅读</button>
        <button class="btn" data-act="download">下载</button>
        <button class="btn" data-act="switch">换源</button>
        <button class="btn" data-act="export">导出TXT</button>
        <button class="btn danger" data-act="remove">移除</button>
      </div>`;
    el.querySelector('[data-act=read]').onclick = () => openReader(b.id);
    el.querySelector('[data-act=download]').onclick = () => downloadDialog(b);
    el.querySelector('[data-act=switch]').onclick = () => switchSourceDialog(b);
    el.querySelector('[data-act=export]').onclick = () => exportDialog(b);
    el.querySelector('[data-act=remove]').onclick = () => {
      modal({
        title: '确认移除',
        body: `<p>确定要把《${esc(b.name)}》从书架移除吗？<br/>本地已下载的 ${got} 章正文也会一并删除。</p>`,
        buttons: [
          { text: '取消', onClick: closeModal },
          {
            text: '移除',
            class: 'danger',
            onClick: async () => {
              closeModal();
              const r = await run('移除中…', () => window.api.removeBook(b.id));
              if (r) {
                toast('已移除', 'ok');
                loadShelf();
              }
            },
          },
        ],
      });
    };
    box.appendChild(el);
  }
}

$('#filterShelf').oninput = renderShelf;
$('#btnRefreshShelf').onclick = loadShelf;

/* 查看方式：列表 / 图标（只重渲染，不重新读书架） */
$$('#shelfLayout .seg-btn').forEach((btn) => {
  btn.onclick = () => {
    shelfLayout = btn.dataset.layout;
    if (!writePref(SHELF_LAYOUT_KEY, shelfLayout)) toast('已切换查看方式，但保存失败', 'err');
    renderShelf();
  };
});

$('#shelfSort').onchange = (e) => {
  shelfSort = e.target.value;
  writePref(SHELF_SORT_KEY, shelfSort);
  renderShelf();
};

/* ==================== 换源（书架 → 其他书源） ==================== */

/** 匹配度分数 → 界面上的置信标签。分数含义见 src/app.js 的 _pickBestCandidate */
function matchTag(score) {
  if (score >= 100) return { cls: 'ok', text: '书名+作者一致' };
  if (score >= 85) return { cls: 'ok', text: '书名+作者近似' };
  if (score >= 60) return { cls: 'warn', text: '仅书名一致' };
  if (score > 0) return { cls: 'warn', text: '书名近似' };
  return { cls: 'err', text: '低置信' };
}

/**
 * 换源对话框：先并发搜出「其他书源上的同一本书」，用户挑一个再切过去。
 *
 * 注意：候选里**没有** chapterCount 字段——后端为了不让并发搜索给每个候选都白抓一次目录，
 * 刻意不填。所以界面上不要展示候选章数，章数只在真正换源成功后的返回值里才有。
 */
async function switchSourceDialog(book) {
  modal({
    title: `换源：《${book.name}》`,
    body: `
      <p class="hint" id="swTip">正在其他书源上搜索这本书…</p>
      <div id="swList" class="sw-list"><p class="empty">搜索中，请稍候…</p></div>
      <label class="sw-opt"><input type="checkbox" id="swKeepChapters"> 迁移已下载的正文（按章节序号硬搬，可能串章）</label>
      <label class="sw-opt"><input type="checkbox" id="swKeepOld"> 保留旧书源条目（默认替换）</label>
      <label class="sw-opt"><input type="checkbox" id="swDownload" checked> 换源后补下后续章节</label>`,
    buttons: [{ text: '关闭', onClick: closeModal }],
  });

  const listBox = $('#swList');
  const tip = $('#swTip');

  // 换源过程要跨「搜索」和「抓目录」两个较长阶段，用一个可复用的忙碌条而不是全局 busy，
  // 否则用户没法中途取消/切换选项。
  const setBusy = (msg) => {
    if (msg) {
      let bar = listBox.querySelector('.sw-busy');
      if (!bar) {
        bar = document.createElement('p');
        bar.className = 'empty sw-busy';
        listBox.appendChild(bar);
      }
      bar.textContent = msg;
    } else {
      const bar = listBox.querySelector('.sw-busy');
      if (bar) bar.remove();
    }
  };

  const r = await run('搜索候选书源…', () => window.api.sourceCandidates(book.id, {}));
  if (!r) {
    tip.textContent = '搜索失败，可关闭后重试。';
    listBox.innerHTML = '<p class="empty">没能取到候选书源</p>';
    return;
  }

  const cands = r.candidates || [];
  tip.textContent = cands.length
    ? `在 ${r.ran} 个书源里找到 ${cands.length} 个候选（${r.elapsed} ms），选一个替换：`
    : `已在 ${r.ran} 个书源上搜过，没有找到同名书。`;

  if (!cands.length) {
    const failed = (r.sources || []).filter((s) => !s.ok);
    listBox.innerHTML =
      '<p class="empty">其他书源上没有搜到这本书。<br/>可以改用「全书源搜索」手动确认，或先添加更多书源。</p>' +
      (failed.length
        ? `<details class="sw-detail"><summary>${failed.length} 个书源搜索失败</summary><ul>` +
          failed.map((s) => `<li>${esc(s.name)}：${esc(s.error || '未知错误')}</li>`).join('') +
          '</ul></details>'
        : '');
    return;
  }

  listBox.innerHTML = '';
  for (const c of cands) {
    const tag = matchTag(c.score);
    const broken = urlLooksBroken(c.bookUrl);
    const el = document.createElement('div');
    el.className = 'sw-item' + (broken ? ' sw-broken' : '');
    el.innerHTML = `
      <div class="sw-main">
        <div class="sw-title">${esc(c.name || book.name)}<span class="badge ${tag.cls}">${tag.text}</span>${
          broken ? '<span class="badge err">地址可能无效</span>' : ''
        }</div>
        <div class="sw-sub">
          <span class="badge info">${esc(c.sourceName)}</span>
          ${c.author ? esc(c.author) : '<i>未知作者</i>'}
          ${c.lastChapter ? `· ${esc(c.lastChapter)}` : ''}
          <span class="muted">· ${c.ms} ms</span>
        </div>
        ${c.intro ? `<div class="sw-intro">${esc(c.intro)}</div>` : ''}
        ${broken ? '<div class="sw-warn">这个书源返回的书籍地址形状可疑，换到该源很可能抓不到目录。建议先换其他候选。</div>' : ''}
      </div>
      <div class="sw-act"><button class="btn${broken ? '' : ' primary'}">换到该源</button></div>`;
    el.querySelector('button').onclick = () => doChangeSource(book, c, el);
    listBox.appendChild(el);
  }
}

/**
 * 候选的 bookUrl 看起来是否可疑。
 *
 * 起因：实测「速读谷」返回的 bookUrl 形如 `https://suduguu.com/13/…/13/211991.html`
 * （同一路径段重复出现），拿去抓目录必失败。后端 `changeSource` 在抓目录失败时会整体回滚、
 * 书架保持原样，所以不会留脏数据；但用户在一列候选里点到一个「注定失败」的条目体验很差。
 *
 * 后端 `sourceCandidates` 只按书名/作者打分、不校验 bookUrl 可抓性（给每个候选都发一次
 * 请求会显著拖慢并发搜索），所以这里做一次**零成本**的形态检查：只判断明显畸形，
 * 不额外发请求。宁可误标也不放过——被标红的候选仍然可以点，只是提前告知风险。
 */
function urlLooksBroken(u) {
  const s = String(u || '').trim();
  if (!s) return true;
  if (!/^https?:\/\//i.test(s)) return true;
  let parsed;
  try { parsed = new URL(s); } catch (_) { return true; }
  if (!parsed.hostname.includes('.')) return true;
  // 同一路径段在路径里连续/重复出现 3 次以上（如 /13/x/13/y/13/）
  const segs = parsed.pathname.split('/').filter(Boolean);
  const count = {};
  for (const seg of segs) count[seg] = (count[seg] || 0) + 1;
  if (segs.length >= 3 && Object.values(count).some((n) => n >= 3)) return true;
  return false;
}

/** 执行换源；成功后刷新书架并提示结果 */
async function doChangeSource(book, cand, el) {
  const keepChapters = $('#swKeepChapters').checked;
  const keepOld = $('#swKeepOld').checked;
  const download = $('#swDownload').checked;

  const btn = el.querySelector('button');
  btn.disabled = true;
  btn.textContent = '换源中…';
  setSwitchTip(`正在把《${book.name}》换到「${cand.sourceName}」…`);

  const r = await run('换源中…', () =>
    window.api.changeSource(book.id, cand.sourceKey, {
      keepChapters,
      keepOld,
      download,
    })
  );

  btn.disabled = false;
  btn.textContent = '换到该源';
  if (!r) return; // run() 已经弹过错误 toast；后端失败会回滚，书架状态是干净的

  closeModal();
  await loadShelf();

  const extra = [];
  if (r.migratedChapters) extra.push(`迁移正文 ${r.migratedChapters} 章`);
  if (r.progressKept) extra.push(`阅读进度保留在第 ${(r.progress.index || 0) + 1} 章`);
  toast(`《${r.name}》已换到「${r.sourceName}」：目录 ${r.chapterCount} 章${extra.length ? '，' + extra.join('，') : ''}`, 'ok');

  if (r.migrationRisk && keepChapters) toast(r.migrationRisk, 'err');
}

function setSwitchTip(msg) {
  const tip = $('#swTip');
  if (tip) tip.textContent = msg;
}

$('#btnExportShelf').onclick = async () => {
  if (!shelfCache.length) return toast('书架是空的', 'err');
  const dir = await window.api.pickDir();
  if (dir.canceled) return;
  const rs = await run('导出全部书籍…', () => window.api.exportShelf({ outDir: dir.dir, layout: 'single', encoding: 'utf-8' }));
  if (!rs) return;
  const ok = rs.filter((r) => r.ok).length;
  toast(`导出完成：${ok}/${rs.length} 本成功`, 'ok');
  modal({
    title: '导出结果',
    body:
      `<p>输出目录：${esc(dir.dir)}</p><div class="card-sub">` +
      rs
        .map((r) =>
          r.ok
            ? `✓ 《${esc(r.name)}》 ${r.result.chapters} 章 ${r.result.files.length} 文件`
            : `✗ 《${esc(r.name)}》 ${esc(r.error)}`
        )
        .join('<br/>') +
      '</div>',
    buttons: [{ text: '好', class: 'primary', onClick: closeModal }],
  });
};

/** 下载对话框：章节范围 + 强制重下 */
function downloadDialog(book) {
  const total = book.chapterCount || 0;
  modal({
    title: `下载《${esc(book.name)}》`,
    body: `
      <div class="kv">
        <dt>目录总章数</dt><dd>${total}</dd>
        <dt>已下载</dt><dd>${book.downloadedCount || 0}</dd>
      </div>
      <p style="margin:14px 0 8px">章节范围（从 1 开始，留空表示全部）：</p>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="input" id="dlFrom" type="number" min="1" max="${total}" placeholder="起始章" style="width:110px"/>
        <span>—</span>
        <input class="input" id="dlTo" type="number" min="1" max="${total}" placeholder="结束章" style="width:110px"/>
        <label class="check"><input type="checkbox" id="dlForce"/> 强制重新下载已存在的章节</label>
      </div>
      <p class="hint" style="margin-top:10px">默认跳过已下载章节（断点续传）。</p>`,
    buttons: [
      { text: '取消', onClick: closeModal },
      {
        text: '开始下载',
        class: 'primary',
        onClick: async () => {
          const f = parseInt($('#dlFrom').value, 10);
          const t = parseInt($('#dlTo').value, 10);
          const force = $('#dlForce').checked;
          closeModal();
          const r = await run('下载中…', () =>
            window.api.download(book.id, {
              from: Number.isFinite(f) ? Math.max(0, f - 1) : undefined,
              to: Number.isFinite(t) ? Math.max(0, t - 1) : undefined,
              force,
            })
          );
          if (r) {
            toast(`下载完成：成功 ${r.done}，跳过 ${r.skipped}，失败 ${r.failed}`, r.failed ? 'err' : 'ok');
            if (r.failedIndexes && r.failedIndexes.length) {
              console.warn('失败章节:', r.failedIndexes.map((i) => i + 1).join(', '));
            }
            loadShelf();
          }
        },
      },
    ],
  });
}

/** 导出单本对话框 */
function exportDialog(book) {
  modal({
    title: `导出《${esc(book.name)}》为 TXT`,
    body: `
      <div class="kv">
        <dt>排版</dt><dd>
          <select class="input select" id="exLayout">
            <option value="single">整本一个文件</option>
            <option value="chapter">每章一个文件</option>
            <option value="volume">按卷分文件</option>
          </select></dd>
        <dt>编码</dt><dd>
          <select class="input select" id="exEncoding">
            <option value="utf-8">UTF-8（推荐）</option>
            <option value="gbk">GBK（老设备/老阅读器）</option>
          </select></dd>
        <dt>换行</dt><dd>
          <select class="input select" id="exEol">
            <option value="crlf">CRLF（Windows）</option>
            <option value="lf">LF（Unix）</option>
          </select></dd>
        <dt>选项</dt><dd>
          <label class="check"><input type="checkbox" id="exToc" checked/> 包含目录</label>
          <label class="check"><input type="checkbox" id="exHeader" checked/> 包含书籍信息</label>
        </dd>
      </div>`,
    buttons: [
      { text: '取消', onClick: closeModal },
      { text: '选择目录', onClick: () => doExportBook(book.id, true) },
      { text: '默认目录导出', class: 'primary', onClick: () => doExportBook(book.id, false) },
    ],
  });
}

async function doExportBook(bookId, askDir) {
  const opts = {
    layout: $('#exLayout').value,
    encoding: $('#exEncoding').value,
    eol: $('#exEol').value,
    includeToc: $('#exToc').checked,
    includeHeader: $('#exHeader').checked,
  };
  closeModal();
  if (askDir) {
    const dir = await window.api.pickDir();
    if (dir.canceled) return;
    opts.outDir = dir.dir;
  }
  const r = await run('导出中…', () => window.api.exportBook(bookId, opts));
  if (!r) return;
  toast(`导出完成：${r.chapters} 章，${r.files.length} 个文件`, 'ok');
  modal({
    title: '导出完成',
    body:
      `<p>共 ${r.chapters} 章，${r.files.length} 个文件${r.missing ? `，跳过未下载 ${r.missing} 章` : ''}。</p>` +
      '<div class="card-sub" style="max-height:300px;overflow:auto">' +
      r.files.map((f) => esc(f.path)).join('<br/>') +
      '</div>',
    buttons: [
      { text: '关闭', onClick: closeModal },
      { text: '打开所在目录', class: 'primary', onClick: () => { window.api.showInFolder(r.files[0].path); closeModal(); } },
    ],
  });
}

/* ==================== 阅读器 ==================== */

let reader = { bookId: null, book: null, toc: [], index: 0 };

/**
 * 懒加载窗口（与主进程 src/store/downloader.js 的 INITIAL_WINDOW / READAHEAD_WINDOW 对齐）。
 * 加入书架先下前 INITIAL_WINDOW 章；之后读到第 N 章就后台补第 N+1..N+READAHEAD_WINDOW 章。
 */
const INITIAL_WINDOW = 10;
const READAHEAD_WINDOW = 10;

/** 已触发过预取的「书 + 章」对，避免同一章反复发请求 */
const prefetched = new Map(); // bookId -> Set(index)

/**
 * 后台预取：读到第 index 章时，把后面 READAHEAD_WINDOW 章下下来。
 *
 * 三个刻意的取舍：
 *  1. **不 await**：用户在翻页，预取必须静默跑，不能卡住阅读；
 *  2. 同一本书同时只跑一个任务（主进程 downloadWindow 已防重入），
 *     这里再记一层 prefetched，避免同一章重复调用；
 *  3. 失败只 toast，不打断阅读——网络抖动是常态。
 */
function prefetchAfter(index) {
  const bookId = reader.bookId;
  if (!bookId || !reader.toc.length) return;
  let seen = prefetched.get(bookId);
  if (!seen) { seen = new Set(); prefetched.set(bookId, seen); }
  // 只按「章」去重：同一个 index 触发多次只算一次
  if (seen.has(index)) return;
  seen.add(index);
  // 已经读到末章就没必要预取
  if (index >= reader.toc.length - 1) return;

  window.api.downloadWindow(bookId, index, {}).then((d) => {
    if (!d || d.skipped || d.empty) return;
    const n = d.done + d.skipped;
    if (n > 0) toast(`后台已缓存第 ${d.from + 1}-${d.to + 1} 章`, 'ok');
    if (d.failed) toast(`有 ${d.failed} 章缓存失败，翻到时会重试`, 'err');
    // 读到的章可能正是刚才下好的，刷新一下当前显示（仅当还停在同一章）
    if (reader.bookId === bookId && reader.index === index) {
      // 只在当前章尚未显示正文时补渲染，避免打断正在读的内容
      const body = $('#readerBody');
      if (body && /这一章还没有下载/.test(body.textContent || '')) showChapter(index);
    }
  }).catch(() => { /* 后台任务失败不打扰阅读 */ });
}

async function openReader(bookId) {
  const book = await run('打开书籍…', () => window.api.book(bookId));
  if (!book) return;
  const toc = (await run('读取目录…', () => window.api.toc(bookId))) || [];
  const prog = await window.api.progress(bookId);
  reader = { bookId, book, toc, index: prog && prog.index != null ? prog.index : 0 };

  const sel = $('#readerChapter');
  sel.innerHTML = toc
    .map((c, i) => `<option value="${i}">${i + 1}. ${esc((c.name || '').slice(0, 40))}${c.isVolume ? '（卷）' : ''}</option>`)
    .join('');
  sel.onchange = () => showChapter(parseInt(sel.value, 10));

  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-reader'));
  $$('.tab').forEach((t) => t.classList.remove('active'));
  $('#readerTitle').textContent = `${book.name}${book.author ? ' · ' + book.author : ''}`;
  await showChapter(reader.index);
}

async function showChapter(idx) {
  if (!reader.toc.length) {
    $('#readerBody').innerHTML = '<div class="paper"><h1>没有目录</h1><p>这本书还没有抓取到目录。</p></div>';
    return;
  }
  idx = Math.max(0, Math.min(idx, reader.toc.length - 1));
  reader.index = idx;
  const ch = reader.toc[idx];
  $('#readerChapter').value = String(idx);
  $('#btnPrevChapter').disabled = idx <= 0;
  $('#btnNextChapter').disabled = idx >= reader.toc.length - 1;

  const text = await run('读取章节…', () => window.api.chapter(reader.bookId, idx));
  const body = $('#readerBody');
  if (text == null) {
    body.innerHTML = `<div class="paper"><h1>${esc(ch.name || '')}</h1><p style="color:#a33">这一章还没有下载。</p><p><button class="btn primary" id="btnDlThis">下载这一章所在的范围</button></p></div>`;
    const b = $('#btnDlThis');
    if (b) b.onclick = () => downloadDialog({ ...reader.book, chapterCount: reader.toc.length });
    // 读到未下载的章 → 立刻后台补这一段（用户不用手点）
    prefetchAfter(idx);
    return;
  }
  // 去掉首行的重复章名（与导出对齐）
  let content = text;
  const nl = content.indexOf('\n');
  if (nl > 0 && content.slice(0, nl).trim() === String(ch.name || '').trim()) {
    content = content.slice(nl + 1).replace(/^\n+/, '');
  }
  let paper = `<div class="paper"><h1>${esc(ch.name || '第 ' + (idx + 1) + ' 章')}</h1>`;
  if (looksLikeStubPage(content) || !content.trim()) {
    // 旧数据里可能存过站点错误页/只剩标题的空壳章（守卫上线前下的）——提示并给一键重试
    paper += '<p class="stub-warn">⚠ 这一章的正文缺失，或像是站点返回的错误提示，而不是小说内容。'
      + '点下面按钮或右上角「⇩ 重新下载」重试。<br>'
      + '<button class="btn primary" id="btnRedlInline">立即重新下载本章</button></p>';
  }
  paper += esc(content) + '</div>';
  body.innerHTML = paper;
  const bi = $('#btnRedlInline');
  if (bi) bi.onclick = () => redownloadChapter(idx);
  body.scrollTop = 0;
  window.api.saveProgress(reader.bookId, { index: idx, percent: reader.toc.length ? idx / reader.toc.length : 0 }).catch(() => {});
  // 读到哪下到哪：读完本章就把后面 READAHEAD_WINDOW 章补上
  prefetchAfter(idx);
}

$('#btnPrevChapter').onclick = () => showChapter(reader.index - 1);
$('#btnNextChapter').onclick = () => showChapter(reader.index + 1);
$('#btnRefreshCh').onclick = () => { if (reader) showChapter(reader.index); };
$('#btnRedlCh').onclick = () => { if (reader) redownloadChapter(reader.index); };

/**
 * 与 src/store/downloader.js 的 looksLikeStubPage 同判据（渲染端不能 require，抄一份）。
 * 改动时两处一起改。
 */
function looksLikeStubPage(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 120) return false;
  return /(获取|加载|读取)[^。\n]{0,8}(章节|内容)[^。\n]{0,8}失败|太频繁|稍后(再|重)试|请刷新|浏览器阅读模式|访问验证|人机?验证|内容缺失|章节缺失|内容已下架|章节错误/.test(t);
}

/** 强制从书源重下当前章并覆盖本地文件（下载中站点又回错误页时保留旧文件，只提示） */
async function redownloadChapter(idx) {
  if (!reader || idx == null) return;
  const bookId = reader.bookId;
  const r = await run('重新下载本章…', () => window.api.download(bookId, { from: idx, to: idx, force: true }));
  if (!r) return; // run() 已弹错误 toast
  if (r.failed) toast('站点这次仍没给出正文（可能限流/验证），过一会儿再试', 'err');
  else if (r.done) toast('本章已重新下载', 'ok');
  else toast('本章没有变化', '');
  if (reader && reader.bookId === bookId) await showChapter(idx);
}
$('#btnReaderBack').onclick = () => switchView('shelf');
$('#btnExportBook').onclick = () => exportDialog(reader.book);
document.addEventListener('keydown', (e) => {
  if (!$('#view-reader').classList.contains('active') || $('#modalMask').classList.contains('show')) return;
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') showChapter(reader.index - 1);
  if (e.key === 'ArrowRight' || e.key === 'PageDown') showChapter(reader.index + 1);
});

/* ==================== 搜索 ==================== */

let sourceCache = [];

async function fillSourceSelect() {
  const list = await run(null, () => window.api.sourceList());
  if (!list) return;
  sourceCache = list;
  const sel = $('#searchSource');
  const prev = sel.value;
  sel.innerHTML = list.map((s) => `<option value="${esc(s.key)}">${esc(s.name)}${s.probeOk ? '' : '（未通过探测）'}</option>`).join('');
  if (prev && list.some((s) => s.key === prev)) sel.value = prev;
}

function doSearch() {
  const kw = $('#searchInput').value.trim();
  if (!kw) return toast('请输入关键词', 'err');
  const mode = $('#searchMode').value;
  const box = $('#searchList');
  box.innerHTML = '<p class="empty">搜索中…</p>';

  if (mode === 'one') {
    run(`搜索「${kw}」…`, () => window.api.searchOne($('#searchSource').value, kw, 1)).then((r) => {
      if (!r) {
        box.innerHTML = '<p class="empty">搜索失败</p>';
        return;
      }
      renderSearchResults([{ ok: true, ...r }]);
    });
    return;
  }
  doSearchEverywhere(kw);
}

/* ---------------- 全书源聚合搜索（并发 + 增量 + 熔断） ---------------- */

/** 本次搜索的增量渲染状态 */
let sr = null;

function doSearchEverywhere(kw) {
  if (sr && sr.running) return toast('上一次搜索还没结束', 'err');
  const box = $('#searchList');
  box.innerHTML = '';
  sr = { kw, running: true, done: 0, total: 0, ok: 0, books: [], sources: [], groups: [], t0: Date.now() };

  $('#searchProgress').hidden = false;
  $('#srBarIn').style.width = '0%';
  $('#srText').textContent = '正在向各书源发起搜索…';
  $('#btnSrCancel').hidden = false;

  sr.off = window.api.onSearchEvent((ev) => {
    if (!sr || !sr.running) return;
    if (ev.type === 'start') {
      sr.total = ev.total;
      box.appendChild(srLine(ev.key, ev.name));
      srUpdate();
      return;
    }
    if (ev.type !== 'result') return;
    sr.done++;
    sr.sources.push(ev);
    if (ev.ok && ev.count) sr.ok++;
    srLineUpdate(ev);
    // 增量：把该源的书追加进列表（先按源分组显示，收尾时再聚合）
    if (ev.list && ev.list.length) srAppendBooks(ev);
    srUpdate();
  });

  run(`全书源搜索「${kw}」…`, () => window.api.searchEverywhere(kw, {
    page: 1,
    concurrency: srConcurrency,
    perSourceTimeout: srPerSourceTimeout,
    totalTimeout: srTotalTimeout,
  })).then((r) => {
    sr.running = false;
    if (sr.off) sr.off();
    $('#btnSrCancel').hidden = true;
    $('#searchProgress').hidden = true;
    if (!r) {
      $('#searchList').innerHTML = '<p class="empty">搜索失败</p>';
      sr = null;
      return;
    }
    sr.final = r;
    renderAggregated(r);
  });
}

let srConcurrency = 6;
let srPerSourceTimeout = 12000;
let srTotalTimeout = 30000;

function srUpdate() {
  if (!sr) return;
  const pct = sr.total ? Math.round((sr.done / sr.total) * 100) : 0;
  $('#srBarIn').style.width = `${pct}%`;
  const el = ((Date.now() - sr.t0) / 1000).toFixed(1);
  $('#srText').textContent = `${sr.done}/${sr.total || '?'} 个源已返回 · ${sr.ok} 个有结果 · ${el}s`;
}

/** 每个源一行状态（在列表顶部滚动显示） */
function srLine(key, name) {
  const el = document.createElement('div');
  el.className = 'sr-line';
  el.dataset.key = key;
  el.innerHTML = `<span class="sr-dot"></span><span class="sr-name">${esc(name || key)}</span><span class="sr-info">搜索中…</span>`;
  return el;
}

function srLineUpdate(ev) {
  const el = document.querySelector(`.sr-line[data-key="${cssEsc(ev.key)}"]`);
  if (!el) return;
  el.classList.add(ev.ok ? (ev.count ? 'ok' : 'none') : 'bad');
  el.querySelector('.sr-info').textContent = ev.ok ? `${ev.count} 条 · ${ev.ms}ms` : `${ev.error} · ${ev.ms}ms`;
}

/** 增量把某个源的结果挂上去（分组视图，收尾时替换为聚合视图） */
function srAppendBooks(ev) {
  sr.books.push(...(ev.list || []).map((b) => ({ ...b, _src: ev.name, _key: ev.key })));
}

function cssEsc(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

/** 收尾：把聚合结果画出来（同一本书多个源合并成一条，可切换来源） */
function renderAggregated(r) {
  const box = $('#searchList');
  box.innerHTML = '';
  const stat = document.createElement('div');
  stat.className = 'sr-summary';
  stat.innerHTML = `<b>${r.groups.length}</b> 本书 · 来自 <b>${r.ok}/${r.total}</b> 个源 · 耗时 <b>${r.el}</b>` +
    (r.timedOut ? ` · <span class="warn">${r.timedOut} 个源超时</span>` : '') +
    (r.skipped ? ` · <span class="warn">${r.skipped} 个源因整体超时未执行</span>` : '');
  box.appendChild(stat);

  if (!r.groups.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '没有搜到结果';
    box.appendChild(p);
    return;
  }
  // 只渲染前 200 本，避免 DOM 过大卡顿
  const LIMIT = 200;
  for (const g of r.groups.slice(0, LIMIT)) box.appendChild(bookCard(g));
  if (r.groups.length > LIMIT) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = `还有 ${r.groups.length - LIMIT} 本未显示（结果太多，缩小关键词试试）`;
    box.appendChild(p);
  }

  // 失败源摘要
  const bad = r.sources.filter((s) => !s.ok);
  if (bad.length) {
    const d = document.createElement('details');
    d.className = 'sr-failed';
    d.innerHTML = `<summary>${bad.length} 个源没出结果（点击展开）</summary>` +
      bad.map((s) => `<div class="sr-bad-row"><span>${esc(s.name)}</span><span class="dim">${esc(s.error)}</span></div>`).join('');
    box.appendChild(d);
  }
}

/** 一本书的卡片：多来源时提供来源切换 */
function bookCard(g) {
  const el = document.createElement('div');
  el.className = 'card book-card';
  const offers = g.offers || [];
  let idx = 0;

  const paint = () => {
    const o = offers[idx];
    el.innerHTML = `
      <div class="card-main">
        <div class="card-title">${esc(g.title || o.name)}
          ${offers.length > 1 ? `<span class="badge badge-src">${offers.length} 个来源</span>` : ''}
        </div>
        <div class="card-sub">
          ${esc(g.author || '未知作者')}
          ${g.kind ? `<span class="badge">${esc(String(g.kind).split('\n')[0].slice(0, 14))}</span>` : ''}
          ${(o.lastChapter || g.lastChapter) ? `<span class="badge">最新：${esc(String(o.lastChapter || g.lastChapter).slice(0, 18))}</span>` : ''}
        </div>
        ${g.intro ? `<div class="card-intro">${esc(String(g.intro).slice(0, 120))}</div>` : ''}
        <div class="card-sub">
          来源：<b>${esc(o.sourceName)}</b>
          ${offers.length > 1 ? `<select class="input select src-pick">${offers.map((x, i) => `<option value="${i}"${i === idx ? ' selected' : ''}>${esc(x.sourceName)}</option>`).join('')}</select>` : ''}
          <br/><span class="dim">${esc(o.bookUrl)}</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn primary" data-act="add">加入书架</button>
        <button class="btn" data-act="adddl">加入并下载</button>
      </div>`;
    const pick = el.querySelector('.src-pick');
    if (pick) {
      pick.onchange = () => { idx = parseInt(pick.value, 10) || 0; paint(); };
    }
    el.querySelector('[data-act=add]').onclick = () => addToShelf(o.sourceKey, o, false);
    el.querySelector('[data-act=adddl]').onclick = () => addToShelf(o.sourceKey, o, true);
  };
  paint();
  return el;
}

function renderSearchResults(groups) {
  const box = $('#searchList');
  box.innerHTML = '';
  let any = false;
  for (const g of groups) {
    if (!g.ok) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = `✗ ${g.source}：${g.error}`;
      box.appendChild(p);
      continue;
    }
    if (!g.list.length) continue;
    any = true;
    const head = document.createElement('div');
    head.className = 'card-sub';
    head.style.padding = '4px 2px';
    head.innerHTML = `<b>${esc(g.source)}</b> — 「${esc(g.keyword)}」${g.list.length} 条`;
    box.appendChild(head);
    for (const b of g.list) {
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = `
        <div class="card-main">
          <div class="card-title">${esc(b.name)}</div>
          <div class="card-sub">
            ${esc(b.author || '未知作者')}
            ${b.kind ? `<span class="badge">${esc(String(b.kind).split('\n')[0].slice(0, 14))}</span>` : ''}
            ${b.lastChapter ? `<span class="badge">最新：${esc(String(b.lastChapter).slice(0, 18))}</span>` : ''}
            <br/>${esc(b.bookUrl)}
          </div>
        </div>
        <div class="card-actions">
          <button class="btn primary" data-act="add">加入书架</button>
          <button class="btn" data-act="adddl">加入并下载</button>
        </div>`;
      el.querySelector('[data-act=add]').onclick = () => addToShelf(g.sourceKey, b, false);
      el.querySelector('[data-act=adddl]').onclick = () => addToShelf(g.sourceKey, b, true);
      box.appendChild(el);
    }
  }
  if (!any) box.innerHTML = '<p class="empty">没有搜到结果</p>';
}

async function addToShelf(sourceKey, book, download) {
  const key = sourceKey || $('#searchSource').value;
  const r = await run(`加入《${book.name}》…`, () => window.api.addToShelf(key, book, { download: false }));
  if (!r) return;
  toast(`《${r.name}》已加入书架，目录 ${r.chapterCount} 章`, 'ok');
  if (download) {
    // 懒加载：只下前 10 章，不再一次下全书（长篇上千章会等到天荒地老）
    const d = await run(`下载前 ${INITIAL_WINDOW} 章…`, () => window.api.downloadWindow(r.id, 0, {}));
    if (d) toast(`已下好前 ${(d.from + 1)}-${(d.to + 1)} 章（成功 ${d.done}，失败 ${d.failed}），读到哪下到哪`, d.failed ? 'err' : 'ok');
  }
  if ($('#view-search').classList.contains('active')) loadShelf();
}

$('#btnSearch').onclick = doSearch;
$('#searchInput').onkeydown = (e) => {
  if (e.key === 'Enter') doSearch();
};
$('#btnSrCancel').onclick = () => {
  if (sr) sr.running = false;
  if (sr && sr.off) sr.off();
  $('#searchProgress').hidden = true;
  toast('已停止接收结果（进行中的请求会自然结束）', 'ok');
};

/* ==================== 本地书源 ==================== */

async function loadSources() {
  const list = (await run('读取书源…', () => window.api.sourceList())) || [];
  const stats = await window.api.info();
  $('#sourceStats').textContent = stats ? `共 ${stats.sources.total} 个 · 通过 ${stats.sources.passed}` : '';
  const box = $('#sourceList');
  if (!list.length) {
    box.innerHTML = '<p class="empty">还没有书源<br/>去「在线书源」里挑一个，或点「手动添加」</p>';
    return;
  }
  box.innerHTML = '';
  for (const s of list) {
    const el = document.createElement('div');
    el.className = 'card';
    const probeBadge = !s.probed
      ? '<span class="badge warn">未探测</span>'
      : s.probeOk
        ? `<span class="badge ok">探测通过 ${s.probeScore}</span>`
        : `<span class="badge err">探测未过 ${s.probeScore}</span>`;
    el.innerHTML = `
      <div class="card-main">
        <div class="card-title">${esc(s.name)}</div>
        <div class="card-sub">
          ${esc(s.url)}<br/>
          ${s.hasSearch ? '<span class="badge info">搜</span>' : ''}
          ${s.hasExplore ? '<span class="badge info">发现</span>' : ''}
          ${s.group ? `<span class="badge">${esc(s.group)}</span>` : ''}
          ${probeBadge}
          ${s.probeAt ? `<span class="hint">${new Date(s.probeAt).toLocaleString()}</span>` : ''}
        </div>
      </div>
      <div class="card-actions">
        <button class="btn" data-act="detail">详情</button>
        <button class="btn" data-act="test">重新探测</button>
        <button class="btn danger" data-act="remove">删除</button>
      </div>`;
    el.querySelector('[data-act=detail]').onclick = async () => {
      const full = await window.api.sourceGet(s.key);
      modal({
        title: s.name,
        body: `<pre style="white-space:pre-wrap;font-size:12px;line-height:1.6;max-height:50vh;overflow:auto">${esc(JSON.stringify(full, null, 2))}</pre>`,
        buttons: [{ text: '关闭', onClick: closeModal }],
      });
    };
    el.querySelector('[data-act=test]').onclick = async () => {
      const full = await window.api.sourceGet(s.key);
      const r = await run('探测中（可能需要十几秒）…', () => window.api.sourceTest(full, {}));
      if (r) showProbeResult(s.name, r);
    };
    el.querySelector('[data-act=remove]').onclick = () => {
      modal({
        title: '确认删除书源',
        body: `<p>删除书源「${esc(s.name)}」？<br/>已加入书架的书不会被删除，但之后无法再下载新章节。</p>`,
        buttons: [
          { text: '取消', onClick: closeModal },
          {
            text: '删除',
            class: 'danger',
            onClick: async () => {
              closeModal();
              await run('删除中…', () => window.api.sourceRemove(s.key));
              toast('已删除', 'ok');
              loadSources();
            },
          },
        ],
      });
    };
    box.appendChild(el);
  }
}

/** 展示探测结果（阶段 + 评分 + 准入） */
function showProbeResult(name, r) {
  const stages = r.probe && r.probe.stages ? r.probe.stages : {};
  const rows = Object.entries(stages)
    .map(([k, v]) => {
      const extra = [v.count != null ? `count=${v.count}` : '', v.chars != null ? `chars=${v.chars}` : '', v.error || '']
        .filter(Boolean)
        .join('  ');
      return `<div><span class="${v.ok ? 's-ok' : 's-err'}">${v.ok ? '✓' : '✗'}</span> ${esc(k).padEnd(10)} ${esc(extra)}</div>`;
    })
    .join('');
  const warns = (r.probe && r.probe.warnings ? r.probe.warnings : []).map((w) => `<div class="card-sub">⚠ ${esc(w)}</div>`).join('');
  const errs = (r.errors || []).map((w) => `<div class="card-sub" style="color:#b91c1c">· ${esc(w)}</div>`).join('');
  modal({
    title: `探测结果：${name}`,
    body: `
      <p style="margin-top:0">
        准入判定：${r.allowed ? '<span class="badge ok">✓ 允许添加</span>' : '<span class="badge err">✗ 不允许添加</span>'}
        <span class="hint">${esc(r.reason || '')}</span>
      </p>
      ${r.probe ? `<p>评分：<b>${r.probe.score}</b>/100 &nbsp; 耗时 ${r.probe.elapsed}ms</p>` : ''}
      <div class="stage-list">${rows}</div>
      ${warns}${errs}`,
    buttons: [{ text: '关闭', onClick: closeModal }],
  });
}

$('#btnRefreshSources').onclick = loadSources;

$('#btnImportSources').onclick = async () => {
  const r = await window.api.pickFiles();
  if (r.canceled) return;
  let all = [];
  for (const f of r.files) {
    try {
      all = all.concat(window.__parseImport(f.text));
    } catch (e) {
      toast(`${f.name}：${e.message}`, 'err');
    }
  }
  if (!all.length) return toast('没有解析出书源', 'err');
  importDialog(all);
};

function importDialog(list) {
  modal({
    title: `导入 ${list.length} 个书源`,
    body: `
      <p>导入时会逐个做<b>可读性探测</b>，不能读取的网站不会加入。</p>
      <label class="check"><input type="checkbox" id="impProbe" checked/> 执行可读性探测（推荐）</label>
      <label class="check" style="margin-left:12px"><input type="checkbox" id="impForce"/> 覆盖同名书源</label>
      <div class="card-sub" style="margin-top:12px;max-height:260px;overflow:auto">
        ${list.map((s) => `· ${esc(s.bookSourceName || '(无名)')} — ${esc(s.bookSourceUrl || '')}`).join('<br/>')}
      </div>`,
    buttons: [
      { text: '取消', onClick: closeModal },
      {
        text: '开始导入',
        class: 'primary',
        onClick: async () => {
          const probe = $('#impProbe').checked;
          const force = $('#impForce').checked;
          closeModal();
          const results = await run(`导入 ${list.length} 个书源…`, async () => {
            const out = [];
            for (const s of list) {
              // eslint-disable-next-line no-await-in-loop
              const r = await window.api.sourceAdd(s, { probe, force });
              out.push({ name: s.bookSourceName, ...r });
            }
            return out;
          });
          if (!results) return;
          const ok = results.filter((r) => r.added).length;
          toast(`导入完成：成功 ${ok}，失败 ${results.length - ok}`, ok === results.length ? 'ok' : 'err');
          modal({
            title: '导入结果',
            body: `<div class="card-sub">${results
              .map((r) =>
                r.added
                  ? `✓ ${esc(r.name)}（${esc(r.reason)}${r.probe ? '，评分 ' + r.probe.score : ''}）`
                  : `✗ ${esc(r.name)} — ${esc(r.reason)}` +
                    (r.errors && r.errors.length ? '<br/>&nbsp;&nbsp;&nbsp;' + r.errors.map((e) => esc(e)).join('<br/>&nbsp;&nbsp;&nbsp;') : '')
              )
              .join('<br/>')}</div>`,
            buttons: [{ text: '好', class: 'primary', onClick: closeModal }],
          });
          loadSources();
        },
      },
    ],
  });
}

window.__parseImport = function parseImport(text) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : [data];
  return arr.filter((s) => s && typeof s === 'object' && (s.bookSourceName || s.bookSourceUrl));
};

$('#btnExportSources').onclick = async () => {
  const r = await run('导出书源…', () => window.api.sourceExport(null));
  if (!r) return;
  const saved = await window.api.saveFile('sources.json', r.text);
  if (!saved.canceled) toast(`已导出 ${r.count} 个书源`, 'ok');
};

$('#btnAddSource').onclick = () => {
  modal({
    title: '手动添加书源',
    body: `
      <p style="margin-top:0">粘贴 Legado 3.x 书源 JSON（单个对象或数组）。提交前会做<b>可读性探测</b>，读不出来的网站不会被添加。</p>
      <textarea class="input" id="addSrcText" placeholder='{"bookSourceName":"...","bookSourceUrl":"https://...","searchUrl":"...","ruleToc":{"chapterList":"..."},"ruleContent":{"content":"..."}}'></textarea>
      <div style="margin-top:10px">
        <label class="check"><input type="checkbox" id="addSrcProbe" checked/> 执行可读性探测</label>
        <label class="check" style="margin-left:12px"><input type="checkbox" id="addSrcForce"/> 覆盖同名书源</label>
      </div>`,
    buttons: [
      { text: '取消', onClick: closeModal },
      {
        text: '校验并添加',
        class: 'primary',
        onClick: async () => {
          const text = $('#addSrcText').value.trim();
          if (!text) return toast('请粘贴书源 JSON', 'err');
          let list;
          try {
            list = window.__parseImport(text);
          } catch (e) {
            return toast('不是合法 JSON：' + e.message, 'err');
          }
          if (!list.length) return toast('没有解析出书源', 'err');
          const probe = $('#addSrcProbe').checked;
          const force = $('#addSrcForce').checked;
          closeModal();
          const results = await run('校验并添加…', async () => {
            const out = [];
            for (const s of list) {
              // eslint-disable-next-line no-await-in-loop
              out.push({ name: s.bookSourceName, ...(await window.api.sourceAdd(s, { probe, force })) });
            }
            return out;
          });
          if (!results) return;
          for (const r of results) {
            if (r.added) {
              toast(`✓ ${r.name} ${r.probe ? `（评分 ${r.probe.score}）` : ''}`, 'ok');
              if (r.probe) showProbeResult(r.name, { allowed: true, reason: r.reason, probe: r.probe });
            } else {
              toast(`✗ ${r.name} — ${r.reason}`, 'err');
              if (r.probe) showProbeResult(r.name, { allowed: false, reason: r.reason, probe: r.probe, errors: r.errors });
            }
          }
          loadSources();
        },
      },
    ],
  });
};

/* ==================== 在线书源 ==================== */

let onlinePage = 1;
let onlineTotal = 1;

async function loadOnline() {
  const keys = $('#onlineKeys').value.trim();
  const order = $('#onlineOrder').value;
  const box = $('#onlineList');
  box.innerHTML = '<p class="empty">加载中…</p>';
  const r = await run('拉取在线书源…', () => window.api.onlineList({ page: onlinePage, keys, order1: order }));
  if (!r) {
    box.innerHTML = '<p class="empty">加载失败</p>';
    return;
  }
  onlineTotal = r.totalPages || 1;
  $('#onlinePage').textContent = `${r.page} / ${onlineTotal}`;
  box.innerHTML = '';
  if (!r.items.length) {
    box.innerHTML = '<p class="empty">没有匹配的书源</p>';
    return;
  }
  // 探测状态表：把「探测过且不允许添加」的书源标红（key = bookSourceUrl 归一）
  const probeMap = await window.api.probeStatus().catch(() => ({}));
  const keyOfUrl = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  for (const it of r.items) {
    const el = document.createElement('div');
    const rejected = probeMap[keyOfUrl(it.url)];
    el.className = 'card' + (rejected && rejected.allowed === false ? ' rejected' : '');
    const tags = [
      it.hasSearch ? '<span class="badge info">搜</span>' : '',
      it.hasExplore ? '<span class="badge info">发现</span>' : '',
      it.hasImage ? '<span class="badge">图</span>' : '',
      it.hasAudio ? '<span class="badge">声</span>' : '',
    ].join('');
    el.innerHTML = `
      <div class="card-main">
        <div class="card-title">${esc(it.name)}</div>
        <div class="card-sub">
          ${esc(it.url)}<br/>
          ${tags}
          ${it.group ? `<span class="badge">${esc(it.group)}</span>` : ''}
          <span class="badge">下载 ${it.downloads}</span>
          ${rejected && rejected.allowed === false ? '<span class="badge err">⛔ 不可添加</span>' : ''}
          <span class="hint">${esc(it.author || '')} · ${esc(it.updatedText || '')}</span>
          ${rejected && rejected.allowed === false && rejected.reason ? `<div class="hint" style="color:var(--err)">${esc(rejected.reason)}</div>` : ''}
        </div>
      </div>
      <div class="card-actions">
        <button class="btn primary" data-act="install">安装</button>
        <button class="btn" data-act="open" title="在内置浏览器里打开这个书源对应的网站">🌐 打开网站</button>
        <button class="btn" data-act="view">查看 JSON</button>
      </div>`;
    el.querySelector('[data-act=open]').onclick = () => openSourceSite(it.url, it.name);
    el.querySelector('[data-act=view]').onclick = async () => {
      const list = await run('下载 JSON…', () => window.api.onlineGet(it.id));
      if (!list) return;
      modal({
        title: `${it.name}（${list.length} 个书源）`,
        body: `<pre style="white-space:pre-wrap;font-size:12px;line-height:1.6;max-height:50vh;overflow:auto">${esc(JSON.stringify(list, null, 2))}</pre>`,
        buttons: [{ text: '关闭', onClick: closeModal }],
      });
    };
    el.querySelector('[data-act=install]').onclick = async () => {
      const results = await run(`安装「${it.name}」并探测…`, () => window.api.onlineInstall(it.id, {}));
      if (!results) return;
      for (const r of results) {
        if (r.added) {
          toast(`✓ ${r.name} 已添加${r.probe ? `（评分 ${r.probe.score}）` : ''}`, 'ok');
        } else {
          toast(`✗ ${r.name} — ${r.reason}`, 'err');
          if (r.probe) showProbeResult(r.name, { allowed: false, reason: r.reason, probe: r.probe, errors: r.errors });
          // 探测拒绝（不可添加）→ 当场把卡片标红；其他失败（已存在/结构非法）不改色
          if (r.probe && /不允许添加/.test(r.reason || '')) {
            el.classList.add('rejected');
            const sub = el.querySelector('.card-sub');
            if (sub && !sub.querySelector('.badge.err')) {
              sub.insertAdjacentHTML(
                'beforeend',
                '<span class="badge err">⛔ 不可添加</span>' +
                  `<div class="hint" style="color:var(--err)">${esc(r.reason)}</div>`
              );
            }
          }
        }
      }
      const ok = results.filter((r) => r.added).length;
      if (ok === results.length && results.length === 1 && results[0].probe) {
        showProbeResult(results[0].name, { allowed: true, reason: results[0].reason, probe: results[0].probe });
      }
      fillSourceSelect();
    };
    box.appendChild(el);
  }
}

$('#btnOnlineSearch').onclick = () => {
  onlinePage = 1;
  loadOnline();
};
$('#onlineKeys').onkeydown = (e) => {
  if (e.key === 'Enter') {
    onlinePage = 1;
    loadOnline();
  }
};
$('#onlineOrder').onchange = () => {
  onlinePage = 1;
  loadOnline();
};
$('#btnOnlinePrev').onclick = () => {
  if (onlinePage <= 1) return;
  onlinePage--;
  loadOnline();
};
$('#btnOnlineNext').onclick = () => {
  if (onlinePage >= onlineTotal) return;
  onlinePage++;
  loadOnline();
};

/* ==================== 在线「更新 / 校验 / 订阅源」（m04402） ==================== */

/* 线路（镜像站）：主站被 ban 时自动切到备用站 */
async function loadRoute(retry = false) {
  const r = await run(retry ? '重新探测线路…' : null, () => window.api.onlineRoute({ retry, check: retry }));
  if (!r) return;
  const bar = $('#onlineRouteBar');
  bar.hidden = false;
  const cand = (r.candidates && r.candidates.shuyuan) || [];
  bar.innerHTML = `${r.ok ? '🟢' : '🔴'} 当前线路：<b>${esc(r.shuyuan)}</b>` +
    `　备用：${cand.filter((c) => c !== r.shuyuan).map((c) => `<span class="badge">${esc(c)}</span>`).join(' ') || '<span class="dim">无</span>'}` +
    (r.error ? `　<span class="err">${esc(r.error)}</span>` : '');
}
$('#btnOnlineRoute').onclick = () => loadRoute(true);

// 「更新」：拉取 yckceo 最近更新的书源并同步安装
$('#btnOnlineUpdate').onclick = async () => {
  const days = await pickNumber('更新最近几天的书源？', 7);
  if (days === null) return;
  const r = await run(`刷新最近 ${days} 天更新的书源…`, () => window.api.onlineSyncUpdates({ days }));
  if (!r) return;
  const okItems = r.items.filter((x) => x.ok);
  const failItems = r.items.filter((x) => !x.ok);
  modal({
    title: `更新完成：检查 ${r.checked} 条，新增/更新 ${r.added}，失败 ${r.failed}`,
    body:
      (r.items.length
        ? `<div class="probe-lines" style="max-height:46vh;overflow:auto">` +
          r.items
            .map((x) => `<div>${x.ok ? '✅' : '❌'} <b>${esc(x.name || x.id)}</b>${x.reason ? ' — ' + esc(x.reason) : ''}</div>`)
            .join('') +
          `</div>`
        : `<p class="empty">最近 ${days} 天没有更新的书源</p>`),
    buttons: [{ text: '关闭', onClick: closeModal }],
  });
  if (okItems.length) toast(`✓ 更新了 ${okItems.length} 个书源`, 'ok');
  if (failItems.length) toast(`✗ ${failItems.length} 个未通过探测（详见弹窗）`, 'err');
  if (r.checked) fillSourceSelect();
};

// 「校验书源」：本地书源批量重跑可读性探测
$('#btnOnlineCheck').onclick = async () => {
  const r = await run('校验全部本地书源（可读性探测）…', () => window.api.sourceCheck({}));
  if (!r) return;
  modal({
    title: `校验完成：共 ${r.total} 个，通过 ${r.passed}，未通过 ${r.failed}`,
    body: `<div class="probe-lines" style="max-height:46vh;overflow:auto">` +
      r.results
        .map(
          (x) =>
            `<div>${x.allowed ? '✅' : '❌'} <b>${esc(x.name)}</b>` +
            `${x.score !== null && x.score !== undefined ? ` <span class="hint">评分 ${x.score}</span>` : ''}` +
            `${x.reason ? ' — ' + esc(x.reason) : ''}` +
            `${x.errors && x.errors.length ? '<br/><span class="hint" style="padding-left:22px">' + esc(x.errors[0]) + '</span>' : ''}</div>`
        )
        .join('') +
      `</div>`,
    buttons: [{ text: '关闭', onClick: closeModal }],
  });
  loadSources();
};

// 「订阅源」：浏览 yckceo 订阅源 + 管理本地
let rssPage = 1;
let rssTotal = 1;
let rssMode = 'online'; // online | local

async function loadRss() {
  const box = $('#modalBody');
  if (!box || !$('#modal').style.display) return;
  if (rssMode === 'online') {
    const r = await run('拉取在线订阅源…', () => window.api.rssOnlineList({ page: rssPage }));
    if (!r) return;
    rssTotal = r.totalPages || 1;
    const head = $('#rssPageHint');
    if (head) head.textContent = `第 ${r.page} / ${rssTotal} 页`;
    box.innerHTML =
      `<div class="pane-toolbar" style="padding:0 0 8px">
         <button class="btn" id="rssPrev">上一页</button>
         <span class="hint" id="rssPageHint">第 ${r.page} / ${rssTotal} 页</span>
         <button class="btn" id="rssNext">下一页</button>
         <span class="spacer"></span>
         <button class="btn" id="rssLocalBtn">查看本地（${(await window.api.rssList()).length}）</button>
       </div>` +
      (r.items.length
        ? r.items
            .map(
              (it) => `
        <div class="card" style="margin-bottom:8px">
          <div class="card-main">
            <div class="card-title">${esc(it.name)}</div>
            <div class="card-sub">${esc(it.url)}<br/>
              <span class="badge">下载 ${it.downloads}</span>
              <span class="hint">${esc(it.updatedText || '')}</span></div>
          </div>
          <div class="card-actions">
            <button class="btn primary" data-rss="${it.id}">导入</button>
          </div>
        </div>`
            )
            .join('')
        : '<p class="empty">没有订阅源</p>');
    $('#rssPrev') && ($('#rssPrev').onclick = () => { if (rssPage > 1) { rssPage--; loadRss(); } });
    $('#rssNext') && ($('#rssNext').onclick = () => { if (rssPage < rssTotal) { rssPage++; loadRss(); } });
    $('#rssLocalBtn').onclick = () => { rssMode = 'local'; loadRss(); };
    box.querySelectorAll('[data-rss]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-rss');
        const r2 = await run(`导入订阅源 ${id}…`, () => window.api.rssInstall(id, {}));
        if (!r2) return;
        toast(`订阅源导入：新增 ${r2.added}，更新 ${r2.updated}，跳过 ${r2.skipped}`, r2.added + r2.updated ? 'ok' : 'err');
        if (r2.items && r2.items.length) {
          modal({
            title: '订阅源导入明细',
            body: r2.items.map((x) => `<div>${x.ok ? '✅' : '⚠️'} ${esc(x.name)} — ${esc(x.reason)}</div>`).join(''),
            buttons: [{ text: '关闭', onClick: () => { closeModal(); rssMode = 'online'; loadRss(); } }],
          });
        }
      };
    });
  } else {
    const list = await window.api.rssList();
    box.innerHTML =
      `<div class="pane-toolbar" style="padding:0 0 8px">
         <button class="btn" id="rssOnlineBtn">← 返回在线列表</button>
         <span class="spacer"></span>
         <span class="hint">本地订阅源 ${list.length} 个</span>
       </div>` +
      (list.length
        ? list
            .map(
              (s) => `
        <div class="card" style="margin-bottom:8px">
          <div class="card-main">
            <div class="card-title">${esc(s.name)}</div>
            <div class="card-sub">${esc(s.url)}${s.group ? ' · ' + esc(s.group) : ''}</div>
          </div>
          <div class="card-actions">
            <button class="btn" data-rssdel="${esc(s.key)}">删除</button>
          </div>
        </div>`
            )
            .join('')
        : '<p class="empty">本地还没有订阅源</p>');
    $('#rssOnlineBtn').onclick = () => { rssMode = 'online'; loadRss(); };
    box.querySelectorAll('[data-rssdel]').forEach((btn) => {
      btn.onclick = async () => {
        const key = btn.getAttribute('data-rssdel');
        await window.api.rssRemove(key);
        toast('已删除', 'ok');
        loadRss();
      };
    });
  }
}

// 「订阅源」按钮：打开订阅源管理弹窗（含导入 JSON 入口）
$('#btnOnlineRss').onclick = () => {
  rssPage = 1;
  rssMode = 'online';
  modal({
    title: '订阅源（yckceo.com RSS）',
    body: '<p class="empty">加载中…</p>',
    buttons: [
      { text: '导入订阅源 JSON', onClick: importRssDialog },
      { text: '关闭', onClick: closeModal },
    ],
  });
  loadRss();
};

// 订阅源 JSON 导入对话框
async function importRssDialog() {
  closeModal();
  modal({
    title: '导入订阅源 JSON',
    body: `
      <p class="hint">粘贴 Legado 订阅源 JSON（sourceName/sourceUrl），或选择文件</p>
      <textarea class="input" id="rssImportText" rows="8" style="width:100%"></textarea>
      <div style="margin-top:8px"><button class="btn" id="rssPickFile">选择 JSON 文件…</button></div>`,
    buttons: [
      {
        text: '导入',
        class: 'primary',
        onClick: async () => {
          const text = $('#rssImportText').value.trim();
          if (!text) return toast('请先粘贴或选择 JSON', 'err');
          closeModal();
          const r = await run('导入订阅源…', () => window.api.rssImportText(text, {}));
          if (!r) return;
          toast(`订阅源导入：新增 ${r.added}，更新 ${r.updated}，跳过 ${r.skipped}`, r.added + r.updated ? 'ok' : 'err');
        },
      },
      { text: '取消', onClick: closeModal },
    ],
  });
  $('#rssPickFile').onclick = async () => {
    const files = await window.api.pickFiles();
    if (files && files.length) {
      $('#rssImportText').value = files[0].text || '';
    }
  };
}

/* ==================== 网页转书源 ==================== */

let agLast = null; // 最近一次生成结果 { source, steps, notes }

$('#btnOnlineAutogen').onclick = () => {
  agLast = null;
  modal({
    title: '网页转书源（自动嗅探）',
    body: `
      <div class="ag-bar">
        <input class="input grow" id="agUrl" placeholder="粘贴小说网址，如 https://www.xxx.com" />
        <button class="btn primary" id="agGo">开始嗅探</button>
      </div>
      <p class="hint">自动识别搜索接口、书籍列表、详情页、目录、正文；正文靠 JS/AJAX 加载的站点会被拒绝。</p>
      <div id="agSteps" class="ag-steps"></div>
      <pre class="ag-json" id="agJson" hidden></pre>`,
    buttons: [
      { text: '添加到书源', id: 'agAdd', onClick: agAddClick, disabled: true },
      { text: '关闭', onClick: closeModal },
    ],
  });
  $('#agGo').onclick = agRun;
  $('#agUrl').onkeydown = (e) => { if (e.key === 'Enter') agRun(); };
};

async function agRun() {
  const url = ($('#agUrl').value || '').trim();
  if (!/^https?:\/\//i.test(url)) return toast('请输入 http(s) 网址', 'err');
  const go = $('#agGo');
  go.disabled = true;
  agRenderSteps([{ step: '嗅探', ok: null, detail: '进行中：' + url }]);
  $('#agJson').hidden = true;
  agSetAdd(false);
  try {
    const r = await window.api.autogenSource(url, {});
    agLast = r && r.ok ? r : null;
    agRenderSteps((r && r.steps) || [{ step: '失败', ok: false, detail: (r && r.error) || '无结果' }]);
    if (r && r.ok && r.source) {
      const j = $('#agJson');
      j.hidden = false;
      j.textContent = JSON.stringify(r.source, null, 2);
      agSetAdd(true);
      const notes = (r.notes || []);
      toast('书源生成成功' + (notes.length ? `（${notes.length} 条提示）` : ''), 'ok');
    } else {
      const why = r && r.error ? r.error : '生成失败';
      const notes = (r && r.notes) || [];
      toast(why + (notes.length ? ' — ' + notes[0] : ''), 'err');
    }
  } catch (e) {
    agRenderSteps([{ step: '错误', ok: false, detail: e.message || String(e) }]);
  } finally {
    const g = $('#agGo');
    if (g) g.disabled = false;
  }
}

function agRenderSteps(steps) {
  const box = $('#agSteps');
  if (!box) return;
  box.innerHTML = (steps || []).map((s) => {
    const mark = s.ok === true ? '✓' : s.ok === false ? '✗' : '·';
    const cls = s.ok === true ? 'ag-ok' : s.ok === false ? 'ag-bad' : 'ag-run';
    return `<div class="ag-step ${cls}"><span class="ag-mark">${mark}</span><b>${esc(s.name || s.step || '')}</b><span class="ag-detail">${esc(s.detail || '')}</span></div>`;
  }).join('');
}

function agSetAdd(on) {
  const btn = $('#agAdd');
  if (btn) btn.disabled = !on;
}

async function agAddClick() {
  if (!agLast || !agLast.source) return toast('还没有可用的生成结果', 'err');
  const src = agLast.source;
  agLast = null;
  agSetAdd(false);
  closeModal();
  const r = await run('添加书源（自动探测）…', () => window.api.sourceAdd(src, {}));
  if (!r) return;
  if (r.added) toast(`已添加书源「${src.bookSourceName}」（探测 ${r.probe && r.probe.score != null ? r.probe.score : '?'} 分）`, 'ok');
  else toast(`未添加：${r.reason || '探测未通过'}`, 'err');
  loadSources();
}

/* ==================== 统计 ==================== */

$('#btnInfo').onclick = async () => {
  const i = await run(null, () => window.api.info());
  if (!i) return;
  $('#dataDir').textContent = i.dataDir;
  modal({
    title: '数据与统计',
    body: `
      <dl class="kv">
        <dt>数据目录</dt><dd>${esc(i.dataDir)}</dd>
        <dt>书源</dt><dd>共 ${i.sources.total} 个，已探测 ${i.sources.probed}，通过 ${i.sources.passed}</dd>
        <dt>书架</dt><dd>共 ${i.books} 本</dd>
        <dt>已下载</dt><dd>${i.chapters} 章</dd>
      </dl>
      <p class="hint" style="margin-top:14px">
        目录结构（JSON + 每章一个 txt，可人工检视、便于增量下载）：<br/>
        <code>sources/sources.json</code> 书源 · <code>shelf.json</code> 书架<br/>
        <code>books/&lt;id&gt;/meta.json|toc.json|chapters/N.txt|progress.json</code><br/>
        <code>export/</code> 导出的 TXT
      </p>`,
    buttons: [
      { text: '关闭', onClick: closeModal },
      { text: '打开数据目录', class: 'primary', onClick: () => window.api.openExternal('file:///' + i.dataDir.replace(/\\/g, '/')) },
    ],
  });
};

/* ==================== 主题切换入口 ==================== */

$('#btnTheme').onclick = toggleTheme;
// Alt+T 快捷键：看书时手动去点顶栏会打断阅读节奏
document.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 't' || e.key === 'T')) {
    e.preventDefault();
    toggleTheme();
  }
});

/* ==================== 阅读设置入口 ==================== */

$('#btnReaderSettings').onclick = readerSettingsDialog;
// Alt+R：阅读时调字号/字体不用离开键盘
document.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault();
    readerSettingsDialog();
  }
});

/* ==================== 浏览器 ==================== */
/**
 * 内置浏览器页签：<webview> 承载站点页面，本文件只做「地址栏 / 标签 / 书签」的外壳。
 *
 * 合规边界（用户已确认 m09121/m09122，勿改）：
 *   - 只把用户送到站点官方页面，登录、订阅、阅读都在站点网页里完成；
 *   - **不抓正文、不绕过付费墙**：这里没有任何读取 guest 页面 DOM 的代码，
 *     也没有把页面内容写进书架/数据库的路径。
 */

/** 本机是否为 Electron（<webview> 只有真实 Electron 里才存在，纯浏览器打开时降级） */
const BW_HAS_WEBVIEW = typeof window.api.browser !== 'undefined';

let bwSites = []; // 预置站点表（主进程下发）
let bwPolicy = ''; // 合规文案
let bwTabs = []; // [{id, url, title, loading, canGoBack, canGoForward}]
let bwActive = null; // 当前标签 id
let bwSeq = 0; // 标签 id 自增
let bwInit = false; // 是否已初始化过（只装一次事件监听）
let bwReadyPromise = null; // 首次初始化的 Promise（供 openSourceSite 等待）
let bwLoading = null; // 正在进行的首次初始化

/** 新标签 id */
function bwNewId() {
  bwSeq += 1;
  return 'bw' + bwSeq;
}

function bwTab(id) {
  return bwTabs.find((t) => t.id === id) || null;
}

function bwActiveTab() {
  return bwTab(bwActive);
}

/** 显示名：有标题用标题，没有就用主机名 */
function bwLabel(t) {
  if (t.title) return t.title;
  if (!t.url) return '新标签页';
  try {
    return new URL(t.url).hostname.replace(/^www\./, '');
  } catch (_) {
    return t.url;
  }
}

/** 该地址属于哪个预置站点（用于书签归类）；不属于返回 '' */
function bwSiteOf(url) {
  const u = String(url || '').toLowerCase();
  const hit = bwSites.find((s) => {
    try {
      return u.includes(new URL(s.home).hostname.toLowerCase());
    } catch (_) {
      return false;
    }
  });
  return hit ? hit.key : '';
}

/* ---------- 渲染：站点快捷按钮 ---------- */

function bwRenderSites() {
  const bar = $('#bwSiteBar');
  bar.innerHTML = '';
  for (const s of bwSites) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = s.name;
    btn.title = s.desc ? `${s.name} — ${s.desc}` : s.name;
    // 已开着该站点的标签就切过去，否则新开一个
    btn.onclick = () => bwOpenSite(s);
    bar.appendChild(btn);
  }
  // 合规提示也从主进程取，保证文字只有一处定义
  if (bwPolicy) $('#bwNotice').textContent = bwPolicy + '登录与订阅在站点网页内完成。';
}

/* ---------- 渲染：标签栏 ---------- */

function bwRenderTabs() {
  const box = $('#bwTabs');
  box.innerHTML = '';
  for (const t of bwTabs) {
    const el = document.createElement('div');
    el.className = 'bw-tab' + (t.id === bwActive ? ' active' : '');
    el.title = t.url || '新标签页';

    if (t.loading) {
      const dot = document.createElement('span');
      dot.className = 'bw-tab-dot';
      el.appendChild(dot);
    }
    const title = document.createElement('span');
    title.className = 'bw-tab-title';
    title.textContent = bwLabel(t);
    el.appendChild(title);

    const close = document.createElement('button');
    close.className = 'bw-tab-close';
    close.textContent = '×';
    close.title = '关闭标签';
    close.onclick = (e) => {
      e.stopPropagation();
      bwCloseTab(t.id);
    };
    el.appendChild(close);

    el.onclick = () => bwSelectTab(t.id);
    box.appendChild(el);
  }
}

/* ---------- 渲染：书签栏 ---------- */

async function bwRenderBookmarks() {
  const box = $('#bwBookmarks');
  const list = (await run(null, () => window.api.browser.bookmarks())) || [];
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<span class="hint">（点地址栏右侧「☆ 收藏」把当前页存下来）</span>';
    return;
  }
  for (const b of list) {
    const el = document.createElement('span');
    el.className = 'bw-bm';
    el.title = b.url;

    const title = document.createElement('span');
    title.className = 'bw-bm-title';
    title.textContent = b.title || b.url;
    title.onclick = () => bwGo(b.url);
    el.appendChild(title);

    const del = document.createElement('button');
    del.className = 'bw-bm-del';
    del.textContent = '×';
    del.title = '删除书签';
    del.onclick = async (e) => {
      e.stopPropagation();
      await run('删除书签…', () => window.api.browser.removeBookmark(b.url));
      bwRenderBookmarks();
    };
    el.appendChild(del);

    box.appendChild(el);
  }
}

/* ---------- 标签与 webview ---------- */

/** 新建标签；url 为空则停在空白页 */
function bwCreateTab(url) {
  const t = {
    id: bwNewId(),
    url: url || '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  bwTabs.push(t);

  // 建 <webview>：只给地址，不给 preload/node，页面拿不到任何本机能力
  const view = document.createElement('webview');
  view.className = 'bw-webview';
  view.setAttribute('data-tab', t.id);
  // 站点里的弹窗不另开窗口（主进程已 deny，这里再兜一层）
  view.setAttribute('allowpopups', 'false');

  /**
   * 关键：<webview> 必须有 src 才会初始化 guest 进程。
   * 没有 src 时元素永远停在「未附加」状态——dom-ready 不触发、
   * getWebContentsId() 抛异常、主进程 side 也就永远 bind 不上，
   * 表现就是「点站点按钮没反应 / 标签页还没准备好」。
   * 所以这里先给一个空白页启动 guest，真正的地址由 bind 成功后 navigate 过去。
   */
  view.setAttribute('src', t.url || 'about:blank');

  const stage = $('#bwStage');
  t.view = view;

  /**
   * 把 tabId ↔ guestId 绑上（主进程靠它把标签和 <webview> 关联起来）。
   * 先注册 dom-ready 再挂进 DOM：webview 一附加就可能立刻 ready，
   * 先 append 后监听会漏事件，标签永远绑不上、点站点按钮没反应。
   */
  const bindGuest = () => {
    if (t.bound) return; // 绑定只做一次，避免重复触发同一地址的导航
    try {
      const gid = view.getWebContentsId();
      t.bound = true;
      window.api.browser.bind(t.id, gid).then((r) => {
        if (r && r.bound && t.url) window.api.browser.navigate(t.id, t.url);
      });
    } catch (e) {
      // guest 还没就绪：这是**预期内**的——刚 append 的 webview 往往要等
      // dom-ready 才拿得到 id，下面的 dom-ready 监听会补上，不必刷警告。
    }
  };
  view.addEventListener('dom-ready', bindGuest);
  stage.appendChild(view);
  // 已就绪的情况下 dom-ready 不会再触发，补一次立即绑定
  bindGuest();

  bwTabsRefreshEmpty();
  return t;
}

/** 没有任何标签时显示占位提示 */
function bwTabsRefreshEmpty() {
  $('#bwEmpty').hidden = bwTabs.length > 0;
}

/** 切到某个标签 */
function bwSelectTab(id) {
  if (!bwTab(id)) return;
  bwActive = id;
  for (const t of bwTabs) {
    if (t.view) t.view.hidden = t.id !== id;
  }
  const t = bwTab(id);
  $('#bwAddress').value = t.url || '';
  bwRenderTabs();
  // 切过去时同步一次真实状态（用户可能在页面里点走了）
  if (t.url) {
    window.api.browser.state(id).then((st) => {
      if (st && st.url) bwApplyState(id, st);
    }).catch(() => {});
  }
}

/** 关闭标签 */
function bwCloseTab(id) {
  const idx = bwTabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const t = bwTabs[idx];
  if (t.view) {
    try {
      window.api.browser.unbind(id);
    } catch (_) {
      /* 绑没绑上都无所谓，关掉就行 */
    }
    t.view.remove();
  }
  bwTabs.splice(idx, 1);
  if (bwActive === id) {
    // 关掉当前标签后，优先接右邻，没有就接左邻
    const next = bwTabs[idx] || bwTabs[idx - 1] || null;
    if (next) bwSelectTab(next.id);
    else {
      bwActive = null;
      $('#bwAddress').value = '';
    }
  }
  bwTabsRefreshEmpty();
  bwRenderTabs();
  bwSaveSession();
}

/* ---------- 导航 ---------- */

/** 把状态应用到界面（地址栏、前进后退可用性、标签标题） */
function bwApplyState(tabId, st) {
  const t = bwTab(tabId);
  if (!t) return;
  if (st.url) t.url = st.url;
  if (typeof st.title === 'string' && st.title) t.title = st.title;
  if (typeof st.loading === 'boolean') t.loading = st.loading;
  if (typeof st.canGoBack === 'boolean') t.canGoBack = st.canGoBack;
  if (typeof st.canGoForward === 'boolean') t.canGoForward = st.canGoForward;
  if (tabId === bwActive) {
    $('#bwAddress').value = t.url || '';
    $('#bwBack').disabled = !t.canGoBack;
    $('#bwForward').disabled = !t.canGoForward;
  }
  bwRenderTabs();
}

/**
 * 在指定标签（默认当前标签）打开地址；没有标签就先建一个。
 * 地址先经主进程归一化（`qidian.com` → `https://qidian.com`）。
 */
async function bwGo(input, tabId) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return;
  const norm = await run(null, () => window.api.browser.normalize(raw));
  if (!norm || !norm.ok) {
    toast((norm && norm.error) || '网址无效', 'err');
    return;
  }
  let t = tabId ? bwTab(tabId) : bwActiveTab();
  if (!t) t = bwCreateTab(norm.url);
  else t.url = norm.url;
  if (t.id === bwActive) $('#bwAddress').value = norm.url;
  const r = await run(null, () => window.api.browser.navigate(t.id, norm.url));
  if (r && r.ok === false) toast(r.error || '打不开这个地址', 'err');
  bwRemember(t);
}

/** 打开预置站点：已开着就切过去，否则新标签 */
function bwOpenSite(site) {
  const existing = bwTabs.find((t) => t.url && bwSiteOf(t.url) === site.key);
  if (existing) {
    bwSelectTab(existing.id);
    bwGo(site.url, existing.id);
    return;
  }
  const t = bwCreateTab(site.url);
  bwSelectTab(t.id);
}

/**
 * 从「在线书源」列表跳到内置浏览器打开某个书源的网站。
 *
 * 地址用书源自身的 bookSourceUrl（往往就是站点根地址）。
 * host 与预置站点重合时复用那个标签，避免同一站点开一堆标签。
 */
async function openSourceSite(url, name) {
  const raw = String(url || '').trim();
  if (!raw) {
    toast('这个书源没有填写网站地址', 'err');
    return;
  }

  // 切到浏览器页。loadBrowser 首次进入要 await 拉站点表/恢复会话，
  // 必须等它完成——否则 bwSites 还是空的（host 匹配不上预置站点），
  // 而且它会补一个空白标签，抢在我们前面成为当前标签。
  switchView('browser');
  await bwEnsureReady();

  const host = hostOf(raw);
  const existing = bwSites.find((s) => hostOf(s.home) === host);
  if (existing) {
    bwOpenSite(existing);
    toast(`已在浏览器打开 ${existing.name}`, 'ok');
    return;
  }

  // 已开着同一站点的标签就切过去，否则在新标签里打开
  const opened = bwTabs.find((t) => t.url && hostOf(t.url) === host);
  if (opened) {
    bwSelectTab(opened.id);
    bwGo(raw, opened.id);
    return;
  }

  const t = bwCreateTab(raw);
  bwSelectTab(t.id);
  toast(`已在浏览器打开 ${name || host}`, 'ok');
}

/**
 * 等浏览器页就绪（站点表已拉到、初始标签已建）。
 * 把 loadBrowser 的首次初始化收成可等待的 Promise：多个调用共用同一个。
 */
function bwEnsureReady() {
  if (bwInit) return Promise.resolve();
  if (!bwReadyPromise) bwReadyPromise = loadBrowser().catch(() => {});
  return bwReadyPromise;
}

/** 取主机名（小写，去掉 www.）；解析不了返回 '' */
function hostOf(u) {
  try {
    return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}


/* ---------- 历史记录（只存地址/标题） ---------- */

/** 把当前页记进历史；只存「地址 + 标题」，重复地址由 store 自行去重 */
async function bwRemember(t) {
  if (!t || !t.url || /^about:/.test(t.url)) return;
  try {
    await window.api.browser.pushHistory({
      url: t.url,
      title: bwLabel(t),
      site: bwSiteOf(t.url),
    });
  } catch (_) {
    /* 记历史失败不影响浏览 */
  }
}

/* ---------- 会话（下次进来接上） ---------- */

async function bwSaveSession() {
  if (!bwInit || !bwTabs.length) return;
  try {
    await window.api.browser.saveSession(
      bwTabs.filter((t) => t.url).map((t) => ({ id: t.id, url: t.url, title: t.title }))
    );
  } catch (_) {
    /* 存会话失败不影响使用 */
  }
}

/* ---------- 更多：历史 / 清理 ---------- */

async function bwMoreDialog() {
  const hist = (await run(null, () => window.api.browser.history(50))) || [];
  const stats = (await run(null, () => window.api.browser.stats())) || { bookmarks: 0, history: 0 };
  const rows = hist.length
    ? hist
        .map(
          (h) =>
            `<div class="sr-line" data-url="${esc(h.url)}"><span class="sr-name">${esc(h.title || h.url)}</span><span class="dim">${esc(h.url)}</span></div>`
        )
        .join('')
    : '<p class="empty">还没有浏览记录</p>';
  modal({
    title: `浏览记录（书签 ${stats.bookmarks} 条 · 历史 ${stats.history} 条）`,
    body: `<div class="sr-list">${rows}</div>
      <p class="hint" style="margin-top:12px">
        这里只保存「地址 + 标题」，不保存网页正文。
      </p>`,
    buttons: [
      {
        text: '清空历史',
        onClick: async () => {
          await run('清空历史…', () => window.api.browser.clearHistory());
          closeModal();
          toast('历史已清空', 'ok');
        },
      },
      { text: '关闭', class: 'primary', onClick: closeModal },
    ],
  });
  // 点一条记录就跳过去
  $$('#modalBody .sr-line').forEach((el) => {
    el.style.cursor = 'pointer';
    el.onclick = () => {
      const url = el.dataset.url;
      closeModal();
      bwGo(url);
    };
  });
}

/* ---------- 事件订阅 ---------- */

function bwInstallEvents() {
  if (bwInit) return;
  bwInit = true;

  // guest 的导航状态回传：地址栏、前进后退、标签标题都跟着走
  window.api.browser.onEvent((ev) => {
    if (!ev || !ev.tabId) return;
    const t = bwTab(ev.tabId);
    if (!t) return;
    if (ev.type === 'title' && ev.title) {
      t.title = ev.title;
      bwRenderTabs();
      return;
    }
    if (ev.type === 'fail') {
      t.loading = false;
      toast(ev.error || '页面加载失败', 'err');
      bwRenderTabs();
      return;
    }
    bwApplyState(ev.tabId, {
      url: ev.url,
      title: ev.title,
      loading: ev.type === 'loading' ? true : ev.type === 'loaded' ? false : t.loading,
      canGoBack: ev.canGoBack,
      canGoForward: ev.canGoForward,
    });
    // 一次导航稳定后记一条历史（只记地址 + 标题）
    if (ev.type === 'loaded' && ev.url) {
      bwRemember(t);
      bwSaveSession();
    }
  });

  // 站点里 target=_blank 想开新标签
  window.api.browser.onOpenTab((ev) => {
    if (!ev || !ev.url) return;
    const t = bwCreateTab(ev.url);
    bwSelectTab(t.id);
  });
}

/* ---------- 页签初始化 ---------- */

async function loadBrowser() {
  // 只在第一次进入时读站点表 / 恢复会话；之后切回来直接复用现有标签，
  // 否则每点一次「浏览器」页签都会新建一批 <webview>（guest 进程泄漏）。
  if (!bwInit) {
    // 并发进入（例如从「在线书源」点打开网站，同时又点了页签）时只跑一次
    if (bwLoading) return bwLoading;
    bwLoading = (async () => {
      try {
        await bwFirstInit();
      } finally {
        bwLoading = null;
      }
    })();
    return bwLoading;
  }

  // 再次进入：保持当前标签与地址栏内容即可
  if (bwActive) bwSelectTab(bwActive);
}

/** 浏览器页的首次初始化：拉站点表、恢复会话、装事件 */
async function bwFirstInit() {
  const info = await run('读取站点…', () => window.api.browser.listSites());
  if (info) {
    bwSites = info.sites || [];
    bwPolicy = info.policy || '';
  }
  bwRenderSites();
  bwInstallEvents();

  // 首次进入：恢复上次的标签；没有就开一个空白标签
  if (!bwTabs.length) {
    const saved = (await run(null, () => window.api.browser.session())) || [];
    for (const s of saved) {
      const t = bwCreateTab(s.url);
      if (s.title) t.title = s.title;
    }
    if (!bwTabs.length) bwCreateTab('');
    bwSelectTab(bwTabs[bwTabs.length - 1].id);
  }

  bwRenderBookmarks();
  bwTabsRefreshEmpty();
  $('#bwBack').disabled = true;
  $('#bwForward').disabled = true;
}

/* ---------- 界面绑定（只绑一次） ---------- */

$('#bwGo').onclick = () => bwGo($('#bwAddress').value);
$('#bwAddress').onkeydown = (e) => {
  if (e.key === 'Enter') bwGo($('#bwAddress').value);
};
$('#bwBack').onclick = () => { if (bwActive) window.api.browser.back(bwActive); };
$('#bwForward').onclick = () => { if (bwActive) window.api.browser.forward(bwActive); };
$('#bwReload').onclick = () => { if (bwActive) window.api.browser.reload(bwActive, false); };
$('#bwStop').onclick = () => { if (bwActive) window.api.browser.stop(bwActive); };
$('#bwNewTab').onclick = () => bwSelectTab(bwCreateTab('').id);
$('#bwMore').onclick = bwMoreDialog;

/** 收藏 / 取消收藏当前页 */
$('#bwStar').onclick = async () => {
  const t = bwActiveTab();
  if (!t || !t.url) {
    toast('当前没有可收藏的页面', 'err');
    return;
  }
  const r = await run('收藏…', () =>
    window.api.browser.addBookmark({ url: t.url, title: bwLabel(t), site: bwSiteOf(t.url) })
  );
  if (!r) return;
  toast(r.added ? '已加入书签' : r.reason || '已在书签里', r.added ? 'ok' : '');
  bwRenderBookmarks();
};

/** 用系统浏览器打开当前页（内置视图打不开时的退路） */
$('#bwOpenSystem').onclick = async () => {
  const t = bwActiveTab();
  if (!t || !t.url) {
    toast('当前没有可打开的页面', 'err');
    return;
  }
  await run(null, () => window.api.browser.openInSystem(t.url));
};

// 离开浏览器页签时把标签存下来，下次进来能接上
window.addEventListener('beforeunload', () => {
  if (bwInit) bwSaveSession();
});



(async function init() {
  const i = await window.api.info();
  if (i) $('#dataDir').textContent = i.dataDir;
  // 阅读偏好先应用，再开书，避免第一屏用默认字号闪一下
  readerPref = readReaderPref();
  applyReaderPref();
  // 书架排序方式回填到下拉框（查看方式由 renderShelf 的 applyShelfLayout 处理）
  $('#shelfSort').value = shelfSort;
  await fillSourceSelect();
  switchView('shelf');
})();
