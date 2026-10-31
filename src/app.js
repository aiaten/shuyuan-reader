'use strict';
/**
 * 应用门面：把书源库、书架、下载器、在线书源库、TXT 导出串成一个可被 CLI 与 GUI 共同调用的 API。
 *
 * 这样 CLI（src/cli.js）和 Electron 主进程（electron/main.js）都只依赖本文件，
 * 业务逻辑不会散落到界面层。
 */

const path = require('path');
const fs = require('fs');

const { SourceEngine } = require('./engine/source');
const { SourceStore, RssStore, validateShape, keyOf } = require('./source/store');
const { probe, canAdd } = require('./source/probe');
const { mergeBookGroups, normTitle, normAuthor } = require('./search/merge');
const yck = require('./source/yck');
const { Library, bookIdOf } = require('./store/library');
const { Downloader } = require('./store/downloader');
const { DownloadQueue } = require('./store/download-queue');
const { checkShelfUpdates, checkBook: checkBookUpdate } = require('./store/updater');
const { exportTxt, exportLibrary, normalizeOptions, DEFAULTS } = require('./export/txt');
const backup = require('./backup');

/** 数据根目录：环境变量 SHUYUAN_DATA > <项目根>/data */
function resolveDataDir(explicit) {
  const picked = explicit || process.env.SHUYUAN_DATA;
  // 空串 / 纯空白当作「没指定」：Electron 的 process.env.XXX 在变量不存在时是 undefined，
  // 但启动器拼参数时可能给出空值，path.resolve('') 会变成 cwd，把数据写到莫名其妙的地方。
  if (typeof picked === 'string' && picked.trim()) return path.resolve(picked.trim());
  return path.join(__dirname, '..', 'data');
}

class App {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dataDir]
   * @param {number} [opts.concurrency=4]
   * @param {(msg:string)=>void} [opts.logger]
   */
  constructor(opts = {}) {
    this.dataDir = resolveDataDir(opts.dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.logger = opts.logger || null;
    this.library = new Library(this.dataDir);
    this.sources = new SourceStore(this.dataDir);
    this.rss = new RssStore(this.dataDir);
    this.downloader = new Downloader({
      library: this.library,
      sourceStore: this.sources,
      dataDir: this.dataDir,
      concurrency: opts.concurrency || 4,
      logger: opts.logger,
    });
    /**
     * 下载队列：界面点「下载」只入队，真正的抓取在队列里串行跑。
     * 这样渲染进程永远不用 await 一个几百章的大任务，书架不再被遮罩锁死。
     * opts.onDownloadEvent 由主进程接上，用来把任务快照推给界面。
     */
    this.downloads = new DownloadQueue({
      library: this.library,
      downloader: this.downloader,
      dataDir: this.dataDir,
      onChange: opts.onDownloadEvent || null,
    });
  }

  _log(msg) {
    if (this.logger) this.logger(msg);
  }

  /* ==================== 书源 ==================== */

  listSources() {
    return this.sources.all().map((s) => {
      const pr = this.sources.probeResults()[keyOf(s)] || null;
      return {
        key: keyOf(s),
        name: s.bookSourceName || '',
        url: s.bookSourceUrl || '',
        group: s.bookSourceGroup || '',
        enabled: s.enabled !== false,
        hasSearch: !!s.searchUrl,
        hasExplore: Array.isArray(s.ruleExplore) && s.ruleExplore.length > 0,
        concurrentRate: s.concurrentRate || '',
        probed: !!pr,
        probeOk: pr ? !!(pr.ok && canAdd({ stages: pr.stages }).allowed) : false,
        probeScore: pr ? pr.score : null,
        probeAt: pr ? pr.at : null,
      };
    });
  }

  getSource(key) {
    return this.sources.get(key);
  }

  /**
   * 添加书源（默认先做可读性探测，探测不过不允许添加）。
   * @returns {Promise<{added:boolean, reason:string, probe?:object, errors?:string[]}>}
   */
  async addSource(source, opts = {}) {
    return this.sources.add(source, {
      keyword: opts.keyword,
      force: !!opts.force,
      probe: opts.probe !== false,
      checkContent: opts.checkContent !== false,
      logger: this.logger,
    });
  }

  removeSource(key) {
    return this.sources.remove(key);
  }

  /** 仅做结构校验 + 探测，不落盘（GUI「测试」按钮用） */
  async testSource(source, opts = {}) {
    const shapeErrs = validateShape(source);
    if (shapeErrs.length) {
      return { ok: false, allowed: false, reason: '书源结构校验失败', errors: shapeErrs, probe: null };
    }
    const pr = await probe(source, {
      keyword: opts.keyword,
      checkContent: opts.checkContent !== false,
      logger: opts.logger || this.logger,
    });
    const gate = canAdd(pr);
    return { ok: pr.ok, allowed: gate.allowed, reason: gate.reason, probe: pr, errors: pr.errors };
  }

  /**
   * 网页转书源：给一个小说网址，自动嗅探结构生成 Legado 3.x 书源 JSON。
   * 只生成、不入库——生成结果回给界面预览，用户确认后再走 addSource（含探测闸门）。
   * @returns {Promise<{ok:boolean, source?:object, steps:array, notes:string[], error?:string, partial?:object}>}
   */
  async autogenSource(siteUrl, opts = {}) {
    const { generateSource } = require('./source/autogen.js');
    try {
      return await generateSource(siteUrl, { logger: this.logger, keyword: opts.keyword });
    } catch (e) {
      return { ok: false, steps: [], notes: [], error: e.message || String(e) };
    }
  }

  importSources(text, opts = {}) {
    const list = SourceStore.parseImport(text);
    if (!list.length) throw new Error('没有解析出任何书源');
    return { count: list.length, list };
  }

  exportSources(keys) {
    const all = this.sources.all();
    const picked = keys && keys.length ? all.filter((s) => keys.includes(keyOf(s))) : all;
    return { count: picked.length, text: SourceStore.export(picked, true) };
  }

  sourceStats() {
    return this.sources.stats();
  }

  /* ==================== 在线书源库（yck2026.fun / yckceo.com） ==================== */

  onlineList(opts = {}) {
    return yck.list(opts);
  }

  onlineDownload(id) {
    return yck.download(id);
  }

  /**
   * 在线书源站的线路（镜像站）状态。
   * 在线站随时可能被 ban，所以配了多个同构镜像；本方法报告当前线路并可按需强制重探。
   *
   * @param {object} [opts] { retry:boolean, kind:'shuyuan'|'rss' }
   * @returns {Promise<{shuyuan:string, rss:string, candidates:object, ok:boolean, error?:string}>}
   */
  async onlineRoute(opts = {}) {
    const kind = opts.kind || 'shuyuan';
    if (opts.retry) yck.resetBaseCache();
    const out = {
      shuyuan: yck.activeBase('shuyuan'),
      rss: yck.activeBase('rss'),
      candidates: { shuyuan: yck.candidateBases('shuyuan'), rss: yck.candidateBases('rss') },
      ok: true,
    };
    if (opts.retry || opts.check) {
      try {
        const r = await yck.list({ kind, page: 1 });
        out[kind] = r.base;
        out.checked = true;
      } catch (e) {
        out.ok = false;
        out.error = e.message;
      }
    }
    return out;
  }

  /** 从在线库下载并安装（仍然走可读性探测准入） */
  async installFromOnline(id, opts = {}) {
    const list = await yck.download(id);
    if (!list.length) throw new Error(`在线书源 ${id} 列表为空`);
    const results = [];
    for (const src of list) {
      // eslint-disable-next-line no-await-in-loop
      const r = await this.addSource(src, opts);
      results.push({ name: src.bookSourceName, ...r });
    }
    return results;
  }

  /* ==================== 在线「更新 / 校验」（m04402） ==================== */

  /**
   * 「更新」按钮：拉取在线列表（默认第 1 页 = 最近更新），把 updatedAt 落在
   * 最近窗口内的书源重新下载安装。返回逐条安装结果供界面汇总。
   *
   * @param {object} [opts] { kind:'shuyuan'|'rss', pages:1, days:7, probe, force, logger }
   */
  async syncOnlineUpdates(opts = {}) {
    const days = typeof opts.days === 'number' ? opts.days : 7;
    const since = Date.now() - days * 86400e3;
    const { fresh } = await yck.syncLatest({ kind: opts.kind, pages: opts.pages || 1, since });
    const results = { checked: fresh.length, added: 0, updated: 0, failed: 0, items: [] };
    for (const it of fresh) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const list = await yck.download(it.id, { kind: it.kind });
        for (const src of list) {
          // eslint-disable-next-line no-await-in-loop
          const r = await this.addSource(src, { probe: opts.probe !== false, force: !!opts.force });
          results[r.added ? 'added' : 'failed']++;
          results.items.push({ id: it.id, name: src.bookSourceName, ok: r.added, reason: r.reason });
        }
      } catch (e) {
        results.failed++;
        results.items.push({ id: it.id, name: it.name, ok: false, reason: e.message });
      }
    }
    return results;
  }

  /**
   * 「校验书源」按钮：对本地全部（或指定 key）书源重跑可读性探测。
   * @param {object} [opts] { keys?:string[], keyword, checkContent, concurrency, logger }
   * @returns {Promise<{total:number, passed:number, failed:number, results:Array}>}
   */
  async checkSources(opts = {}) {
    const all = this.sources.all();
    const wanted = opts.keys && opts.keys.length ? new Set(opts.keys.map((k) => String(k).toLowerCase())) : null;
    const targets = all.filter((s) => {
      if (!wanted) return true;
      return wanted.has(keyOf(s)) || wanted.has(String(s.bookSourceName || '').toLowerCase());
    });
    const results = [];
    let passed = 0;
    const concurrency = Math.max(1, Math.min(opts.concurrency || 3, 8));
    const queue = targets.slice();
    async function worker() {
      for (;;) {
        const src = queue.shift();
        if (!src) return;
        const key = keyOf(src);
        let r;
        try {
          r = await this.testSource(src, { keyword: opts.keyword, checkContent: opts.checkContent !== false });
        } catch (e) {
          r = { ok: false, allowed: false, reason: e.message, probe: null, errors: [e.message] };
        }
        if (r.probe) this.sources.saveProbeResult(key, r.probe);
        if (r.allowed) passed++;
        results.push({
          key,
          name: src.bookSourceName,
          ok: !!r.ok,
          allowed: !!r.allowed,
          reason: r.reason || '',
          score: r.probe ? r.probe.score : null,
          errors: r.errors || [],
        });
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker.call(this)));
    results.sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.name.localeCompare(b.name, 'zh'));
    return { total: targets.length, passed, failed: targets.length - passed, results };
  }

  /**
   * 探测状态表（供在线书源列表把「不可添加」的书源标红）：
   * url -> { allowed, reason, score, at }，allowed 按 canAdd 硬门槛重算。
   */
  probeStatusMap() {
    const prs = this.sources.probeResults();
    const map = {};
    for (const [key, pr] of Object.entries(prs)) {
      const gate = canAdd({ stages: pr.stages || {} });
      map[key] = {
        allowed: gate.allowed,
        reason: gate.reason || '',
        score: typeof pr.score === 'number' ? pr.score : null,
        at: pr.at || null,
      };
    }
    return map;
  }

  /* ==================== 订阅源（yckceo.com RSS） ==================== */

  /** 订阅源在线列表（yckceo /yuedu/rss/） */
  onlineRssList(opts = {}) {
    return yck.listRss(opts);
  }

  /** 订阅源本地列表 */
  listRss() {
    return this.rss.all().map((s) => {
      const key = String(s.sourceUrl || '').trim().replace(/\/+$/, '').toLowerCase()
        || 'name:' + String(s.sourceName || '').toLowerCase();
      return {
        key,
        name: s.sourceName || '',
        url: s.sourceUrl || '',
        group: s.sourceGroup || '',
        icon: s.sourceIcon || '',
        enabled: s.enabled !== false,
      };
    });
  }

  /**
   * 从在线订阅源库安装（下载 JSON → 结构校验 → 落 rss.json）。
   * @returns {{added:number,updated:number,skipped:number,items:Array}}
   */
  async installRssFromOnline(id, opts = {}) {
    const list = await yck.downloadRss(id);
    if (!list.length) throw new Error(`订阅源 ${id} 下载为空`);
    return this.rss.addMany(list, { force: !!opts.force });
  }

  /** 导入订阅源 JSON 文本 */
  importRss(text, opts = {}) {
    const list = RssStore.parseImport(text);
    if (!list.length) throw new Error('没有解析出任何订阅源（需要 sourceName/sourceUrl 字段）');
    return this.rss.addMany(list, { force: !!opts.force });
  }

  removeRss(key) {
    return this.rss.remove(key);
  }

  /* ==================== 搜索 ==================== */

  /**
   * 用某个书源搜索。
   * @param {string} sourceKey
   * @param {string} keyword
   * @param {number} [page=1]
   */
  async search(sourceKey, keyword, page = 1) {
    const src = this.sources.get(sourceKey);
    if (!src) throw new Error(`找不到书源：${sourceKey}`);
    const engine = new SourceEngine(src, {
      logger: this.logger,
      httpOptions: { timeout: 30000 },
    });
    const list = await engine.search(keyword, page);
    return { sourceKey: keyOf(src), source: src.bookSourceName, keyword, page, list };
  }

  /**
   * 跨多个书源搜索。
   *
   * 历史教训：这里原本是 `for (const k of keys) await this.search(...)` 的**串行**循环，
   * 单个源慢性超时（例如书源 searchUrl 是 `<js>` 片段、预取规则不收敛）会把整轮耗时
   * 累加成「源数 × 单源耗时」，界面表现为搜索永远转圈。现在改成并发 + 单源超时，
   * 与 `searchEverywhere` 用同一套编排参数语义（并发数 / 单源超时 / 整轮 deadline）。
   *
   * @param {string[]} sourceKeys 留空 = 全部书源
   * @param {number} [page=1]
   * @param {object} [opts] { concurrency=6, perSourceTimeout=15000, totalTimeout=45000 }
   * @returns {Promise<Array<{ok:boolean, sourceKey:string, source:string, keyword:string, page:number, list:Array, error?:string}>>}
   */
  async searchAll(keyword, sourceKeys, page = 1, opts = {}) {
    const keys = sourceKeys && sourceKeys.length ? sourceKeys : this.sources.all().map(keyOf);
    const concurrency = Math.max(1, Math.min(opts.concurrency || 6, 16));
    // 下限 200ms 的理由同 searchEverywhere：这些值只用于 race 定时，不参与网络层
    const perSourceTimeout = opts.perSourceTimeout ? Math.max(200, opts.perSourceTimeout) : 15000;
    const totalTimeout = opts.totalTimeout ? Math.max(200, opts.totalTimeout) : 45000;

    const startedAt = Date.now();
    const deadline = startedAt + totalTimeout;
    const out = new Array(keys.length);
    const queue = keys.map((k, i) => ({ k, i }));

    const worker = async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        const remain = deadline - Date.now();
        if (remain <= 0) {
          out[job.i] = {
            ok: false, sourceKey: job.k, source: job.k, keyword, page, list: [],
            error: `整体超时（>${totalTimeout}ms）未执行`, totalTimeout,
          };
          continue;
        }
        // 取 min(单源超时, 剩余整体时间)，保证整轮不会越过 deadline
        const slice = Math.max(1, Math.min(perSourceTimeout, remain));
        let to = false;
        const timer = new Promise((resolve) => setTimeout(() => { to = true; resolve('__timeout__'); }, slice));
        try {
          const r = await Promise.race([this.search(job.k, keyword, page), timer]);
          if (r === '__timeout__') {
            out[job.i] = { ok: false, sourceKey: job.k, source: job.k, keyword, page, list: [],
              error: `超时（>${slice}ms）`, timedOut: true };
          } else {
            out[job.i] = { ok: true, ...r };
          }
        } catch (e) {
          out[job.i] = { ok: false, sourceKey: job.k, source: job.k, keyword, page, list: [],
            error: e && e.message ? e.message : String(e), timedOut: to };
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
    return out;
  }

  /**
   * 全书源聚合搜索（「本地书源的全书源搜索」）。
   *
   * 与 searchAll 的差别在于它是**流式 + 并发 + 熔断**的：
   *  - 并发跑（默认 6 路），总耗时≈最慢的那个源，而不是所有源之和；
   *  - 每个源出结果就立刻 `onResult` 回调一次（增量返回，界面边搜边显示）；
   *  - 单源超时（默认 12s）即判失败，不拖累整体；
   *  - 按源历史表现排序（快的先跑），失败率高的源降权但仍会跑；
   *  - 结果按「书名+作者」聚合去重，同一本书多个来源合并成一条，供用户挑源。
   *
   * @param {string} keyword
   * @param {object} [opts]
   * @param {string[]} [opts.keys]        只搜这些源（留空=全部启用中的书源）
   * @param {number}  [opts.page=1]
   * @param {number}  [opts.concurrency=6]
   * @param {number}  [opts.perSourceTimeout=12000]
   * @param {number}  [opts.totalTimeout=30000] 整体超时（到点即结算，未回的源标 timeout）
   * @param {number}  [opts.limit]        只取排序后的前 N 个源（「换源」候选列表用，避免整书架范围搜太久）
   * @param {(ev:object)=>void} [opts.onResult] 每完成一个源回调一次
   * @param {(ev:object)=>void} [opts.onStart]  每开始一个源回调一次
   * @param {boolean} [opts.merge=true] 是否按书名聚合去重
   * @returns {Promise<{keyword, total, ok, failed, timedOut, elapsed, el, sources, groups}>}
   */
  async searchEverywhere(keyword, opts = {}) {
    const kw = String(keyword == null ? '' : keyword).trim();
    if (!kw) throw new Error('搜索关键词不能为空');

    const all = this.sources.all();
    const wanted = opts.keys && opts.keys.length
      ? new Set(opts.keys.map((k) => String(k).toLowerCase()))
      : null;
    // 只搜「有 searchUrl 且启用」的源；没 searchUrl 的源参与只会白等
    let targets = all.filter((s) => s && s.searchUrl && s.enabled !== false);
    if (wanted) targets = targets.filter((s) => wanted.has(keyOf(s)) || wanted.has(String(s.bookSourceName || '').toLowerCase()));

    // 按历史表现排序：成功率高、耗时短的优先（没有历史的排中间，保持稳定序）
    targets = this._rankSources(targets);

    // limit 在排序**之后**截断：要的是「最可能可用的 N 个源」，而不是「书源列表里的前 N 个」
    if (opts.limit > 0) targets = targets.slice(0, opts.limit);

    const page = opts.page || 1;
    const concurrency = Math.max(1, Math.min(opts.concurrency || 6, 16));
    // 下限 200ms：这个值只用来给「单源 race」定时，不参与网络层，调小了只是更早判失败。
    // 之前写成 Math.max(1000, ...)，把测试/界面传进来的 <1s 值悄悄抬到 1s，
    // 单源超时和整体超时都被这一条掩盖（表现为 elapsed 永远约等于 1s）。
    const perSourceTimeout = opts.perSourceTimeout ? Math.max(200, opts.perSourceTimeout) : 12000;
    // 整体超时不该被单源超时抬高：perSourceTimeout 只约束「单个源」，totalTimeout 约束「整轮」。
    // 同样只设下限，不再和单源超时取 max，否则「到点即结算」形同虚设。
    const totalTimeout = opts.totalTimeout ? Math.max(200, opts.totalTimeout) : 30000;

    const startedAt = Date.now();
    const deadline = startedAt + totalTimeout;
    const results = [];
    const queue = targets.slice();
    let done = 0;
    let timedOut = 0;

    const emit = (ev) => { try { if (opts.onResult) opts.onResult(ev); } catch (_) { /* 回调异常不影响搜索 */ } };

    async function worker() {
      for (;;) {
        const src = queue.shift();
        if (!src) return;
        const key = keyOf(src);
        // 每取一个新源都重判整体时限：源跑完后 socket 可能还在挂，deadline 已经过了
        const remain = deadline - Date.now();
        if (remain <= 0) return;

        if (opts.onStart) { try { opts.onStart({ key, name: src.bookSourceName, total: targets.length, started: done }); } catch (_) {} }

        const t0 = Date.now();
        let list = [];
        let error = '';
        let to = false;
        // 单源超时用 race 实现；engine 内部的 socket 也会随 timeout 结束。
        // 取 min(单源超时, 剩余整体时间)，保证整轮不会越过 deadline。
        const slice = Math.max(1, Math.min(perSourceTimeout, remain));
        const timer = new Promise((resolve) => setTimeout(() => { to = true; resolve('__timeout__'); }, slice));
        try {
          const r = await Promise.race([
            this.search(key, kw, page),
            timer,
          ]);
          if (r === '__timeout__') {
            error = `超时（>${slice}ms）`;
          } else {
            list = r.list || [];
          }
        } catch (e) {
          error = e.message || String(e);
        }
        const ms = Date.now() - t0;
        if (to) timedOut++;

        const rec = {
          key,
          name: src.bookSourceName || key,
          url: src.bookSourceUrl || '',
          ok: !error,
          count: list.length,
          ms,
          error,
          list,
        };
        results.push(rec);
        this._recordSourcePerf(key, rec);
        done++;
        emit({ ...rec, done, total: targets.length });
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker.call(this)));

    const elapsed = Date.now() - startedAt;
    const okCnt = results.filter((r) => r.ok).length;
    const groups = opts.merge === false ? [] : mergeBookGroups(results);
    // 未在时限内跑到的源（整体超时被截断）
    const ran = new Set(results.map((r) => r.key));
    const skipped = targets.filter((s) => !ran.has(keyOf(s))).map((s) => ({
      key: keyOf(s), name: s.bookSourceName || keyOf(s), ok: false, count: 0, ms: 0,
      error: `整体超时（>${totalTimeout}ms）未执行`, list: [],
    }));

    return {
      keyword: kw,
      page,
      total: targets.length,
      ran: results.length,
      ok: okCnt,
      failed: results.length - okCnt,
      timedOut,
      skipped: skipped.length,
      elapsed,
      el: `${(elapsed / 1000).toFixed(1)}s`,
      sources: [...results, ...skipped].sort((a, b) => Number(b.ok) - Number(a.ok) || b.count - a.count || a.ms - b.ms),
      groups,
    };
  }

  /* ==================== 更换书源 ==================== */

  /**
   * 在某个源上给「已知书名/作者」的书挑一个最佳候选。
   *
   * 严格度分级（**绝不在没匹配上时退回第一条**，那会把用户带到另一本书上）：
   *  1. 书名归一后完全相同 + 作者归一后相同 → 最高分（唯一可靠的身份判定）；
   *  2. 书名完全相同、作者对不上（新源作者字段常常为空或写法不同）→ 次选；
   *  3. 书名包含关系（「诡秘之主」命中「诡秘之主：宿命之环」这类同系列）→ 低分，仅在
   *     没有任何 1/2 级候选时启用；开启 `opts.strict` 时直接排除。
   *
   * 之所以不比较「作者为空」的一方：很多源搜索列表根本不返回作者，据此判「对不上」
   * 会误杀大量本该可用的候选。因此作者只参与加分，不参与一票否决。
   *
   * @param {Array} list 搜索结果
   * @param {string} name 期望书名
   * @param {string} author 期望作者（可空）
   * @param {(bk:string,burl:string)=>number|null} [chapterCountOf] 目录章数探针（用于同分打破平局）
   * @param {{strict?:boolean}} [opts]
   * @returns {{candidate:object, score:number, matchedBy:string}|null}
   */
  async _pickBestCandidate(list, name, author, chapterCountOf, opts = {}) {
    const nt = normTitle(name);
    const na = normAuthor(author || '');
    if (!nt) return null;

    const scored = [];
    for (const b of list || []) {
      if (!b || !b.bookUrl) continue;
      const bt = normTitle(b.name);
      const ba = normAuthor(b.author || '');
      if (!bt) continue;

      let score = 0;
      let matchedBy = '';
      if (bt === nt) {
        // 同名：作者也一致（或有一方压根没作者）才是同一本书
        if (na && ba && ba === na) { score = 100; matchedBy = 'name+author'; }
        else if (na && ba && (ba.includes(na) || na.includes(ba))) { score = 85; matchedBy = 'name+author-like'; }
        else if (!ba) { score = 70; matchedBy = 'name'; }
        else { score = 60; matchedBy = 'name'; }
      } else if (bt.includes(nt) || nt.includes(bt)) {
        // 包含关系：同名书之外的弱匹配，只在没有精确同名时才考虑
        score = 30;
        matchedBy = 'name-fuzzy';
        if (na && ba && (ba === na || ba.includes(na) || na.includes(ba))) { score = 50; matchedBy = 'name-fuzzy+author'; }
        if (opts.strict) continue;
      } else {
        continue; // 书名对不上 → 直接丢弃，绝不当候选
      }
      scored.push({ candidate: b, score, matchedBy });
    }

    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score || String(a.candidate.name).localeCompare(String(b.candidate.name), 'zh'));

    // 同分时的平局打破：目录章数更接近旧书的更可能是同一本（不同源的收录进度往往差很多）
    if (scored.length > 1 && scored[0].score === scored[1].score && chapterCountOf) {
      const picked = await this._refineTie(scored, chapterCountOf);
      if (picked) return picked;
    }
    return scored[0];
  }

  /** 同分候选之间用「目录章数最接近期望值」定序；探不动目录的候选保持原相对顺序 */
  async _refineTie(scored, chapterCountOf) {
    const topScore = scored[0].score;
    const tied = scored.filter((s) => s.score === topScore).slice(0, 5);
    for (const s of tied) {
      try {
        // eslint-disable-next-line no-await-in-loop
        s.count = await chapterCountOf(s.candidate.name, s.candidate.bookUrl);
      } catch (_) {
        s.count = null;
      }
    }
    const usable = tied.filter((s) => Number.isFinite(s.count) && s.count > 0);
    if (usable.length < 2) return null;
    usable.sort((a, b) => b.count - a.count);
    return usable[0];
  }

  /**
   * 把一个书架里的藏书换到另一个书源上。
   *
   * ## 为什么不能只改字段
   * `Library.bookIdOf(sourceKey, bookUrl)` 把**来源与书地址一起**算进了主键，换源后
   * 两者都可能变 → bookId 必变。目录/正文/进度都按 bookId 分目录落盘，所以这是一次
   * 「数据迁移」而不只是改元信息：
   *   1. 在新源上重新定位这本书（拿到新 bookUrl）；
   *   2. 在新 bookId 下重建书架条目与目录；
   *   3. 把阅读进度搬过去；
   *   4. 决定旧条目 / 旧正文目录的去留。
   *
   * ## 为什么默认**不**迁移旧正文
   * 章节正文是按「序号」存文件的（`chapters/00012.txt`），而不同书源的章节**切分粒度**
   * 与**排序**都可能不同：同一个第 12 章，A 源是 3000 字一整章，B 源可能拆成两章，
   * 或者卷/序章的处理不同。按序号硬搬会让「第 12 章的正文」变成原著里另一段情节
   * ——这种「串章」错位是静默的，用户读到几十章后才可能发现，而进度已经写进去了。
   * 所以默认**干净重下**（正文本来就靠「文件是否存在」判断是否已下载，重下天然是
   * 断点续传的），只保留「读到第几章」这个不受源影响的阅读位置。
   * 需要急着看离线内容的用户可显式 `keepChapters: true` 按序号搬运，返回值里会给出
   * `migratedChapters` 与 `migrationRisk` 说明风险。
   *
   * @param {string} bookId 旧书的书架 id
   * @param {string} newSourceKey 目标书源 key（URL 或名称，大小写/尾斜杠不敏感）
   * @param {object} [opts]
   * @param {boolean} [opts.keepChapters=false] 按章节序号把旧正文复制到新书目录（有串章风险）
   * @param {boolean} [opts.keepOld=false]      保留旧书架条目（默认替换，避免出现两本重复书）
   * @param {boolean} [opts.deleteOldFiles=false] 删除旧书的本地目录（默认保留，留作回退）
   * @param {boolean} [opts.strictMatch=false]  只接受精确同名匹配，不做包含关系兜底
   * @param {boolean} [opts.download=false]     'full' = 下全书；其他真值 = 下初始窗口；默认不下载
   * @param {string}  [opts.keyword]            覆盖搜索关键词（默认用旧书名）
   * @param {(ev:object)=>void} [opts.onProgress]
   * @returns {Promise<{bookId, oldBookId, name, sourceName, chapterCount, progressKept, migratedChapters, matchedBy}>}
   */
  async changeSource(bookId, newSourceKey, opts = {}) {
    const old = this.library.get(bookId);
    if (!old) throw new Error(`书架里没有这本书：${bookId}`);

    const newSrc = this.sources.get(newSourceKey);
    if (!newSrc) throw new Error(`找不到书源：${newSourceKey}`);
    const newKey = keyOf(newSrc);

    const oldKey = String(old.sourceKey || '');
    if (oldKey && newKey === String(oldKey).toLowerCase()) {
      throw new Error(`这本书已经在「${newSrc.bookSourceName}」上了，无需更换`);
    }

    const title = String(opts.keyword || old.name || '').trim();
    if (!title) throw new Error('旧书记录缺少书名，无法在新书源上定位');

    const emit = (ev) => { try { if (opts.onProgress) opts.onProgress(ev); } catch (_) { /* 回调异常不影响换源 */ } };

    /* ---- 1. 在新源上重新定位这本书 ---- */
    emit({ stage: 'search', message: `在「${newSrc.bookSourceName}」搜索《${title}》…` });
    const engine = new SourceEngine(newSrc, { logger: this.logger, httpOptions: { timeout: 30000 } });
    const list = await engine.search(title, 1);
    const picked = await this._pickBestCandidate(
      list,
      title,
      old.author,
      (bk, burl) => this._tocCountOf(newSrc, burl),
      { strict: !!opts.strictMatch }
    );
    if (!picked) {
      // 错误信息要说清楚「搜到了但没有一本对得上」，否则用户会以为新源不支持搜索
      throw new Error(
        `新书源「${newSrc.bookSourceName}」上没有找到《${title}》` +
        `（搜索返回 ${list.length} 条，没有书名匹配的候选）。` +
        `可先加入书架手动确认，或改用其它书源。`
      );
    }
    const cand = picked.candidate;
    const newBookUrl = String(cand.bookUrl || '');
    if (!newBookUrl) throw new Error(`新书源「${newSrc.bookSourceName}」返回的候选缺少书籍地址`);

    /* ---- 2. 拉新源详情 + 目录（走 Downloader，保证与 addToShelf 一致的落盘路径） ---- */
    emit({ stage: 'toc', message: `抓取新书源目录…` });
    const newBookIdEarly = bookIdOf(newKey, newBookUrl);
    let added;
    try {
      added = await this.downloader.addBook(newSrc, {
        name: cand.name || title,
        author: cand.author || old.author || '',
        intro: cand.intro || old.intro || '',
        kind: cand.kind || old.kind || '',
        coverUrl: cand.coverUrl || old.coverUrl || '',
        bookUrl: newBookUrl,
      });
    } catch (e) {
      // addBook 是「先写书架行、再抓目录」，抓目录失败时会在新 bookId 下留一条没有目录的
      // 空条目。换源是「要么全成、要么保持原样」的操作，失败必须回滚这条半成品，
      // 否则用户会在书架上看到一本打不开的书，而旧书还好端端在那里。
      this.library.remove(newBookIdEarly, { deleteFiles: true });
      throw new Error(
        `新书源「${newSrc.bookSourceName}」上这本书抓不到目录（${e.message}）。` +
        `可能是该源搜索结果的书籍地址不是详情页，或该源收录不完整，请换一个书源。`
      );
    }
    const newBookId = added.id;
    if (newBookId !== newBookIdEarly) {
      // 正常不可能发生；真发生了说明 bookUrl 被书源的 init 规则改写过，以实际落盘为准
      this._log(`[changeSource] bookId 与预估不一致：${newBookIdEarly} → ${newBookId}`);
    }
    const chapterCount = added.chapterCount || 0;

    /* ---- 3. 迁移阅读进度 ---- */
    // 进度里的 index/percent 是「书内位置」而非「正文文件位置」，换源后语义仍然成立，
    // 所以整体搬过去；只有章数变少（新源收录不全）时才夹到有效范围内。
    const oldProgress = this.library.progress(bookId);
    const kept = {
      index: Math.max(0, Math.min(oldProgress.index || 0, Math.max(0, chapterCount - 1))),
      offset: oldProgress.offset || 0,
      percent: oldProgress.percent || 0,
    };
    this.library.saveProgress(newBookId, kept);
    const progressKept = (oldProgress.index || 0) > 0 || (oldProgress.percent || 0) > 0;

    /* ---- 4. 旧正文：默认不迁移（理由见方法注释），按需按序号搬运 ---- */
    let migratedChapters = 0;
    let migrationRisk = '';
    if (opts.keepChapters) {
      const oldIdxs = this.library.downloadedIndexes(bookId);
      for (const i of oldIdxs) {
        if (i >= chapterCount) break; // 新源章数更少，多出来的序号没有落点
        const text = this.library.chapter(bookId, i);
        if (text == null) continue;
        this.library.saveChapter(newBookId, i, text);
        migratedChapters++;
      }
      this.library.syncDownloadedCount(newBookId);
      migrationRisk = migratedChapters
        ? `按章节序号搬运了 ${migratedChapters} 章正文，未校验内容对应关系；` +
          `若两个书源的章节切分粒度/顺序不同，可能出现串章，请抽查后再继续阅读。`
        : '';
    } else {
      migrationRisk = '默认不迁移旧正文（按序号硬搬可能串章），新源正文将按需重新下载。';
    }

    /* ---- 5. 旧条目与旧文件的去留 ---- */
    // 默认替换旧条目：bookId 变了，不删就会出现「同一本书两条」，用户无从分辨。
    // 旧正文目录默认保留（删掉不可恢复，而重下要花很长时间），只有显式要求才删。
    let oldRemoved = false;
    if (!opts.keepOld && newBookId !== bookId) {
      oldRemoved = this.library.remove(bookId, { deleteFiles: !!opts.deleteOldFiles });
    } else if (newBookId === bookId) {
      // 换源后 bookId 理论上必变（源 key 已校验不同 + bookUrl 不同 → md5 不同）。真撞上只能说
      // 明源地址被改写成同一个，此时绝不能删「旧条目」——那正是刚建好的新书。宁可留着重复
      // 条目让用户自己删，也不能把刚迁移过来的书连带正文一起 rmSync 掉。
      this._log(`[changeSource] 换源前后 bookId 相同（${bookId}），跳过删除旧条目以避免误删新书`);
    } else if (opts.deleteOldFiles) {
      fs.rmSync(this.library.bookDir(bookId), { recursive: true, force: true });
    }

    /* ---- 6. 可选的正文下载（复用懒加载窗口语义，不新增下载路径） ---- */
    let download = null;
    if (opts.download === 'full') {
      download = await this.downloader.downloadChapters(newSrc, newBookId, opts);
    } else if (opts.download) {
      // 从保留的进度位置往后补，而不是永远从第 0 章开始
      download = await this.downloadWindow(newBookId, kept.index, opts);
    }

    this._log(`《${added.name}》已换源到「${newSrc.bookSourceName}」：${chapterCount} 章，进度保留至第 ${kept.index + 1} 章`);

    return {
      bookId: newBookId,
      oldBookId: bookId,
      name: added.name,
      sourceKey: newKey,
      sourceName: newSrc.bookSourceName || newKey,
      bookUrl: newBookUrl,
      chapterCount,
      progress: kept,
      progressKept,
      migratedChapters,
      migrationRisk,
      matchedBy: picked.matchedBy,
      matchScore: picked.score,
      candidate: {
        name: cand.name || '',
        author: cand.author || '',
        bookUrl: newBookUrl,
        intro: cand.intro || '',
        kind: cand.kind || '',
        coverUrl: cand.coverUrl || '',
      },
      oldProgress,
      oldRemoved,
      oldFilesKept: !opts.deleteOldFiles,
      download,
    };
  }

  /** 目录章数探针（换源匹配平局时用）；失败返回 null，不抛 */
  async _tocCountOf(source, bookUrl) {
    try {
      const engine = new SourceEngine(source, { logger: this.logger, httpOptions: { timeout: 20000 } });
      const info = await engine.bookInfo(bookUrl);
      const chapters = await engine.toc((info && info.tocUrl) || bookUrl);
      return Array.isArray(chapters) && chapters.length ? chapters.length : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * 粗判一个 bookUrl 是否「明显不可抓」（不联网、只看形态）。
   *
   * 起因：实测「速读谷」源返回的 bookUrl 形如
   * `https://suduguu.com/13/…/13/211991.html`（路径段重复、明显畸形），拿它抓目录必失败。
   * 换源流程本身会回滚，不会留脏数据，但候选列表里混进这种「搜得到、点进去抓不到」的条目
   * 会让用户白试一次。这里只做**零成本**的形态筛查（不做探测——每个候选一次请求会显著拖慢
   * 并发搜索），把可疑项标出来交给界面弱化展示 + 提示。
   *
   * 注意：这是启发式，**不能**当作拒绝依据——只用来排序与提示。
   * @returns {string} 空字符串 = 形态正常；否则返回人话原因
   */
  urlLooksBroken(url) {
    const u = String(url || '').trim();
    if (!u) return '书源没有给出书籍地址';
    if (!/^https?:\/\//i.test(u)) return '书籍地址不是 http(s) 链接';
    // 取出路径部分（去掉协议、主机、查询串、锚点）
    let p = '';
    try {
      const o = new URL(u);
      p = o.pathname || '';
      if (!o.hostname || !/\./.test(o.hostname)) return '书籍地址缺少有效域名';
    } catch (_) {
      return '书籍地址不是合法 URL';
    }
    const segs = p.split('/').filter(Boolean);
    // 1) 同一路径段连续重复两次以上（/13/…/13/ 或 /a/a/）——实测畸形样本的首要特征
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i] === segs[i + 1] && segs[i].length >= 1) return '书籍地址路径段重复';
    }
    // 2) 同名段在整个路径里出现 2 次以上且夹有内容（/book/123/book/…）
    const seen = new Map();
    for (const s of segs) seen.set(s, (seen.get(s) || 0) + 1);
    for (const [s, n] of seen) {
      if (n >= 2 && s.length >= 2 && /^\d+$/.test(s)) return '书籍地址数字路径段重复';
    }
    // 3) 路径太深（> 8 段）往往是拼接错误
    if (segs.length > 8) return '书籍地址层级过深';
    // 4) 带空白/控制字符（书源 JS 拼接出错）
    if (/[\s\u0000-\u001f]/.test(u)) return '书籍地址含空白或控制字符';
    // 5) 地址其实指向「搜索页」而不是书籍详情页。
    //    实测「得奇小说」源对《诡秘之主》返回的 bookUrl 就是它自己的搜索脚本
    //    `https://www.deqixss.com/modules/article/search.php`（形态完全合法，前 4 条都查不出来），
    //    拿它抓目录必然为空。这类地址的判据是「路径末段是搜索端点」或「查询串里带搜索词」。
    const last = segs[segs.length - 1] || '';
    if (/^(search|search\.php|search\.html?|s\.html?|so\.?php|query\.php)$/i.test(last)) {
      return '书籍地址指向搜索页而非详情页';
    }
    if (/(?:^|[?&])(?:q|wd|kw|key|keyword|searchkey)=/i.test(u)) {
      return '书籍地址是带搜索词的搜索结果页';
    }
    return '';
  }

  /**
   * 给书架里的一本书**并发**在多个书源上找同名书，供界面列出候选让用户挑。
   *
   * 复用 `searchEverywhere` 的编排（同一个 `_rankSources` 历史排序 + 单源 race 超时 +
   * 整体 deadline + `_recordSourcePerf` 性能档案），只是搜索词固定为书名、且不要求
   * 每个源都跑完：`opts.limit` 限制源数量，`opts.onlyMatches` 只回书名能对上的候选，
   * 免得把「全书源搜同名关键词」的一大堆无关结果原样丢给用户。
   *
   * @param {string} bookId
   * @param {object} [opts]
   * @param {string[]} [opts.keys]     限定书源（key 或书名，留空=全部启用且有 searchUrl 的源）
   * @param {number}  [opts.limit]     最多搜几个源（默认不限制；注意它在 `_rankSources` 排序后截断，
   *                                   在没有任何性能历史时排序退化为按书名中文序，调小会漏掉真正
   *                                   收录了这本书的源，所以换源场景建议留空，靠 totalTimeout 控全局）
   * @param {number}  [opts.concurrency=6]
   * @param {number}  [opts.perSourceTimeout=12000]
   * @param {number}  [opts.totalTimeout=30000]
   * @param {boolean} [opts.onlyMatches=true] 只返回书名能对上的候选
   * @param {boolean} [opts.strictMatch=false] 只要精确同名（不做包含关系兜底）
   * @param {boolean} [opts.excludeCurrent=true] 排除该书当前所在的源
   * @param {string}  [opts.keyword]   覆盖搜索关键词
   * @param {(ev:object)=>void} [opts.onCandidate] 每发现一个候选就回调一次（增量展示）
   * @returns {Promise<{bookId, name, keyword, candidates:Array, searched, failed, elapsed}>}
   */
  async sourceCandidates(bookId, opts = {}) {
    const book = this.library.get(bookId);
    if (!book) throw new Error(`书架里没有这本书：${bookId}`);
    const keyword = String(opts.keyword || book.name || '').trim();
    if (!keyword) throw new Error('这本书没有书名，无法搜索候选书源');

    const skipCurrent = opts.excludeCurrent !== false;
    const keys = (opts.keys && opts.keys.length ? opts.keys : this.sources.all().map(keyOf))
      .filter((k) => !(skipCurrent && String(k).toLowerCase() === String(book.sourceKey || '').toLowerCase()));

    const r = await this.searchEverywhere(keyword, {
      keys,
      limit: opts.limit,
      concurrency: opts.concurrency || 6,
      perSourceTimeout: opts.perSourceTimeout || 12000,
      totalTimeout: opts.totalTimeout || 30000,
      merge: false, // 这里是「一个源一个候选」，不要按书名合并掉来源
    });

    const candidates = [];
    for (const s of r.sources) {
      if (!s.ok || !s.list || !s.list.length) continue;
      // eslint-disable-next-line no-await-in-loop
      const picked = await this._pickBestCandidate(
        s.list,
        keyword,
        book.author,
        null,
        { strict: !!opts.strictMatch }
      );
      if (!picked && opts.onlyMatches !== false) continue;
      const cand = picked ? picked.candidate : s.list[0];
      // 形态筛查：明显畸形的地址标出来，界面弱化展示并提示「可能抓不到目录」
      // （不能据此拒绝——这是启发式；真正的把关在 changeSource 抓目录失败时回滚）
      const broken = this.urlLooksBroken(cand.bookUrl);
      const item = {
        sourceKey: s.key,
        sourceName: s.name,
        sourceUrl: s.url,
        bookUrl: cand.bookUrl || '',
        name: cand.name || '',
        author: cand.author || '',
        intro: cand.intro || '',
        coverUrl: cand.coverUrl || '',
        lastChapter: cand.lastChapter || '',
        // 无匹配（onlyMatches=false 时才可能）给 0 分，界面据此提示「低置信」
        score: picked ? picked.score : 0,
        matchedBy: picked ? picked.matchedBy : 'none',
        ms: s.ms,
        suspicious: !!broken,
        suspiciousReason: broken,
      };
      candidates.push(item);
      if (opts.onCandidate) { try { opts.onCandidate(item); } catch (_) { /* 回调异常不影响搜索 */ } }
    }

    // 排序：分数降序 → 形态可疑的沉到后面（同等分数先给能抓的）→ 源名中文序
    candidates.sort(
      (a, b) => b.score - a.score
        || (a.suspicious ? 1 : 0) - (b.suspicious ? 1 : 0)
        || String(a.sourceName).localeCompare(String(b.sourceName), 'zh')
    );
    return {
      bookId,
      name: book.name,
      keyword,
      candidates,
      searched: r.total,
      ran: r.ran,
      failed: r.failed,
      elapsed: r.elapsed,
      el: r.el,
      sources: r.sources.map((s) => ({ key: s.key, name: s.name, ok: s.ok, count: s.count, ms: s.ms, error: s.error })),
    };
  }

  /* ---------------- 全书源搜索：源排序与性能档案 ---------------- */

  /** 源性能档案：key -> { runs, ok, fail, totalMs, lastAt }（只存内存 + 落盘节流） */
  _perfTable() {
    if (!this._perf) this._perf = this._loadPerf();
    return this._perf;
  }

  _loadPerf() {
    try {
      const f = path.join(this.dataDir, 'source-perf.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch (_) {
      return {};
    }
  }

  _savePerf() {
    try {
      const f = path.join(this.dataDir, 'source-perf.json');
      const tmp = `${f}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._perfTable(), null, 2), 'utf8');
      fs.renameSync(tmp, f);
    } catch (_) { /* 性能档案落盘失败不影响搜索 */ }
  }

  _recordSourcePerf(key, rec) {
    const t = this._perfTable();
    const cur = t[key] || { runs: 0, ok: 0, fail: 0, totalMs: 0, lastAt: 0 };
    cur.runs++;
    if (rec.ok) cur.ok++;
    else cur.fail++;
    cur.totalMs += rec.ms || 0;
    cur.lastAt = Date.now();
    t[key] = cur;
    // 每 20 次落一次盘，避免频繁 IO
    this._perfWrites = (this._perfWrites || 0) + 1;
    if (this._perfWrites % 20 === 0) this._savePerf();
  }

  /** 按历史表现排序：成功率高的先跑，其次平均耗时短的先跑 */
  _rankSources(list) {
    const t = this._perfTable();
    return list.slice().sort((a, b) => {
      const pa = t[keyOf(a)];
      const pb = t[keyOf(b)];
      const score = (p) => {
        if (!p || !p.runs) return 0.5; // 无历史 → 中间
        const rate = p.ok / p.runs;
        const avg = p.totalMs / p.runs;
        return rate - Math.min(avg, 20000) / 40000;
      };
      const d = score(pb) - score(pa);
      if (Math.abs(d) > 1e-6) return d;
      return String(a.bookSourceName || '').localeCompare(String(b.bookSourceName || ''), 'zh');
    });
  }

  /** 某个源的性能档案（供界面展示「该源平均 x.xs / 成功率 y%」） */
  sourcePerf(key) {
    const p = this._perfTable()[String(key).toLowerCase()] || null;
    if (!p || !p.runs) return null;
    return {
      runs: p.runs,
      okRate: Math.round((p.ok / p.runs) * 100),
      avgMs: Math.round(p.totalMs / p.runs),
      lastAt: p.lastAt,
    };
  }

  /** 清空源性能档案（界面「重置统计」用） */
  resetSourcePerf() {
    this._perf = {};
    this._savePerf();
    return true;
  }

  /* ==================== 书架 / 下载 ==================== */

  shelf() {
    return this.library.books();
  }

  book(bookId) {
    return this.library.get(bookId);
  }

  removeBook(bookId) {
    return this.library.remove(bookId);
  }

  toc(bookId) {
    return this.library.toc(bookId);
  }

  /**
   * 检查书架里小说有没有更新（启动自动检查 / 书架「检查更新」按钮 / CLI check 共用）。
   *
   * 结果同时写回 shelf.json 的每本书（lastCheckAt / updateStatus / updateCount /
   * latestChapter / updateError），界面据此渲染「有更新 / 已是最新 / 检查失败」徽标。
   *
   * @param {object} [opts]
   * @param {string[]} [opts.bookIds] 只查这几本（留空=整个书架）
   * @param {number} [opts.concurrency=3]
   * @param {number} [opts.timeout=20000] 单本超时
   * @param {boolean} [opts.applyToc=true] 远端纯追加时是否把新章写进本地目录
   * @param {boolean} [opts.dryRun=false] 只比对不落盘
   * @param {(ev:object)=>void} [opts.onProgress]
   */
  async checkUpdates(opts = {}) {
    return checkShelfUpdates({
      ...opts,
      library: this.library,
      sources: this.sources,
      makeEngine: opts.makeEngine,
    });
  }

  /** 只检查一本书（单本卡片上的「检查更新」） */
  async checkBook(bookId, opts = {}) {
    const book = this.library.get(bookId);
    if (!book) throw new Error(`书架里没有这本书：${bookId}`);
    return checkBookUpdate({
      ...opts,
      library: this.library,
      sources: this.sources,
      book,
      makeEngine: opts.makeEngine,
    });
  }

  /** 加入书架（只抓目录，不下载正文） */
  /**
   * 加入书架。
   *
   * `opts.download` 有两种语义：
   *  - `'full'`（旧行为）：下全书，长篇小说极慢，仅导出成书时需要；
   *  - 其他真值（默认）：下**前 INITIAL_WINDOW 章**（懒加载初始窗口），
   *    保证加入后能立刻连续阅读，剩下的等读到再补。
   */
  async addToShelf(sourceKey, book, opts = {}) {
    const src = this.sources.get(sourceKey);
    if (!src) throw new Error(`找不到书源：${sourceKey}`);
    const r = await this.downloader.addBook(src, book);
    if (opts.download === 'full') {
      r.download = await this.downloader.downloadChapters(src, r.id, opts);
    } else if (opts.download) {
      // 初始窗口：从第 0 章开始看，所以按 index=0 算窗口（= 前 INITIAL_WINDOW 章）
      r.download = await this.downloadWindow(r.id, 0, opts);
    }
    return r;
  }

  /**
   * 懒加载窗口：读到第 index 章时，把它后面 READAHEAD_WINDOW 章下下来。
   *
   * 同一本书同时只允许一个窗口任务：用户快速连翻章节时会有多次调用，
   * 若并发跑会重复拉同一段（反而更慢，还可能触发站点限流）。
   * 后来者直接返回 `{ skipped: true }`，由调用方决定是否在本次任务结束后重试。
   *
   * @param {string} bookId
   * @param {number} index 当前阅读到的章序号（0 基）
   * @param {object} [opts] { force, onProgress }
   */
  async downloadWindow(bookId, index, opts = {}) {
    const book = this.library.get(bookId);
    if (!book) throw new Error(`书架里没有这本书：${bookId}`);
    const src = this.sources.get(book.sourceKey);
    if (!src) throw new Error(`书源已不存在：${book.sourceKey}（可能已被删除，请重新添加）`);

    this._windowPending = this._windowPending || new Map();
    if (this._windowPending.get(bookId) && !opts.force) {
      return { skipped: true, reason: '同一本书已有下载任务在进行', bookId };
    }
    const task = (async () => {
      try {
        const r = await this.downloader.downloadWindow(src, bookId, index, opts);
        if (opts.onProgress && !r.empty) {
          this._log(`预取《${book.name}》第 ${r.from + 1}-${r.to + 1} 章：成功 ${r.done}，跳过 ${r.skipped}，失败 ${r.failed}`);
        }
        return r;
      } finally {
        this._windowPending.delete(bookId);
      }
    })();
    this._windowPending.set(bookId, task);
    return task;
  }

  /** 是否有窗口下载在进行（界面据此显示「后台下载中」） */
  windowBusy(bookId) {
    return !!(this._windowPending && this._windowPending.get(bookId));
  }

  /** 下载正文（支持 from/to/force，默认断点续传） */
  async download(bookId, opts = {}) {
    const book = this.library.get(bookId);
    if (!book) throw new Error(`书架里没有这本书：${bookId}`);
    const src = this.sources.get(book.sourceKey);
    if (!src) throw new Error(`书源已不存在：${book.sourceKey}（可能已被删除，请重新添加）`);
    return this.downloader.downloadChapters(src, bookId, opts);
  }

  /* ==================== 下载队列（界面「下载」页签） ==================== */

  /**
   * 把一本书的下载任务交给队列。
   *
   * 与 download() 的区别：download() 是「同步等它下完」的原始能力（CLI / 单章重下用），
   * 本方法是界面用的：立刻返回任务快照，进度靠 listDownloads() 轮询或事件推送获得。
   * 同一本书已有排队/运行中的任务时，直接返回那一条（不叠加第二条流水线）。
   *
   * @param {string} bookId
   * @param {object} [opts] { from, to, force }
   */
  enqueueDownload(bookId, opts = {}) {
    const book = this.library.get(bookId);
    if (!book) throw new Error("书架里没有这本书：" + bookId);
    const src = this.sources.get(book.sourceKey);
    if (!src) throw new Error("书源已不存在：" + book.sourceKey + "（可能已被删除，请重新添加）");
    return this.downloads.enqueue({ bookId, from: opts.from, to: opts.to, force: opts.force });
  }

  /** 全部下载任务快照 + 概览（界面下载页签每次轮询拿这个） */
  listDownloads() {
    return { jobs: this.downloads.list(), summary: this.downloads.summary() };
  }

  /** 取消一条下载任务：排队中的立刻撤下，运行中的本章跑完即收手 */
  cancelDownload(jobId) {
    return this.downloads.cancel(jobId);
  }

  /**
   * 暂停一条下载任务（停止但保留任务）：排队中的直接停下，运行中的本章跑完即收手。
   * 与 cancelDownload 的区别：收尾是 paused，界面会给「继续」，已下的章节不丢。
   */
  pauseDownload(jobId) {
    return this.downloads.pause(jobId);
  }

  /** 继续一条停下的任务（paused / canceled / interrupted / error）：原地断点续传 */
  resumeDownload(jobId) {
    return this.downloads.resume(jobId);
  }

  /** 清掉已结束的任务记录（排队/运行中的保留） */
  clearFinishedDownloads() {
    return this.downloads.clearFinished();
  }

  chapter(bookId, index) {
    return this.library.chapter(bookId, index);
  }

  progress(bookId) {
    return this.library.progress(bookId);
  }

  saveProgress(bookId, p) {
    return this.library.saveProgress(bookId, p);
  }

  /* ==================== TXT 导出 ==================== */

  /**
   * 导出单本书为 TXT。
   * @param {string} bookId
   * @param {object} opts { layout, encoding, includeToc, outDir, onlyDownloaded }
   */
  exportBook(bookId, opts = {}) {
    const book = this.library.get(bookId);
    if (!book) throw new Error(`书架里没有这本书：${bookId}`);
    const toc = this.library.toc(bookId);
    const outDir = opts.outDir || path.join(this.dataDir, 'export');
    const res = exportTxt({
      book,
      toc,
      getChapter: (i) => this.library.chapter(bookId, i),
      outDir,
      options: opts,
    });
    return { bookId, name: book.name, ...res };
  }

  /** 批量导出整个书架 */
  exportShelf(opts = {}) {
    const outDir = opts.outDir || path.join(this.dataDir, 'export');
    return exportLibrary(this.library, outDir, opts, {
      onlyBookIds: opts.bookIds,
    });
  }

  /* ==================== 备份 / 恢复 ==================== */

  /**
   * 生成备份文本（书源 + 订阅源 + 书架/进度/目录，不含正文）。
   * @param {object} [opts] { scope: 'all'|'sources', includeToc, includeProgress }
   * @returns {{filename:string, scope:string, counts:object, text:string}}
   */
  createBackup(opts = {}) {
    const payload = backup.create(this, opts);
    return {
      filename: backup.defaultName(),
      scope: payload.scope,
      counts: payload.counts,
      text: backup.serialize(payload),
    };
  }

  /** 只读预览备份内容（界面确认弹窗用，不落盘） */
  inspectBackup(text) {
    return backup.inspect(text);
  }

  /**
   * 恢复备份（只增不删；已存在的书源/订阅源默认跳过，opts.force 才覆盖）。
   * @param {string} text
   * @param {object} [opts] { force, sources, rss, books, progress, toc }
   */
  async restoreBackup(text, opts = {}) {
    return backup.restore(this, text, opts);
  }

  static exportDefaults() {    return { ...DEFAULTS };
  }

  static normalizeOptions(o) {
    return normalizeOptions(o);
  }

  /* ==================== 诊断 ==================== */

  info() {
    const s = this.sourceStats();
    const books = this.library.books();
    const chapters = books.reduce((n, b) => n + (b.downloadedCount || 0), 0);
    return {
      dataDir: this.dataDir,
      sources: s,
      books: books.length,
      chapters,
    };
  }
}

module.exports = { App, resolveDataDir, DEFAULTS };
