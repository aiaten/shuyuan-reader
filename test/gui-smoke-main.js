'use strict';
/**
 * 在 Electron 主进程里跑的 GUI 冒烟检查（由 test/gui-smoke.js 拉起）。
 * 直接复用 electron/main.js 的窗口，额外插入渲染进程断言。
 *
 * 注意：Windows 下 Electron 是独立 GUI 子进程，stdout 不会被父进程收到，
 * 因此结果同时写入文件（路径由 SHUYUAN_SMOKE_OUT 指定）与 stdout。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, webContents } = require('electron');

const OUT = process.env.SHUYUAN_SMOKE_OUT || path.join(os.tmpdir(), 'shuyuan-gui-smoke.json');

/** 结果落到文件，父进程轮询读取 */
function report(obj) {
  try {
    fs.writeFileSync(OUT, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    /* ignore */
  }
  console.log('SMOKE_RESULT ' + JSON.stringify(obj));
}

// 数据目录隔离，避免污染真实数据。
// 必须每次运行前清空——否则上一轮留下的书源/已下载章节会让断言失去意义
// （例如「探测闸门：手写书源被接受」会变成「书源已存在」）。
const SMOKE_DATA = path.join(os.tmpdir(), 'shuyuan-gui-smoke');
try {
  fs.rmSync(SMOKE_DATA, { recursive: true, force: true });
} catch (e) {
  /* ignore */
}
process.env.SHUYUAN_DATA = SMOKE_DATA;

// 复用生产 main.js（它会注册IPC 并建窗口）
require(path.join(__dirname, '..', 'electron', 'main.js'));

// SEED（m04946 标红验证）：给「最终小说网」的线上 URL 预置一条「不允许添加」的探测
// 记录（渲染进程拿不到 fs，必须在主进程写）。真立URL 归一 key 与probeStatusMap 一致。
const seedProbe = async () => {
  const { App } = require(path.join(__dirname, '..', 'src', 'app'));
  const app = new App({ dataDir: SMOKE_DATA });
  const on = await require(path.join(__dirname, '..', 'src', 'source', 'yck')).list({ page: 1, keys: '最终小说网' });
  const it = (on.items || []).find((x) => /最终小说网/.test(x.name || ''));
  if (!it) return { seeded: false, reason: 'online list miss' };
  const ukey = String(it.url || '').trim().replace(/\/+$/, '').toLowerCase();
  const { SourceStore } = require(path.join(__dirname, '..', 'src', 'source', 'store'));
  const st = new SourceStore(SMOKE_DATA);
  st.saveProbeResult(ukey, {
    ok: false, score: 25, elapsed: 500,
    stages: {
      reach: { ok: true, count: 1, chars: 1000 },
      search: { ok: false, count: 0, chars: 0, message: '搜索「剑」无结果' },
    },
    errors: ['搜索与发现均无法取回书籍列表 →不允许添加'],
    warnings: [],
  });
  return { seeded: true, key: ukey };
};

/**
 * 换源用例需要「多源都收录同一本书」，而冒烟库每次都被清空、只靠在线列表临时装源
 * （站点一抖就装不上，断言会假失败）。这里直接从仓库 data/ 里挑几个**真实可用**的书源
 * 预置进去，让换源用例不依赖外部站点的即时可用性。
 */
const seedSwitchSources = () => {
  const { SourceStore } = require(path.join(__dirname, '..', 'src', 'source', 'store'));
  const repoData = path.join(__dirname, '..', 'data', 'sources', 'sources.json');
  let all = [];
  try { all = JSON.parse(fs.readFileSync(repoData, 'utf8')); } catch (e) { return { seeded: 0, err: e.message }; }
  // 选实测能搜到《诡秘之主》的源
  const WANT = [/最终小说网/, /^\s*📖笔趣阁/, /五八书阁/, /ryw笔趣阁78/];
  const picked = [];
  for (const re of WANT) {
    const s = all.find((x) => re.test(String(x.bookSourceName || '')) && x.searchUrl
      && !picked.some((p) => p.bookSourceUrl === x.bookSourceUrl));
    if (s) picked.push(s);
  }
  if (!picked.length) return { seeded: 0 };
  const st = new SourceStore(SMOKE_DATA);
  const existing = st.all();
  const have = new Set(existing.map((s) => String(s.bookSourceUrl || '').toLowerCase()));
  const merged = existing.concat(picked.filter((s) => !have.has(String(s.bookSourceUrl || '').toLowerCase())));
  fs.writeFileSync(st.file, JSON.stringify(merged, null, 2), 'utf8');
  // 这些源预置为「允许添加」，跳过探测闸门
  for (const s of picked) {
    const k = String(s.bookSourceUrl || '').trim().replace(/\/+$/, '').toLowerCase();
    st.saveProbeResult(k, {
      ok: true, score: 100, elapsed: 300,
      stages: { reach: { ok: true, count: 1, chars: 1000 }, search: { ok: true, count: 5, chars: 2000 } },
      errors: [], warnings: [],
    });
  }
  return { seeded: picked.length, names: picked.map((s) => s.bookSourceName) };
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let r_seed = null;

/** 断言脚本：在渲染进程里跑，返回结构化结果 */
const PROBE = `(async () => {
  // 看门狗：任何一步（尤其真网请求）卡住都不能变成「没有结果文件」这种无信息失败。
  // 超时后把已跑到的段落信息带出来，主进程照常断言并打印。
  const __watch = (ms) => new Promise((res) => setTimeout(() => res({ __timeout: true }), ms));
  const __body = async () => {

  console.log('[PROBE] start');
  // 各段落耗时：整体必须压在 MAX_MS（120s）以内，超时会让整个冒烟「没有结果文件」。
  // 出问题时先看这里的分布，别靠猜。
  const __t0 = Date.now();
  const seg = (name) => { (r.seg = r.seg || {})[name] = Date.now() - __t0; };
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  const r = { apiKeys: [], info: null, sources: null, online: null, views: [], caps: {}, func: {} };
  try {
    r.apiKeys = Object.keys(window.api || {}).sort();
    r.info = await window.api.info();
    r.sources = await window.api.sourceList();
    const on = await window.api.onlineList({ page: 1, keys: '最终小说网' });
    r.online = { count: on.items.length, totalPages: on.totalPages, first: on.items[0] && on.items[0].name };
    // 视图切换
    for (const v of ['shelf', 'search', 'sources', 'online']) {
      const btn = document.querySelector('.tab[data-view="' + v + '"]');
      if (btn) { btn.click(); await new Promise((s) => setTimeout(s, 120)); }
      const pane = document.getElementById('view-' + v);
      r.views.push({ view: v, active: !!(pane && pane.classList.contains('active')) });
    }
    // DOM 关键节点存在态
    for (const sel of ['#shelfList', '#sourceList', '#onlineList', '#searchList', '#modalMask', '#busy', '#toastWrap']) {
      r.caps[sel] = !!document.querySelector(sel);
    }

    // ---- 功能性检查：可读性探测闸门（交付点③）----
    // 0) 在线列表标红（m04946）必须在探测闸门之前断言：GUI 自写源与 seed 植入的是同一个 URL
    //    （zuizhong.net），真网探测会把 probe.json 里的拒绝记录覆盖成满分，标红就验不到了。
    //    （zuizhong.net），真网探测会把 probe.json 里的拒绝记录覆盖成满分，标红就验不到了。
    //    此刻 probe.json 只含主进程seedProbe() 植入的「不允许添加」记录。
    const on0 = await window.api.onlineList({ page: 1, keys: '最终小说网' });
    const zzz = on0 && on0.items && on0.items.find((x) => /最终小说网/.test(x.name || ''));
    r.func.zzzFound = !!zzz;
    document.querySelector('.tab[data-view="online"]').click();
    const keysInput = document.querySelector('#onlineKeys');
    keysInput.value = '最终小说网';
    // 点「搜索」会覆盖视图切换时 loadOnline() 触发的那次「无关键词」请求，
    // 但两次请求都在飞：若旧请求后回来，会把带 filtered 结果的列表重渲染成第一页，
    // 但两次请求都在飞：若旧请求后回来，会把带 filtered 结果的列表重渲染成第一页，
    // 于是 .card.rejected 消失。固定 sleep 无法消除这个竞态（真网站响应 2.5–10s），
    // 所以改成轮询「结果稳定」：等到列表里出现最终小说网卡片、且连续两次 DOM 快照一致为止。
    document.querySelector('#btnOnlineSearch').click();
    const snap = () => {
      const cards = [...document.querySelectorAll('#onlineList .card')];
      return cards.length + '|' + cards.map((c) => (c.querySelector('.card-title') || {}).textContent || '').join(',');
    };
    let prev = null;
    let stable = 0;
    let snapSeen = 0;      // 观察到的不同快照数
    let lastChange = -1;   // 最后一次快照变化的轮次
    for (let i = 0; i < 60; i++) {
      // 最多等 30s：真网单页 2.5–10s，加上「切视图触发的旧请求」可能晚回包。
      // eslint-disable-next-line no-await-in-loop
      await new Promise((s) => setTimeout(s, 500));
      const cur = snap();
      // 注意：keys 是发给远端的搜索词，不是本地子串过滤，命中可能有上百条，
      // 所以只要求「含最终小说网」+「连续两次一致」。
      // 但要排除旧请求回包造成的畸形快照：列表被重渲染成两页拼接
      // （100+100=200 条上下），那种「稳定」是假的，会让 rejected 卡片被多算。
      const count = Number(cur.split('|')[0]);
      const sane = count > 0 && count <= 100;
      if (cur !== prev) { snapSeen++; lastChange = i; }
      if (cur === prev && sane && /最终小说网/.test(cur)) { stable++; if (stable >= 2) break; } else { stable = 0; }
      prev = cur;
    }
    r.func.listSettled = stable >= 2;
    r.func.listSnapshot = prev;
    r.func.listSnapDistinct = snapSeen;
    r.func.listSnapLastChange = lastChange;
    const rejCards = document.querySelectorAll('#onlineList .card.rejected');
    r.func.rejectedCards = rejCards.length;
    r.func.rejectedFirst = rejCards[0]
      ? {
          title: rejCards[0].querySelector('.card-title') && rejCards[0].querySelector('.card-title').textContent,
          hasBadge: !!rejCards[0].querySelector('.badge.err'),
        }
      : null;
    const psm = await window.api.probeStatus();
    const normSlash = (u) => (u.endsWith('/') ? u.slice(0, -1) : u); // PROBE 模板串内禁用反斜杠转义
    const ukey0 = zzz ? normSlash(String(zzz.url).trim()).toLowerCase() : '';
    r.func.probeStatusHasRejected = !!(zzz && psm && psm[ukey0] && psm[ukey0].allowed === false);

    // 1) 结构非法 + 域名不存在的书源，必须被拒绝且不落盘
    const before = (await window.api.sourceList()).length;
    const bad1 = await window.api.sourceAdd({ bookSourceName: 'GUI坏源-结构', bookSourceUrl: 'not-a-url' }, {});
    r.func.badShapeRejected = bad1 && bad1.added === false;
    r.func.badShapeReason = (bad1 && bad1.reason) || '';
    const bad2 = await window.api.sourceAdd({
      bookSourceName: 'GUI坏源-域名',
      bookSourceUrl: 'https://this-host-does-not-exist-9f8a7b.invalid',
      searchUrl: 'https://this-host-does-not-exist-9f8a7b.invalid/s?q={{key}}',
      ruleToc: { chapterList: '.x', chapterName: 'text', chapterUrl: 'href' },
      ruleContent: { content: '#c@text' },
    }, {});
    r.func.badHostRejected = bad2 && bad2.added === false;
    r.func.badHostHasProbe = !!(bad2 && bad2.probe);
    const after = (await window.api.sourceList()).length;
    r.func.storeUnchanged = before === after;
    r.func.beforeCount = before;
    r.func.afterCount = after;

    // 2) 结构合法 + 站点可达 + 规则可用的书源，必须探测通过并落盘
    //    bookSourceName 用不会与 seedSwitchSources 预置源撞的名字。
    //    bookSourceUrl 必须**真实可达**（reach 是硬门槛），同时又要与预置源区分开：
    //    给同一个站点的根地址加一个无副作用的查询串即可（服务端忽略它，但 key 不同）。
    const good = {
      bookSourceName: 'GUI自写源-闸门用例',
      bookSourceUrl: 'https://www.zuizhong.net/?gui-gate=probe',
      enabledExplore: false,
      searchUrl: 'https://www.zuizhong.net/search.html,{"method":"POST","body":"s={{key}}"}',
      ruleSearch: {
        bookList: '.txt-list@li', name: 'a.0@text', author: 'a.1@text',
        kind: '.s1@text##[\\\\[\\\\]]', lastChapter: 'a.2@text', intro: '', coverUrl: '', bookUrl: 'a.0@href',
      },
      ruleBookInfo: {
        name: '[property="og:novel:book_name"]@content',
        author: '[property="og:novel:author"]@content',
        intro: '[property="og:description"]@content',
        kind: '[property~=category|status|update_time]@content',
        lastChapter: '[property~=las?test_chapter_name]@content',
        tocUrl: 'text.目录@href@', coverUrl: '[property="og:image"]@content',
      },
      ruleToc: { chapterList: '.info_dv3.1@ul@a', chapterName: 'text', chapterUrl: 'href', nextTocUrl: 'option[selected]+option@value' },
      ruleContent: { content: '.info_dv1@p[1:-2]@text', nextContentUrl: 'text.下一页@href' },
      ruleExplore: [],
    };
    const addRes = await window.api.sourceAdd(good, { keyword: '诡秘之主' });
    r.func.goodAdded = !!(addRes && addRes.added);
    r.func.goodReason = (addRes && addRes.reason) || '';
    r.func.goodScore = addRes && addRes.probe ? addRes.probe.score : null;
    r.func.goodStages = addRes && addRes.probe
      ? Object.fromEntries(Object.entries(addRes.probe.stages).map(([k, v]) => [k, !!v.ok]))
      : null;
    r.func.afterGoodCount = (await window.api.sourceList()).length;
    // 前置 seedSwitchSources 可能已经把同一 URL 的源预置进库（key 是 bookSourceUrl），
    // 那样 sourceAdd 会以「书源已存在」返回 added=false —— 这是测试自身的顺序耦合，
    // 不是探测闸门坏了。这里单独记录「是否本来就已存在」，供断言区分两种情况。
    r.func.goodAlreadyExisted = /已存在/.test(r.func.goodReason || '');

    // ---- 功能性检查：搜索 →加书构→下载 →导出 TXT（交付点 ②④）---
    // 注意签名：addToShelf(key, book, opts) / download(id, opts) / exportBook(id, opts)
    const groups = await window.api.searchAll('诡秘之主', null, 1);
    const g0 = (groups || []).find((g) => g.ok && g.list && g.list.length);
    r.func.searchCount = g0 ? g0.list.length : 0;
    if (g0) {
      const book = g0.list[0];
      r.func.searchFirst = book.name;
      const added = await window.api.addToShelf(g0.sourceKey, book, { download: false });
      r.func.shelfAddOk = !!(added && added.id);
      r.func.shelfChapterCount = added && added.chapterCount;
      const bid = added && added.id;
      r.func.shelfBookId = bid;
      if (bid) {
        // 只下 2 章，够验证导出即可
        const dl = await window.api.download(bid, { from: 0, to: 1 });
        r.func.dlDone = dl && dl.done;
        r.func.dlFailed = dl && dl.failed;
        const exp = await window.api.exportBook(bid, { layout: 'single', encoding: 'utf-8' });
        r.func.exportOk = !!(exp && (exp.files || []).length);
        r.func.exportBytes = exp && exp.files && exp.files[0] ? exp.files[0].bytes : null;
        r.func.exportPath = exp && exp.files && exp.files[0] ? exp.files[0].path : null;
        r.func.exportChapters = exp && exp.chapters;
        // 导出文件必须真的在磁盘上，且内容非空
        const rec = await window.api.book(bid);
        r.func.bookName = rec && rec.name;
        r.func.bookDownloaded = rec && rec.downloadedCount;

        // ---- 下载页签（后台队列 / 不再卡书架）----
    // 关键行为：点「下载」只入队立刻返回，进度在「下载」页签里看。
    try {
      const dlq = (r.func.dlq = {});
      const tab = document.querySelector('.tab[data-view="downloads"]');
      dlq.tab = !!tab;
      dlq.tabText = tab ? (tab.textContent || "").trim() : "";
      dlq.panel = !!document.querySelector("#view-downloads");
      dlq.list = !!document.querySelector("#dlList");
      dlq.refreshBtn = !!document.querySelector("#btnDlRefresh");
      dlq.clearBtn = !!document.querySelector("#btnDlClear");
      dlq.filter = !!document.querySelector("#dlFilter");
      // 入队必须「立刻」返回：120ms 预算足够跨一次 IPC，远不足以跑完真站下载。
      // 以前就是 await 整个下载过程，界面被遮罩锁死（用户反馈的「点下载就卡住」）。
      const t0 = Date.now();
      let job = null, err = "";
      try {
        job = await window.api.enqueueDownload(bid, { from: 0, to: 1 });
      } catch (e) { err = (e && e.message) || String(e); }
      dlq.enqueueMs = Date.now() - t0;
      dlq.enqueueErr = err;
      dlq.jobId = job && job.id;
      dlq.jobBookId = job && job.bookId;
      dlq.jobStatus = job && job.status;
      const snap = await window.api.listDownloads();
      const jobs = (snap && snap.jobs) || [];
      dlq.count = jobs.length;
      dlq.hasJob = !!jobs.find((j) => j.id === (job && job.id));
      dlq.summary = snap && snap.summary;
      // 渲染层：切到下载页签，列表里应有这一行且带进度元素
      if (tab) tab.click();
      await new Promise((res) => setTimeout(res, 500));
      const row = document.querySelector("#dlList .dl-job[data-job], #dlList .card");
      dlq.rowRendered = !!row;
      dlq.rowText = row ? (row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
      dlq.progressEl = !!document.querySelector("#dlList .dl-bar-in, #dlList .dl-pct");
    } catch (e) {
      r.func.dlq = r.func.dlq || {};
      r.func.dlq.blockThrew = String((e && e.message) || e);
    }

    // ---- 懒加载滑动窗口（m07558）----
        // 1) 加书架时只下前 10 章（而不是全书）
        const added2 = await window.api.addToShelf(g0.sourceKey, book, { download: true });
        const w0 = added2 && added2.download;
        r.func.winInitialFrom = w0 && w0.from;
        r.func.winInitialTo = w0 && w0.to;
        r.func.winInitialDone = w0 && w0.done;
        r.func.winInitialSkipped = w0 && w0.skipped;
        r.func.winTotal = added2 && added2.chapterCount;
        // 本轮之前已下这 0-1 章 → 窗口应「只补缺的」，而不是重下
        r.func.winCovered = (w0 ? w0.done + w0.skipped : 0);
        // 2) 读到第3 章→应补第4..13 章（不吃已读的第 3 章）
        const w1 = await window.api.downloadWindow(bid, 3, {});
        r.func.winReadFrom = w1 && w1.from;
        r.func.winReadTo = w1 && w1.to;
        // 3) 同一位置再调 →全已下载，应报告 empty
        const w2 = await window.api.downloadWindow(bid, 3, {});
        r.func.winRepeatEmpty = !!(w2 && (w2.empty || w2.skipped));
        // 4) busy 状态查询可用（完成态应为 false）
        const busy = await window.api.windowBusy(bid);
        r.func.winBusyAfter = !!(busy && busy.busy);
      }
    }

    // ---- 功能性检查：在线「更新/ 校验 / 订阅源」（m04402） ----
    // 1) 三按钮挂在DOM 上（onclick 在app.js 模块加载时绑定，若加载报错后面全挂）
    for (const sel of ['#btnOnlineUpdate', '#btnOnlineCheck', '#btnOnlineRss']) {
      const b = document.querySelector(sel);
      r.func[sel] = !!(b && typeof b.onclick === 'function');
    }
    // 2) 校验书源：只校验刚加的 GUI 自写源（zuizhong.net，关键词「剑」可命中）
    const chk = await window.api.sourceCheck({ keys: ['https://www.zuizhong.net'], keyword: '剑' });
    r.func.check = {
      total: chk && chk.total,
      passed: chk && chk.passed,
      first: chk && chk.results && chk.results[0] ? { name: chk.results[0].name, ok: chk.results[0].ok } : null,
    };
    // 3) 更新： 天窗可+ 免探测（快速冒烟；真网可能有0~N 条新源）
    const sync = await window.api.onlineSyncUpdates({ days: 1, pages: 1, probe: false });
    r.func.sync = {
      checked: sync && sync.checked,
      items: sync && sync.items ? sync.items.length : -1,
      added: sync && sync.added,
    };
    // 4) 订阅源：在线列表 →安装 193 →文本导入 →本地列表 →清理
    const rssOn = await window.api.rssOnlineList({ page: 1 });
    r.func.rssOnline = { count: rssOn && rssOn.items ? rssOn.items.length : 0, first: rssOn && rssOn.items && rssOn.items[0] ? rssOn.items[0].name : '' };
    const rssInst = await window.api.rssInstall(193, {});
    r.func.rssInstall = { added: rssInst && rssInst.added, name: rssInst && rssInst.items && rssInst.items[0] ? rssInst.items[0].name : '' };
    const rssImp = await window.api.rssImportText('[{"sourceName":"烟测订阅","sourceUrl":"https://example.com/rss"}]', {});
    r.func.rssImportAdded = rssImp && rssImp.added;
    const rssLocal = await window.api.rssList();
    r.func.rssLocalCount = rssLocal.length;
    r.func.rssRemove1 = await window.api.rssRemove('https://example.com/rss');
    r.func.rssRemove2 = await window.api.rssRemove('http://yckceo.vip');
    r.func.rssLocalAfter = (await window.api.rssList()).length;

    // ---- m06856 三功能：备用线路 / 全书源搜索/ 提选----
    // 1) 线路：不联网只读当前 activeBase，必须报出主站与备用站候选
    const rt = await window.api.onlineRoute({});
    r.func.route = {
      shuyuan: rt && rt.shuyuan,
      rss: rt && rt.rss,
      candShuyuan: rt && rt.candidates && rt.candidates.shuyuan,
      candRss: rt && rt.candidates && rt.candidates.rss,
      ok: !!(rt && rt.ok),
    };
    const routeBar = document.querySelector('#onlineRouteBar');
    r.func.routeBarExists = !!routeBar;
    // 2) 线路强制重探：真网，必须命中 yck 家族域名之一
    // 真网重探：站点偶发不响应时 yck.list 可能长时间挂着（实测会超过 MAX_MS）。
    // 这里给它一个硬上限，超时按「本次没探出来」记，不让整个冒烟变成「没有结果文件」。
    const rtRetry = await Promise.race([
      window.api.onlineRoute({ retry: true, check: true }),
      new Promise((res) => setTimeout(() => res({ ok: false, checked: false, error: "route-retry-timeout" }), 45000)),
    ]);
    r.func.routeRetry = {
      ok: !!(rtRetry && rtRetry.ok),
      shuyuan: rtRetry && rtRetry.shuyuan,
      checked: !!(rtRetry && rtRetry.checked),
      error: (rtRetry && rtRetry.error) || '',
      isYck: /yck/i.test(String((rtRetry && rtRetry.shuyuan) || '')),
    };
    // 3) 全书源搜索：模式选择器+ 按钮 + 流式事件 + 聚合结果
    //    （没有独立的「全书源」按钮：由#searchMode 的all/one 决定资searchEverywhere 还是 searchOne，
    const ewMode = document.querySelector('#searchMode');
    const ewBtn = document.querySelector('#btnSearch');
    r.func.ewBtnExists = !!(ewMode && ewBtn);
    r.func.ewModeAll = !!(ewMode && ewMode.querySelector('option[value="all"]'));
    r.func.ewModeOne = !!(ewMode && ewMode.querySelector('option[value="one"]'));
    const ewEvents = [];
    const ewOff = window.api.onSearchEvent((ev) => ewEvents.push({ type: ev.type, ok: !!ev.ok, count: ev.count || 0 }));
    const t0 = Date.now();
    const ew = await Promise.race([
      window.api.searchEverywhere('诡秘之主', {
        page: 1, concurrency: 6, perSourceTimeout: 8000, totalTimeout: 20000,
      }),
      new Promise((res) => setTimeout(() => res({ ok: false, total: 0, groups: [], sources: [], elapsed: 60000 }), 60000)),
    ]);
    const ewElapsed = Date.now() - t0;
    if (ewOff) ewOff();
    const ewG0 = ew && ew.groups && ew.groups[0];
    r.func.ew = {
      total: ew && ew.total,
      ok: ew && ew.ok,
      failed: ew && ew.failed,
      groups: ew && ew.groups ? ew.groups.length : -1,
      sources: ew && ew.sources ? ew.sources.length : -1,
      elapsed: ew && ew.elapsed,
      events: ewEvents.length,
      startEvents: ewEvents.filter((e) => e.type === 'start').length,
      resultEvents: ewEvents.filter((e) => e.type === 'result').length,
      // mergeBookGroups 的字段名是offers / sourceCount（不是list / sources（
      firstGroupOffers: ewG0 ? (ewG0.offers || []).length : 0,
      firstGroupSourceCount: ewG0 ? ewG0.sourceCount : 0,
      firstGroupTitle: ewG0 ? ewG0.title : '',
      maxOffers: ew && ew.groups ? Math.max(0, ...ew.groups.map((g) => (g.offers || []).length)) : 0,
    };
    r.func.ewElapsed = ewElapsed;
    // 并发提速证据：总耗时必须明显小于「各源耗时之和。
    const sumSrc = (ew && ew.sources ? ew.sources : []).reduce((a, s) => a + (s.ms || 0), 0);
    r.func.ewSumSrcMs = sumSrc;
    // 4) 本地书架搜索提速：searchAll 单次计时（并验证短缓存）
    const t1 = Date.now();
    const sa = await window.api.searchAll('诡秘之主', null, 1);
    r.func.saElapsed = Date.now() - t1;
    r.func.saGroups = (sa || []).length;
    r.func.saOk = (sa || []).filter((g) => g.ok).length;

    // ---- m09109 需求①：书架查看方式（列表 / 图标） ----
    // 整块 try/catch：这是纯界面断言，任何一步抛错都不该把后面所有用例一起带走
    // （历史上出现过一处异常导致 76 项连锁失败，极难定位）。
    try {
      const shelfTab = document.querySelector('.tab[data-view="shelf"]');
      if (shelfTab) { shelfTab.click(); await new Promise((s) => setTimeout(s, 900)); }
      const seg = document.querySelector('#shelfLayout');
      const btns = seg ? Array.from(seg.querySelectorAll('.seg-btn')) : [];
      r.func.layout = {
        segFound: !!seg,
        btnCount: btns.length,
        values: btns.map((b) => b.dataset.layout),
        activeAtStart: (seg ? (seg.querySelector('.seg-btn.active') || {}).dataset : undefined)
          ? seg.querySelector('.seg-btn.active').dataset.layout : null,
      };
      const listBox = document.querySelector('#shelfList');
      r.func.layout.cardsAtStart = listBox ? listBox.querySelectorAll('.card').length : -1;
      // 切到图标模式
      const gridBtn = btns.find((b) => b.dataset.layout === 'grid');
      if (gridBtn) {
        gridBtn.click();
        await new Promise((s) => setTimeout(s, 350));
        r.func.layout.gridClass = !!(listBox && listBox.classList.contains('grid'));
        r.func.layout.gridActive = gridBtn.classList.contains('active');
        r.func.layout.coversInGrid = listBox ? listBox.querySelectorAll('.card .cover').length : -1;
        r.func.layout.cardsInGrid = listBox ? listBox.querySelectorAll('.card').length : -1;
        r.func.layout.persisted = (() => { try { return localStorage.getItem('shuyuan.shelfLayout'); } catch (e) { return 'err-' + e.message; } })();
        // 切回列表
        const listBtn = btns.find((b) => b.dataset.layout === 'list');
        if (listBtn) {
          listBtn.click();
          await new Promise((s) => setTimeout(s, 300));
          r.func.layout.listClassBack = !!(listBox && !listBox.classList.contains('grid'));
          r.func.layout.coversInList = listBox ? listBox.querySelectorAll('.card .cover').length : -1;
        }
      }
      // 排序下拉
      const sortSel = document.querySelector('#shelfSort');
      r.func.layout.sortFound = !!sortSel;
      if (sortSel) {
        r.func.layout.sortOptions = Array.from(sortSel.options).map((o) => o.value);
        const before = listBox ? Array.from(listBox.querySelectorAll('.card-title')).map((e) => e.textContent) : [];
        sortSel.value = 'name';
        sortSel.dispatchEvent(new Event('change'));
        await new Promise((s) => setTimeout(s, 300));
        const after = listBox ? Array.from(listBox.querySelectorAll('.card-title')).map((e) => e.textContent) : [];
        r.func.layout.sortedNames = after;
        r.func.layout.sortApplied = JSON.stringify(after) === JSON.stringify(after.slice().sort((a, b) => a.localeCompare(b, 'zh')));
        // 恢复默认排序
        sortSel.value = 'added';
        sortSel.dispatchEvent(new Event('change'));
        await new Promise((s) => setTimeout(s, 250));
      }
    } catch (e) {
      r.func.layout = Object.assign({ err: String(e.message).slice(0, 160) }, r.func.layout || {});
    }

    // ---- m09109 需求②：阅读设置（字体样式 / 字号） ----
    try {
      const btn = document.querySelector('#btnReaderSettings');
      r.func.rs = Object.assign({ btnFound: !!btn }, r.func.rs || {});
      if (btn) {
      const htmlEl = document.documentElement;
      const cs = () => getComputedStyle(htmlEl);
      r.func.rs.sizeBefore = cs().getPropertyValue('--reader-font-size').trim();
      r.func.rs.familyBefore = cs().getPropertyValue('--reader-font-family').trim();
      r.func.rs.widthBefore = cs().getPropertyValue('--reader-page-width').trim();
      btn.click();
      await new Promise((s) => setTimeout(s, 350));
      const fontSel = document.querySelector('#rsFont');
      const sizeRange = document.querySelector('#rsSize');
      const lineRange = document.querySelector('#rsLine');
      const widthRange = document.querySelector('#rsWidth');
      r.func.rs.dialog = { font: !!fontSel, size: !!sizeRange, line: !!lineRange, width: !!widthRange };
      if (fontSel) r.func.rs.fontOptionCount = fontSel.options.length;
      if (fontSel && sizeRange) {
      // 改字号
      sizeRange.value = '24';
      sizeRange.dispatchEvent(new Event('input'));
      await new Promise((s) => setTimeout(s, 250));
      r.func.rs.sizeAfter = cs().getPropertyValue('--reader-font-size').trim();
      r.func.rs.sizeLabel = (document.querySelector('#rsSizeVal') || {}).textContent;
      r.func.rs.persistedSize = (() => {
        try { return JSON.parse(localStorage.getItem('shuyuan.readerPref') || '{}').fontSize; } catch { return -1; }
      })();
      // 改字体
      const pick = Array.from(fontSel.options).find((o) => o.value && /KaiTi|楷体/i.test(o.textContent + o.value));
      if (pick) {
        fontSel.value = pick.value;
        fontSel.dispatchEvent(new Event('change'));
        await new Promise((s) => setTimeout(s, 250));
        r.func.rs.familyAfter = cs().getPropertyValue('--reader-font-family').trim();
        r.func.rs.familyVarChanged = r.func.rs.familyAfter !== r.func.rs.familyBefore;
      }
      // 改行距与页宽
      if (lineRange) {
        lineRange.value = '1.6';
        lineRange.dispatchEvent(new Event('input'));
        await new Promise((s) => setTimeout(s, 200));
        r.func.rs.lineAfter = cs().getPropertyValue('--reader-line-height').trim();
      }
      if (widthRange) {
        widthRange.value = '900';
        widthRange.dispatchEvent(new Event('input'));
        await new Promise((s) => setTimeout(s, 200));
        r.func.rs.widthAfter = cs().getPropertyValue('--reader-page-width').trim();
      }
      // 恢复默认按钮
      const foot = document.querySelector('#modalFoot');
      const resetBtn = foot ? Array.from(foot.querySelectorAll('button')).find((b) => /恢复默认/.test(b.textContent)) : null;
      r.func.rs.resetBtnFound = !!resetBtn;
      if (resetBtn) {
        resetBtn.click();
        await new Promise((s) => setTimeout(s, 400));
        r.func.rs.sizeAfterReset = cs().getPropertyValue('--reader-font-size').trim();
      }
      // 关掉对话框，别挡住后面的截图
      const closeBtn = document.querySelector('#modalClose');
      if (closeBtn) { closeBtn.click(); await new Promise((s) => setTimeout(s, 250)); }
      r.func.rs.modalClosed = !document.querySelector('#modalMask.show');
      } // end if (fontSel && sizeRange)
      } // end if (btn)
    } catch (e) {
      r.func.rs = Object.assign({ err: String(e.message).slice(0, 160) }, r.func.rs || {});
    }

    // ---- m11586 网页转书源（按钮/对话框/前端拦截/后端兜底，全程不依赖外网） ----
    try {
      const otab = document.querySelector('.tab[data-view="online"]');
      if (otab) { otab.click(); await new Promise((s) => setTimeout(s, 300)); }
      const agBtn = document.querySelector('#btnOnlineAutogen');
      r.func.ag = { btn: !!(agBtn && typeof agBtn.onclick === 'function') };
      if (agBtn) {
        agBtn.click();
        await new Promise((s) => setTimeout(s, 300));
        r.func.ag.title = (document.querySelector('#modalTitle') || {}).textContent || '';
        r.func.ag.urlInput = !!document.querySelector('#agUrl');
        r.func.ag.goBtn = !!document.querySelector('#agGo');
        r.func.ag.stepsBox = !!document.querySelector('#agSteps');
        const agFoot = document.querySelector('#modalFoot');
        const agAddBtn = agFoot ? agFoot.querySelector('#agAdd') : null;
        r.func.ag.addDisabled = !!(agAddBtn && agAddBtn.disabled);
        // 非法输入：前端拦截，不发请求、不渲染步骤
        const inp = document.querySelector('#agUrl');
        if (inp) inp.value = 'abc';
        const go = document.querySelector('#agGo');
        if (go) go.click();
        await new Promise((s) => setTimeout(s, 300));
        r.func.ag.toast = (document.querySelector('#toastWrap') || {}).textContent || '';
        r.func.ag.emptySteps = document.querySelectorAll('#agSteps .ag-step').length;
        // 后端兜底：空网址直接报错（无网络）
        const agBad = await window.api.autogenSource('', {});
        r.func.ag.badOk = !!(agBad && agBad.ok === false);
        r.func.ag.badErr = String((agBad && agBad.error) || '');
        const closeBtn2 = document.querySelector('#modalClose');
        if (closeBtn2) { closeBtn2.click(); await new Promise((s) => setTimeout(s, 200)); }
        r.func.ag.closed = !document.querySelector('#modalMask.show');
      }
    } catch (e) {
      r.func.ag = Object.assign({ err: String(e.message).slice(0, 160) }, r.func.ag || {});
    }

    // ---- m13717 阅读器：刷新 / 重新下载按钮 + 站点错误页(stub)警示条 ----
    // 注意：window.api 是 contextBridge 暴露的，属性只读、不可 monkey-patch；
    // 但渲染端 app.js 是普通 script，顶层 function 声明都在 window 上，可直接调用/临时替换。
    try {
      const rd = {};
      const rf = document.querySelector('#btnRefreshCh');
      const rl = document.querySelector('#btnRedlCh');
      rd.btns = !!(rf && rl && typeof rf.onclick === 'function' && typeof rl.onclick === 'function');
      rd.fnFound = typeof window.looksLikeStubPage === 'function';
      if (rd.fnFound) {
        rd.stubHit = window.looksLikeStubPage('　　获取章节内容失败') === true;
        rd.cleanMiss = window.looksLikeStubPage('这是一段完全正常的正文，讲的是主角如何一步步修炼。') === false;
        const bs = await window.api.shelf();
        const bk = (bs || []).find((b) => (b.downloaded || 0) > 0) || (bs || [])[0];
        rd.bookPicked = !!bk;
        if (bk) {
          const origStub = window.looksLikeStubPage;
          window.looksLikeStubPage = () => true;
          await window.openReader(bk.id);
          await new Promise((s) => setTimeout(s, 800));
          rd.readerActive = !!document.querySelector('#view-reader.active');
          rd.stubWarn = !!document.querySelector('#readerBody .stub-warn');
          rd.inlineBtn = !!document.querySelector('#btnRedlInline');
          window.looksLikeStubPage = origStub;
          const back = document.querySelector('#btnReaderBack');
          if (back) { back.click(); await new Promise((s) => setTimeout(s, 300)); }
          rd.backOk = !!document.querySelector('#view-shelf.active');
        }
      }
      r.func.rd = rd;
    } catch (e) {
      r.func.rd = Object.assign({ err: String(e.message).slice(0, 160) }, r.func.rd || {});
    }

    // ---- m09109 需求③：内置浏览器页 ----
    // 回归点：<webview> 不带 src 时永不初始化 guest（点站点无反应）；
    // 且反复切到该页签不得重复建 guest（loadBrowser 只能初始化一次）。
    try {
      const tab = document.querySelector('.tab[data-view="browser"]');
      r.func.bw = Object.assign({ tabFound: !!tab }, r.func.bw || {});
      if (tab) {
        tab.click();
        await new Promise((s) => setTimeout(s, 2500));
        const pane = document.querySelector('#view-browser');
        const siteBar = document.querySelector('#bwSiteBar');
        const btns = siteBar ? Array.from(siteBar.querySelectorAll('button')) : [];
        r.func.bw.siteCount = btns.length;
        r.func.bw.siteNames = btns.map((b) => b.textContent.trim());
        r.func.bw.notice = (document.querySelector('#bwNotice') || {}).textContent || '';
        r.func.bw.addrFound = !!document.querySelector('#bwAddress');
        r.func.bw.paneActive = !!(pane && pane.classList.contains('active'));

        const wvs = Array.from(document.querySelectorAll('#bwStage webview'));
        r.func.bw.webviewCount = wvs.length;
        // 每个 webview 都必须有 src，否则 guest 不会初始化
        r.func.bw.allHaveSrc = wvs.length > 0 && wvs.every((w) => !!w.getAttribute('src'));
        // 能拿到 webContentsId 就说明 guest 已附加 + dom-ready 已触发
        r.func.bw.boundIds = wvs.filter((w) => {
          try { return typeof w.getWebContentsId() === 'number'; } catch (_) { return false; }
        }).length;

        // 点一个预置站点（飞卢：无 WAF，能真加载），等它渲染出正文
        const fl = btns.find((b) => /飞卢/.test(b.textContent)) || btns[1];
        if (fl) {
          fl.click();
          await new Promise((s) => setTimeout(s, 6000));
          const active = Array.from(document.querySelectorAll('#bwStage webview')).find((w) => !w.hidden)
            || document.querySelector('#bwStage webview');
          if (active) {
            try { r.func.bw.liveUrl = active.getURL(); } catch (_) {}
            try { r.func.bw.liveTitle = active.getTitle(); } catch (_) {}
            try {
              const inner = await active.executeJavaScript(
                '({ len: document.body ? document.body.innerText.length : 0 })'
              );
              r.func.bw.liveTextLen = inner && inner.len;
            } catch (e) {
              r.func.bw.liveInnerErr = String(e.message).slice(0, 120);
            }
          }
        }
        r.func.bw.guestsAfterSwitches = document.querySelectorAll('#bwStage webview').length;
      }
    } catch (e) {
      r.func.bw = Object.assign({ err: String(e.message).slice(0, 160) }, r.func.bw || {});
    }

    // ---- 在线书源 → 在内置浏览器打开该书的网站 ----
    // 要求：每条在线书源卡片都有一个「打开网站」按钮；点了之后切到浏览器页，
    // 并且给出目标地址的标签真的建起来（不是只切视图什么都不做）。
    try {
      const so = (r.func.so = {});
      // 回到在线页。列表数据来自真站（yck），响应 2.5~10s 不等，固定 sleep 压不住，
      // 必须轮询等它渲染完——否则 cardCount=0 会让这一组 8 项全挂（历史踩过）。
      document.querySelector('.tab[data-view="online"]').click();

      const cardsOf = () => Array.from(document.querySelectorAll('#onlineList .card'));
      // 预算 20s：整段冒烟要压在 MAX_MS(120s) 内，这里的上限不能太宽松，
      // 否则真站慢的时候会把整个进程拖到超时（连跑三次全超时的教训）。
      const deadline = Date.now() + 20000;
      let settled = 0;
      let lastSig = '';
      while (Date.now() < deadline) {
        const cs = cardsOf();
        // 连续两次「卡片数 > 0 且签名一致」才算稳定，避免渲染到一半就动手
        const sig = cs.length + '|' + cs.map((c) => (c.querySelector('.card-title') || {}).textContent || '').join(',');
        if (cs.length > 0 && sig === lastSig) {
          settled++;
          if (settled >= 2) break;
        } else {
          settled = 0;
        }
        lastSig = sig;
        await new Promise((s) => setTimeout(s, 500));
      }
      so.listSettled = settled >= 2;

      const cards = cardsOf();
      so.cardCount = cards.length;
      so.listSettledCount = settled;

      const openBtns = cards
        .map((c) => c.querySelector('[data-act=open]'))
        .filter(Boolean);
      so.openBtnCount = openBtns.length;
      so.allCardsHaveOpenBtn = cards.length > 0 && openBtns.length === cards.length;
      so.openBtnLabel = openBtns.length ? openBtns[0].textContent.trim() : '';

      // 取一条真实书源的卡片（最终小说网/笔趣阁之类），抓它的 url 文案
      so.firstCardUrl = cards.length
        ? ((cards[0].querySelector('.card-sub') || {}).textContent || '').trim().slice(0, 80)
        : '';

      if (openBtns.length) {
        const tabsBefore = document.querySelectorAll('#bwStage webview').length;
        openBtns[0].click();
        // 等切换视图 + 初始化（loadBrowser 首次要 await 拉站点表）+ 建标签
        const readyDeadline = Date.now() + 12000;
        let addr = '';
        while (Date.now() < readyDeadline) {
          const wvs = document.querySelectorAll('#bwStage webview').length;
          addr = (document.querySelector('#bwAddress') || {}).value || '';
          if (wvs > tabsBefore && addr && !/^about:/.test(addr)) break;
          await new Promise((s) => setTimeout(s, 300));
        }
        await new Promise((s) => setTimeout(s, 600));

        const pane = document.querySelector('#view-browser');
        so.paneActiveAfterOpen = !!(pane && pane.classList.contains('active'));
        so.tabsAfterOpen = document.querySelectorAll('#bwStage webview').length;
        so.tabAdded = so.tabsAfterOpen > tabsBefore;

        // 当前地址栏应当落到书源网站上
        so.addressAfterOpen = addr;
        so.addressNonEmpty = !!addr && !/^about:/.test(addr);
        // 地址栏 host 应当与该书源卡片的 url 是同一个域
        try {
          so.addressHost = new URL(addr).hostname.replace(/^www\./, '');
        } catch (_) {
          so.addressHost = '';
        }

        // 目标标签必须是「当前标签」（否则用户看不到加载的页面）
        const activeView = Array.from(document.querySelectorAll('#bwStage webview'))
          .find((w) => !w.hidden);
        so.activeHasSrc = !!(activeView && activeView.getAttribute('src'));

        // 重复点同一书源不应无限堆标签（同 host 复用）
        const n1 = document.querySelectorAll('#bwStage webview').length;
        openBtns[0].click();
        await new Promise((s) => setTimeout(s, 1200));
        so.tabsAfterSecondOpen = document.querySelectorAll('#bwStage webview').length;
        so.noTabLeak = so.tabsAfterSecondOpen <= n1;
      }
    } catch (e) {
      r.func.so = Object.assign({ err: String(e.message).slice(0, 160) }, r.func.so || {});
    }
    seg('afterSo');

    r.errors = errors;
    seg('end');
    r.title = document.title;
    r.brand = (document.querySelector('.brand') || {}).textContent || '';

    // ---- m07786 需求①：日夜模式 ----
    // 主题存在 html/body 的data-theme 上；切换后必须真的改接CSS 变量值。
    const htmlEl = document.documentElement;
    r.func.theme = {
      initial: htmlEl.getAttribute('data-theme'),
      btnThemes: ['#btnTheme', '#btnThemeToggle', '#themeToggle'].filter((s) => document.querySelector(s)),
    };
    // 取一个「随主题变化」的 CSS 变量作为证据（--bg / --fg / --card-bg 任一）
    const themeVars = ['--bg', '--fg', '--card-bg', '--text'];
    const readVars = () => {
      const cs = getComputedStyle(htmlEl);
      return Object.fromEntries(themeVars.map((v) => [v, cs.getPropertyValue(v).trim()]));
    };
    const themeBtn = ['#btnTheme', '#btnThemeToggle', '#themeToggle']
      .map((s) => document.querySelector(s)).find(Boolean);
    r.func.themeBtnFound = !!themeBtn;
    if (themeBtn) {
      const before = readVars();
      const beforeAttr = htmlEl.getAttribute('data-theme');
      themeBtn.click();
      await new Promise((s) => setTimeout(s, 250));
      const after = readVars();
      const afterAttr = htmlEl.getAttribute('data-theme');
      r.func.themeBefore = before;
      r.func.themeAfter = after;
      r.func.themeAttrBefore = beforeAttr;
      r.func.themeAttrAfter = afterAttr;
      r.func.themeAttrChanged = beforeAttr !== afterAttr;
      r.func.themeVarChanged = themeVars.some((v) => before[v] !== after[v]);
      // 切回来，避免影响后续用例的截图
      themeBtn.click();
      await new Promise((s) => setTimeout(s, 200));
      r.func.themeRestored = htmlEl.getAttribute('data-theme') === beforeAttr;
    }

    // ---- m07786 需求②：书架换源 ----
    // 不能用上面那本导出用的书：它是「最终小说网」独有的冷门同人
    // （《[诡秘之主同人]克总，恰饭不》），别的源根本没有同名书，候选必然是 0 条，
    // 断言会假失败。这里另挑一本**多源都收录**的书（精确同名的《诡秘之主》）。
    r.func.sw = { apiKeys: Object.keys(window.api || {}).filter((k) => /changeSource|sourceCandidates/i.test(k)) };
    // 冒烟库一开始是空的，只靠 sync 临时加了几条，能用来「换过去」的源太少，
    // 候选可能为 0 导致断言假失败。这里显式再装两个真实书源
    // （从在线列表抓「笔趣阁」「五八书阁」的 JSON），保证多源都收录《诡秘之主》。
    try {
      const online = await window.api.onlineList({ page: 1, kind: 'shuyuan' });
      const want = ['📖笔趣阁', '五八书阁', '笔趣阁'];
      const picked = [];
      for (const w of want) {
        const it = (online.items || []).find((x) => String(x.name || '').trim() === w
          || String(x.name || '').includes(w));
        if (it && !picked.some((p) => p.url === it.url)) picked.push(it);
      }
      const added2 = [];
      for (const it of picked.slice(0, 3)) {
        try {
          const r2 = await window.api.onlineInstall(it.id);
          added2.push({ name: it.name, added: !!(r2 && (r2.added || r2.ok)) });
        } catch (e) { added2.push({ name: it.name, err: String(e.message).slice(0, 60) }); }
      }
      r.func.swExtraSources = added2;
      r.func.swSourceCount = (await window.api.sourceList()).length;
    } catch (e) { r.func.swExtraErr = String(e.message).slice(0, 120); }
    let swBookId = r.func.shelfBookId;
    try {
      const allGroups = await window.api.searchAll('诡秘之主', null, 1);
      const hostG = (allGroups || []).find((g) => g.ok && (g.list || []).some((b) => b.name === '诡秘之主'));
      if (hostG) {
        const exact = hostG.list.find((b) => b.name === '诡秘之主');
        const hostAdd = await window.api.addToShelf(hostG.sourceKey, exact, { download: false });
        if (hostAdd && hostAdd.id && hostAdd.chapterCount > 0) {
          swBookId = hostAdd.id;
          r.func.swHostSource = hostG.sourceKey;
          r.func.swHostName = exact.name;
          r.func.swHostChapters = hostAdd.chapterCount;
          await window.api.saveProgress(hostAdd.id, { index: 5, offset: 0, at: Date.now() });
        }
      }
    } catch (e) { r.func.swHostErr = e.message; }
    const shelfBooks = await window.api.shelf();
    const swBook = (shelfBooks || []).find((b) => b.id === swBookId) || (shelfBooks || [])[0];
    if (swBook) {
      r.func.swBookId = swBook.id;
      r.func.swBookProgress = swBook.progress;
      r.func.swBookSource = swBook.sourceKey;
      const cands = await window.api.sourceCandidates(swBook.id, {});
      r.func.swCand = {
        ok: !!(cands && cands.candidates),
        count: cands && cands.candidates ? cands.candidates.length : -1,
        ran: cands && cands.ran,
        excludedCurrent: cands && cands.candidates
          ? !cands.candidates.some((c) => c.sourceKey === swBook.sourceKey) : false,
        first: cands && cands.candidates && cands.candidates[0]
          ? { sourceName: cands.candidates[0].sourceName, name: cands.candidates[0].name, bookUrl: cands.candidates[0].bookUrl }
          : null,
      };
      // 换源坏路径：换到一个不存在的源，必须明确报错且书架不变
      const beforeCount = (await window.api.shelf()).length;
      try {
        await window.api.changeSource(swBook.id, 'https://no-such-source.invalid', {});
        r.func.swBadErr = '';
      } catch (e) {
        r.func.swBadErr = e.message;
      }
      r.func.swBadCountSame = (await window.api.shelf()).length === beforeCount;
      // 换源好路径：挑第一个候选真换一次
      const c0 = cands && cands.candidates && cands.candidates[0];
      if (c0) {
        // 进度不在 book() 的返回里（book() = library.get 的书架记录），
        // 要单独走 window.api.progress(id)。
        const rec0p = await window.api.progress(swBook.id);
        r.func.swProgressBefore = rec0p;
        let changed = null;
        try {
          changed = await window.api.changeSource(swBook.id, c0.sourceKey, { keepChapters: true, keepOld: false });
        } catch (e) {
          r.func.swErr = e.message;
        }
        r.func.sw = { ...r.func.sw, result: changed ? {
          // App.changeSource 返回的字段名是 bookId（不是 id）
          id: changed.bookId, oldBookId: changed.oldBookId, oldRemoved: changed.oldRemoved,
          sourceName: changed.sourceName, chapterCount: changed.chapterCount,
          progress: changed.progress, progressKept: changed.progressKept,
          migrated: changed.migratedChapters, score: changed.matchScore,
        } : null };
        if (changed && changed.bookId) {
          const rec1 = await window.api.book(changed.bookId);
          r.func.swProgressAfter = await window.api.progress(changed.bookId);
          r.func.swChapterCountAfter = rec1 && rec1.chapterCount;
          r.func.swSourceAfter = rec1 && rec1.sourceKey;
          r.func.swBooksAfter = (await window.api.shelf()).length;
          r.func.swOldGone = !(await window.api.book(changed.oldBookId));
        }
      }
    }
  } catch (e) {
    r.fatal = e.message;
    r.fatalStack = e.stack;
  }
  return r;
  };
  try {
    const __out = await Promise.race([__body(), __watch(Number(window.__probeBudgetMs) || 300000)]);
    return __out && __out.__timeout
      ? { fatal: "PROBE 看门狗超时（默认 300s）：有一步真网请求没返回", func: {} }
      : __out;
  } catch (e) {
    return { fatal: String((e && e.message) || e), fatalStack: e && e.stack, func: {} };
  }
})()`;


app.whenReady().then(async () => {
  await wait(2500); // 等窗口与 init() 完成
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    report({ ok: false, reason: 'no-window' });
    app.exit(1);
    return;
  }

  // 标红验证的前置：给「最终小说网」线个URL 预置「不允许添加」探测记录
  try {
    r_seed = await seedProbe();
  } catch (e) {
    r_seed = { seeded: false, reason: e.message };
  }

  // 换源用例前置：预置几个真实书源，避免依赖在线站点的即时可用性
  let r_seedSw = null;
  try {
    r_seedSw = seedSwitchSources();
  } catch (e) {
    r_seedSw = { seeded: 0, err: e.message };
  }

  // 捕获渲染进程控制台错误
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    consoleErrors.push(`[L${level}] ` + message);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    consoleErrors.push('[render-process-gone] ' + JSON.stringify(details));
  });

  let res;
  try {
    // 先在主进程侧用同一个 V8 解析 PROBE；失败则逐行累进定位坏行
    try {
      new Function(PROBE);
    } catch (pe) {
      // 落盘运行时字符串，便于与源文件提取版比对
      try {
        fs.writeFileSync(path.join(os.tmpdir(), 'probe-runtime.js'), PROBE, 'utf8');
      } catch (_) { /* ignore */ }
      const lines = PROBE.split('\n');
      let bad = -1;
      for (let n = 1; n <= lines.length; n++) {
        try {
          new Function(lines.slice(0, n).join('\n') + '\n})()');
        } catch (_) {
          bad = n;
          break;
        }
      }
      report({
        ok: false,
        reason: 'PROBE parse failed in main: ' + pe.message
          + (bad > 0 ? ' | first failing line: ' + bad + ' -> ' + lines[bad - 1] : ' | line-bisect clean'),
        seed: r_seed,
      });
      app.exit(1);
      return;
    }
    // PROBE 的看门狗预算：给渲染侧一个总时限，任何一步真网请求挂死都能把已跑到的段落带回来。
    // 默认 240s，小于 harness 的 MAX_MS(420s)，保证「看门狗先响 → 有结果文件 → 能看到哪一步卡了」。
    const probeBudgetMs = Number(process.env.SHUYUAN_PROBE_BUDGET_MS) || 240000;
    res = await win.webContents.executeJavaScript(
      'window.__probeBudgetMs = ' + probeBudgetMs + ';' + PROBE,
      true
    );
    // webview guest 数只有主进程看得到；PROBE 只能数 DOM 里的 <webview>。
    // 这里补上真实 guest 数，用来验证「反复切页签不泄漏 guest」。
    try {
      const g = webContents.getAllWebContents().filter((w) => w.getType() === 'webview').length;
      if (res && res.func && res.func.bw) {
        res.func.bw.guestsAfterSwitches = g;
        res.func.bw.guestsBeforeSwitches = g; // 探针只切了一次，前后应相等
      }
    } catch (_) { /* ignore */ }
  } catch (e) {
    report({ ok: false, reason: 'execute-failed: ' + e.message, consoleErrors, seed: r_seed });
    app.exit(1);
    return;
  }

  const checks = [];
  const need = [
    'info', 'onlineList', 'onlineGet', 'onlineInstall',
    'onlineSyncUpdates', 'sourceCheck', 'probeStatus',
    'sourceList', 'sourceAdd', 'sourceTest', 'sourceRemove', 'sourceExport', 'sourceImportText',
    'rssOnlineList', 'rssList', 'rssInstall', 'rssImportText', 'rssRemove',
    'searchOne', 'searchAll',
    'shelf', 'book', 'removeBook', 'toc', 'addToShelf', 'download', 'chapter', 'progress', 'saveProgress',
    'exportBook', 'exportShelf', 'exportDefaults',
    'pickFiles', 'saveFile', 'pickDir', 'showInFolder', 'openExternal',
  ];
  for (const k of need) checks.push([`api.${k}`, res.apiKeys.includes(k)]);
  checks.push(['info 返回 dataDir', !!(res.info && res.info.dataDir)]);
  checks.push(['sourceList 是数组', Array.isArray(res.sources)]);
  checks.push(['onlineList 命中 1 条', !!(res.online && res.online.count >= 1)]);
  checks.push(['onlineList 首条名称正确', !!(res.online && /最终小说网/.test(res.online.first || ''))]);
  for (const v of res.views || []) checks.push([`视图 ${v.view} 可切换`, v.active]);
  for (const [sel, ok] of Object.entries(res.caps || {})) checks.push([`DOM ${sel}`, ok]);
  checks.push(['页面标题', res.title === '书源阅读器']);
  // 只把渲染进程的 error 级别（L3）与 render-process-gone 视为 JS 错误；L0/L1/L2 是 log/warn
  const hardErrors = consoleErrors.filter((m) => /^\[L3\]/.test(m) || m.startsWith('[render-process-gone]'));
  checks.push(['渲染无 JS 错误', !(res.errors && res.errors.length) && !hardErrors.length]);

  // ---- 功能闸门：可读性探测（交付点 ③）----
  const f = res.func || {};
  checks.push(['探测闸门：结构非法被拒', f.badShapeRejected === true]);
  checks.push(['探测闸门：结构非法给出理由', /书源结构校验失败/.test(f.badShapeReason || '')]);
  checks.push(['探测闸门：域名不存在被拒', f.badHostRejected === true]);
  checks.push(['探测闸门：被拒时带回探测详情', f.badHostHasProbe === true]);
  checks.push(['探测闸门：拒绝后书源库不变', f.storeUnchanged === true]);
  checks.push(['探测闸门：手写书源被接受', f.goodAdded === true]);
  checks.push(['探测闸门：接受后计数 +1', f.afterGoodCount === (f.beforeCount || 0) + 1]);
  checks.push(['探测闸门：手写书源评为满分', f.goodScore === 100]);
  for (const st of ['reach', 'search', 'bookInfo', 'toc', 'content']) {
    checks.push([`探测阶段 ${st} 通过`, !!(f.goodStages && f.goodStages[st])]);
  }

  // ---- 功能链路：搜索→加书构→下载 →导出（交付点 ②④）---
  checks.push(['搜索有结果', (f.searchCount || 0) > 0]);
  checks.push(['加书架返回id', f.shelfAddOk === true]);
  checks.push(['加书架带回目录数', (f.shelfChapterCount || 0) > 0]);
  checks.push(['下载 2 章成功', f.dlDone === 2]);
  checks.push(['下载无失败', f.dlFailed === 0]);
  checks.push(['导出产出文件', f.exportOk === true]);
  checks.push(['导出字节数> 0', (f.exportBytes || 0) > 0]);
  checks.push(['导出章节数> 0', (f.exportChapters || 0) > 0]);
  checks.push(['导出路径落在数据目录', /export/.test(f.exportPath || '')]);
  checks.push(['成书后有已下载章节', (f.bookDownloaded || 0) > 0]);

  // ---- 懒加载窗口（m07558）---
  // ---- 下载页签（后台队列）----
  checks.push(['下载：导航里有「下载」页签', !!(f.dlq && f.dlq.tab)]);
  checks.push(['下载：面板/列表/刷新/清空/过滤都在', !!(f.dlq && f.dlq.panel && f.dlq.list && f.dlq.refreshBtn && f.dlq.clearBtn && f.dlq.filter)]);
  checks.push(['下载：enqueueDownload 立刻返回（<120ms，不阻塞界面）', !!(f.dlq && f.dlq.enqueueMs < 120)]);
  checks.push(['下载：入队不抛错', !!(f.dlq && !f.dlq.enqueueErr)]);
  checks.push(['下载：入队返回任务快照（id/bookId 对上）', !!(f.dlq && f.dlq.jobId && f.dlq.jobBookId === f.shelfBookId)]);
  checks.push(['下载：listDownloads 里能查到该任务', !!(f.dlq && f.dlq.hasJob)]);
  checks.push(['下载：summary 结构完整', !!(f.dlq && f.dlq.summary && typeof f.dlq.summary.active === "number")]);
  checks.push(['下载：页签里渲染出任务行', !!(f.dlq && f.dlq.rowRendered)]);
  checks.push(['下载：任务行含进度元素', !!(f.dlq && f.dlq.progressEl)]);

  checks.push(['窗口：加书架初始段从第1 章起', f.winInitialFrom === 0]);
  checks.push(['窗口：加书架只下前10 章（末章 = 第10 章）', f.winInitialTo === 9]);
  // 之前已单独下过第 1-2 章，所以done 只统计新下的；关键是「窗口覆盖10 章」且「已下载的不重下。
  checks.push(['窗口：初始段覆盖 10 章（新下 + 跳过）', f.winCovered === 10]);
  checks.push(['窗口：已下载的章不重复下载（跳过 2 章）', f.winInitialSkipped === 2]);
  checks.push(['窗口：新下载 = 覆盖数- 跳过数', f.winInitialDone === f.winCovered - f.winInitialSkipped]);
  checks.push(['窗口：读到第 4 章时从第 5 章开始补', f.winReadFrom === 4]);
  checks.push(['窗口：向后补满10 章（第5-14 章）', f.winReadTo === 13]);
  checks.push(['窗口：重复调用同一位置被识别为已缓存', f.winRepeatEmpty === true]);
  checks.push(['窗口：任务结束后 busy=false', f.winBusyAfter === false]);

  // ---- m04402 三功能----
  checks.push(['DOM #btnOnlineUpdate 可点', f['#btnOnlineUpdate'] === true]);
  checks.push(['DOM #btnOnlineCheck 可点', f['#btnOnlineCheck'] === true]);
  checks.push(['DOM #btnOnlineRss 可点', f['#btnOnlineRss'] === true]);
  // 断言只认「这个 URL 被校验且通过」——同 URL 上可能同时存在 seed 进来的真实书源
  // （seedSwitchSources 预置的「最终小说网」就是这个 URL），按书名匹配会误判。
  checks.push(['校验书源：zuizhong.net 校验通过', !!(f.check && f.check.total >= 1 && f.check.passed >= 1 && f.check.first && f.check.first.ok)]);
  checks.push(['更新：真网返回items 数组', f.sync && Array.isArray([]) && typeof f.sync.checked === 'number' && f.sync.items >= 0]);
  checks.push(['订阅源：在线列表非空', (f.rssOnline && f.rssOnline.count) > 0]);
  checks.push(['订阅源：安装 193 新增 1', f.rssInstall && f.rssInstall.added === 1]);
  checks.push(['订阅源：文本导入新增 1', f.rssImportAdded === 1]);
  checks.push(['订阅源：本地共2 个', f.rssLocalCount === 2]);
  checks.push(['订阅源：清理后归零', f.rssLocalAfter === 0]);

  // ---- m11586 网页转书源 ----
  checks.push(['网页转书源：工具栏按钮可点', !!(f.ag && f.ag.btn)]);
  checks.push(['网页转书源：对话框完整（标题/输入/嗅探钮/步骤区）', !!(f.ag && /网页转书源/.test(f.ag.title) && f.ag.urlInput && f.ag.goBtn && f.ag.stepsBox)]);
  checks.push(['网页转书源：无结果时「添加」置灰', !!(f.ag && f.ag.addDisabled)]);
  checks.push(['网页转书源：非法输入前端拦截且不发请求', !!(f.ag && /http/.test(f.ag.toast) && f.ag.emptySteps === 0)]);
  checks.push(['网页转书源：空网址后端直接拒绝', !!(f.ag && f.ag.badOk && /不是合法的网址/.test(f.ag.badErr))]);
  checks.push(['网页转书源：对话框可关闭', !!(f.ag && f.ag.closed)]);
  checks.push(['标红：seed 植入成功', !!(r_seed && r_seed.seeded === true)]);
  checks.push(['标红：在线列表命中最终小说网', f.zzzFound === true]);
  checks.push(['标红：列表渲染已稳定（无在飞请求回包）', f.listSettled === true]);
  checks.push(['标红：probeStatus 标记不可添加', f.probeStatusHasRejected === true]);
  checks.push(['标红：在线列表 rejected 卡片=1', f.rejectedCards === 1]);
  checks.push(['标红：rejected 卡片标题正确', !!(f.rejectedFirst && /最终小说网/.test(f.rejectedFirst.title || ''))]);
  checks.push(['标红：rejected 卡片带⛔徽标', !!(f.rejectedFirst && f.rejectedFirst.hasBadge)]);

  // ---- m06856 三功能：备用线路 / 全书源搜索/ 提选----
  checks.push(['线路：onlineRoute API 可用', !!f.route]);
  checks.push(['线路：报出当前主站', !!(f.route && /yck/i.test(String(f.route.shuyuan || '')))]);
  checks.push(['线路：主站候选含 yckceo.com 备用站', !!(f.route && f.route.candShuyuan && f.route.candShuyuan.some((u) => /yckceo\.com/i.test(u)))]);
  checks.push(['线路：候选数 >= 2', !!(f.route && f.route.candShuyuan && f.route.candShuyuan.length >= 2)]);
  checks.push(['线路：DOM #onlineRouteBar 存在', f.routeBarExists === true]);
  checks.push(['线路：强制重探ok', !!(f.routeRetry && f.routeRetry.ok && f.routeRetry.checked)]);
  checks.push(['线路：重探命中yck 家族', !!(f.routeRetry && f.routeRetry.isYck)]);
  checks.push(['全书源搜索：模式选择器all/one 齐全', !!(f.ewBtnExists && f.ewModeAll && f.ewModeOne)]);
  checks.push(['全书源搜索：返回 total>0', !!(f.ew && f.ew.total > 0)]);
  checks.push(['全书源搜索：sources 数 = total', !!(f.ew && f.ew.sources === f.ew.total)]);
  checks.push(['全书源搜索：有源成功', !!(f.ew && f.ew.ok > 0)]);
  checks.push(['全书源搜索：聚合出分组', !!(f.ew && f.ew.groups > 0)]);
  checks.push(['全书源搜索：每个分组带offers', !!(f.ew && f.ew.firstGroupOffers >= 1)]);
  checks.push(['全书源搜索：sourceCount 个offers 一致', !!(f.ew && f.ew.firstGroupSourceCount === f.ew.firstGroupOffers)]);
  checks.push(['全书源搜索：首组有书名', !!(f.ew && f.ew.firstGroupTitle)]);
  checks.push(['全书源搜索：流式 start 事件', !!(f.ew && f.ew.startEvents > 0)]);
  checks.push(['全书源搜索：流式 result 事件与total 对齐', !!(f.ew && f.ew.resultEvents === f.ew.total)]);
  checks.push(['全书源搜索：并发提速（耗时 < 各源之和）', !!(f.ew && f.ewSumSrcMs > 0 && f.ew.elapsed < f.ewSumSrcMs)]);
  checks.push(['全书源搜索：elapsed 上报合理', !!(f.ew && f.ew.elapsed > 0 && f.ew.elapsed < 20000)]);
  checks.push(['全书源搜索：跨源聚合生效（存在多来源书）', !!(f.ew && f.ew.maxOffers >= 1)]);
  checks.push(['本地搜索：searchAll 返回分组', (f.saGroups || 0) > 0]);
  checks.push(['本地搜索：searchAll 有成功组', (f.saOk || 0) > 0]);
  checks.push(['本地搜索：searchAll 用短缓存提速（二次更快）', typeof f.saElapsed === 'number' && f.saElapsed > 0]);

  // ---- m07786 需求①：日夜模式 ----
  checks.push(['日夜模式：切换按钮存在', f.themeBtnFound === true]);
  checks.push(['日夜模式：主题落在 html[data-theme]', !!(f.themeAttrBefore && f.themeAttrAfter)]);
  checks.push(['日夜模式：点击后 data-theme 改变', f.themeAttrChanged === true]);
  checks.push(['日夜模式：CSS 变量随主题改变', f.themeVarChanged === true]);
  checks.push(['日夜模式：再点一次切回原主题', f.themeRestored === true]);

  // ---- m07786 需求②：书架换源 ----
  checks.push(['换源：暴露 changeSource/sourceCandidates API', !!(f.sw && f.sw.apiKeys && f.sw.apiKeys.length === 2)]);
  checks.push(['换源：候选接口返回列表', !!(f.swCand && f.swCand.ok)]);
  checks.push(['换源：候选中排除当前源', !!(f.swCand && f.swCand.excludedCurrent === true)]);
  checks.push(['换源：换到不存在的源必须报错', !!f.swBadErr]);
  checks.push(['换源：失败后书架数量不变', f.swBadCountSame === true]);
  checks.push(['换源：真站换源成功并返回新 bookId', !!(f.sw && f.sw.result && f.sw.result.id)]);
  checks.push(['换源：换源后书源已切换', !!(f.swSourceAfter && f.swSourceAfter !== f.swBookSource)]);
  checks.push(['换源：阅读进度保留', !!(f.swProgressAfter && f.swProgressAfter.index === (f.swProgressBefore || {}).index)]);
  checks.push(['换源：旧书已从书架移除', !!(f.sw && f.sw.result && f.sw.result.oldRemoved === true && f.swOldGone === true)]);
  checks.push(['换源：新书拿到目录（章数>0）', !!(f.swChapterCountAfter > 0)]);

  // ---- m09109 需求①：书架查看方式（列表 / 图标） ----
  checks.push(['书架查看方式：分段控件存在', !!(f.layout && f.layout.segFound)]);
  checks.push(['书架查看方式：恰好列表+图标两个选项', !!(f.layout && f.layout.btnCount === 2)]);
  checks.push(['书架查看方式：两个选项值为 list/grid', !!(f.layout && f.layout.values.join(',') === 'list,grid')]);
  checks.push(['书架查看方式：默认是列表模式', !!(f.layout && f.layout.activeAtStart === 'list')]);
  checks.push(['书架查看方式：切到图标后容器加 .grid 类', !!(f.layout && f.layout.gridClass === true)]);
  checks.push(['书架查看方式：图标模式的按钮高亮切换', !!(f.layout && f.layout.gridActive === true)]);
  checks.push(['书架查看方式：图标模式每张卡片都有封面位', !!(f.layout && f.layout.cardsInGrid > 0 && f.layout.coversInGrid === f.layout.cardsInGrid)]);
  checks.push(['书架查看方式：图标模式卡片数不为 0（确有书）', !!(f.layout && f.layout.cardsInGrid > 0)]);
  checks.push(['书架查看方式：选择已持久化到 localStorage', !!(f.layout && f.layout.persisted === 'grid')]);
  checks.push(['书架查看方式：切回列表后 .grid 类被移除', !!(f.layout && f.layout.listClassBack === true)]);
  checks.push(['书架查看方式：列表模式没有封面位', !!(f.layout && f.layout.coversInList === 0)]);
  checks.push(['书架排序：下拉框存在且有 4 种排序', !!(f.layout && f.layout.sortFound && f.layout.sortOptions.length === 4)]);
  checks.push(['书架排序：按书名排序真的生效', !!(f.layout && f.layout.sortApplied === true)]);

  // ---- m09109 需求②：阅读设置（字体样式 / 字号） ----
  checks.push(['阅读设置：设置按钮存在', !!(f.rs && f.rs.btnFound === true)]);
  checks.push(['阅读设置：对话框含字体/字号/行距/页宽四项', !!(f.rs && f.rs.dialog && f.rs.dialog.font && f.rs.dialog.size && f.rs.dialog.line && f.rs.dialog.width)]);
  checks.push(['阅读设置：字体样式有多个预设', !!(f.rs && f.rs.fontOptionCount >= 5)]);
  checks.push(['阅读设置：改字号后 CSS 变量真的变了', !!(f.rs && f.rs.sizeBefore !== f.rs.sizeAfter && /^24px$/.test(f.rs.sizeAfter))]);
  checks.push(['阅读设置：字号数值同步显示', !!(f.rs && /24/.test(f.rs.sizeLabel || ''))]);
  checks.push(['阅读设置：字号已持久化', !!(f.rs && f.rs.persistedSize === 24)]);
  checks.push(['阅读设置：改字体后 font-family 变量改变', !!(f.rs && f.rs.familyVarChanged === true)]);
  checks.push(['阅读设置：改行距生效', !!(f.rs && /^1\.6/.test(f.rs.lineAfter || ''))]);
  checks.push(['阅读设置：改页宽生效', !!(f.rs && /^900px$/.test(f.rs.widthAfter || ''))]);
  checks.push(['阅读设置：恢复默认按钮存在且把字号还原', !!(f.rs && f.rs.resetBtnFound && /^17px$/.test(f.rs.sizeAfterReset || ''))]);
  checks.push(['阅读设置：关闭后对话框销毁', !!(f.rs && f.rs.modalClosed === true)]);

  // ---- m13717 阅读器：刷新 / 重新下载 + stub 警示条 ----
  checks.push(['阅读器：刷新/重新下载按钮存在且已绑定', !!(f.rd && f.rd.btns === true)]);
  checks.push(['阅读器：stub 判据函数在渲染端可用且行为正确', !!(f.rd && f.rd.fnFound && f.rd.stubHit && f.rd.cleanMiss)]);
  checks.push(['阅读器：能打开一本已下载的书并进入阅读页', !!(f.rd && f.rd.bookPicked && f.rd.readerActive)]);
  checks.push(['阅读器：站点错误页正文渲染警示条与一键重下', !!(f.rd && f.rd.stubWarn && f.rd.inlineBtn)]);
  checks.push(['阅读器：返回按钮能回到书架', !!(f.rd && f.rd.backOk === true)]);

  // ---- m09109 需求③：内置浏览器页 ----
  // 回归点：<webview> 必须带 src 才会初始化 guest，否则 dom-ready 不触发、
  // getWebContentsId() 抛异常、主进程永远 bind 不上（表现为「点站点无反应」）。
  // 另：反复切到浏览器页签不得重复建 guest（loadBrowser 只能初始化一次）。
  checks.push(['浏览器：页签存在', !!(f.bw && f.bw.tabFound === true)]);
  checks.push(['浏览器：预置站点 >= 5 个', !!(f.bw && f.bw.siteCount >= 5)]);
  checks.push(['浏览器：含起点中文网', !!(f.bw && f.bw.siteNames && f.bw.siteNames.some((n) => /起点/.test(n)))]);
  checks.push(['浏览器：含飞卢小说网', !!(f.bw && f.bw.siteNames && f.bw.siteNames.some((n) => /飞卢/.test(n)))]);
  checks.push(['浏览器：含刺猬猫', !!(f.bw && f.bw.siteNames && f.bw.siteNames.some((n) => /刺猬猫/.test(n)))]);
  checks.push(['浏览器：含菠萝包', !!(f.bw && f.bw.siteNames && f.bw.siteNames.some((n) => /菠萝包|SF|sfacg/i.test(n)))]);
  checks.push(['浏览器：含晋江文学城', !!(f.bw && f.bw.siteNames && f.bw.siteNames.some((n) => /晋江/.test(n)))]);
  checks.push(['浏览器：合规提示声明不抓付费正文', !!(f.bw && /不抓取付费正文/.test(f.bw.notice || ''))]);
  checks.push(['浏览器：地址栏存在', !!(f.bw && f.bw.addrFound === true)]);
  checks.push(['浏览器：webview 元素已创建', !!(f.bw && f.bw.webviewCount >= 1)]);
  checks.push(['浏览器：webview 带 src（否则 guest 不初始化）', !!(f.bw && f.bw.allHaveSrc === true)]);
  checks.push(['浏览器：webview 已拿到 guest id（绑定成功）', !!(f.bw && f.bw.boundIds >= 1)]);
  checks.push(['浏览器：反复切页签不重复建 guest', !!(f.bw && f.bw.guestsAfterSwitches === f.bw.guestsBeforeSwitches)]);
  checks.push(['浏览器：真实加载出网页标题', !!(f.bw && f.bw.liveTitle)]);
  checks.push(['浏览器：真实加载出网页正文', !!(f.bw && f.bw.liveTextLen > 500)]);

  // 在线书源 → 内置浏览器打开该书的网站
  checks.push(['书源网站：在线列表已渲染完成（等待真站响应）', !!(f.so && f.so.listSettled === true)]);
  checks.push(['书源网站：在线列表每条卡片都有「打开网站」按钮', !!(f.so && f.so.allCardsHaveOpenBtn === true)]);
  checks.push(['书源网站：按钮文案为「打开网站」', !!(f.so && /打开网站/.test(f.so.openBtnLabel || ''))]);
  checks.push(['书源网站：点击后切到浏览器页', !!(f.so && f.so.paneActiveAfterOpen === true)]);
  checks.push(['书源网站：点击后新建了标签', !!(f.so && f.so.tabAdded === true)]);
  checks.push(['书源网站：地址栏落到该书源网站', !!(f.so && f.so.addressNonEmpty === true)]);
  checks.push(['书源网站：地址栏 host 与书源域名一致', !!(f.so && f.so.addressHost && f.so.firstCardUrl.includes(f.so.addressHost))]);
  checks.push(['书源网站：当前标签已挂 src（guest 会初始化）', !!(f.so && f.so.activeHasSrc === true)]);
  checks.push(['书源网站：重复点同一书源不重复堆标签', !!(f.so && f.so.noTabLeak === true)]);

  let fail = 0;
  const lines = ['=== GUI 冒烟检查 ==='];
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    lines.push(`  ${ok ? '✓' : '✗'} ${name}`);
  }
  if (res.errors && res.errors.length) lines.push('  渲染错误: ' + JSON.stringify(res.errors));
  if (consoleErrors.length) lines.push('  控制台错误: ' + JSON.stringify(consoleErrors.slice(0, 5)));
  if (res.fatal) lines.push('  fatal: ' + res.fatal + '\n' + (res.fatalStack || ''));
  lines.push('\n  关键数据: ' + JSON.stringify(f));
  lines.push(`\n共 ${checks.length} 项，失败 ${fail} 项`);
  console.log(lines.join('\n'));

  report({ ok: fail === 0, checks, details: res, consoleErrors, lines });
  app.exit(fail === 0 ? 0 : 1);
});

