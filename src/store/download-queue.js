'use strict';
/**
 * 下载队列：把「下载正文」从界面线程里摘出来，改成有独立进度面板的后台任务。
 *
 * 背景（用户反馈）：以前在书架点「下载」→ 渲染端 `run('下载中…', …)` 拉一个
 * 几百章的全书任务，整块遮罩锁住界面，几千章的小说能锁上十几分钟，看起来就是
 * 「点下载就卡死」。现在改成：
 *
 *  - 主进程侧排队执行，渲染进程只读快照（`list()` / 事件推送），界面永不阻塞；
 *  - 每本书同时只有一个任务（同一本书重复点「下载」不会叠加成两条流水线）；
 *  - 队列串行跑（并发不同的书会把同一站点的限流打爆，反而更慢）；
 *  - 任务快照落盘到 `<dataDir>/downloads.json`，重启后保留最近 50 条**已完成**记录，
 *    排队/运行中的任务重启后标记为「已中断」（进程没了，任务确实不会自己接着跑）。
 *
 * 进度统计口径：`processed = done + skipped + failed`，`percent` 按它算；
 * 每完成一章就推一次快照，界面因此能显示真实进度条而不是转圈。
 *
 * 注意：`Downloader.downloadChapters` 是「整块 await 完才返回」，中途没有回调，
 * 所以这里的进度靠**轮询本地章节文件数**（`library.downloadedIndexes`）得到：
 * 每 `POLL_MS` 对比一次区间内的文件数，差值就是这一拍的完成数。这样不用改造
 * downloader 的公共接口，断点续传/已存在跳过的语义也天然正确。
 */

const fs = require('fs');
const path = require('path');

/** 同一区间两次进度采样之间的间隔 */
const POLL_MS = 600;
/** 落盘的已完成记录上限（只留最近的，避免 downloads.json 无限长大） */
const KEEP_FINISHED = 50;

const STATUS = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  error: 'error',
  canceled: 'canceled',
  interrupted: 'interrupted',
  paused: 'paused',
};

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJSON(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class DownloadQueue {
  /**
   * @param {object} opts
   * @param {import('./library').Library} opts.library
   * @param {import('./downloader').Downloader} opts.downloader
   * @param {string} opts.dataDir
   * @param {(snap:object)=>void} [opts.onChange] 任务快照变化回调（主进程据此往界面推事件）
   */
  constructor(opts = {}) {
    if (!opts.library) throw new Error('DownloadQueue 需要 library');
    if (!opts.downloader) throw new Error('DownloadQueue 需要 downloader');
    this.lib = opts.library;
    this.downloader = opts.downloader;
    this.dataDir = opts.dataDir || this.lib.dir;
    this.file = path.join(this.dataDir, 'downloads.json');
    this.onChange = opts.onChange || null;
    this.jobs = [];
    this.seq = 0;
    this.pumping = false;
    this._restore();
  }

  /* ---------------- 落盘 / 恢复 ---------------- */

  _restore() {
    const raw = readJSON(this.file, null);
    const list = raw && Array.isArray(raw.jobs) ? raw.jobs : [];
    this.seq = Number.isFinite(raw && raw.seq) ? raw.seq : 0;
    for (const j of list) {
      if (!j || !j.id) continue;
      const job = { ...j };
      // 进程重启后，排队/运行中的任务都已经不存在了 → 如实标记为已中断
      if (job.status === STATUS.queued || job.status === STATUS.running) {
        job.status = STATUS.interrupted;
        job.error = '软件已重启，任务中断（已下载的章节会保留，点「继续」可接着下）';
        job.finishedAt = job.finishedAt || Date.now();
      }
      // 暂停是用户主动停的：重启后原样保留，界面仍然给「继续」
      job.pauseRequested = false;
      job.cancelRequested = false;
      this.jobs.push(job);
      this.seq = Math.max(this.seq, Number(job.seq) || 0);
    }
    this.jobs.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  }

  _persist() {
    // 只留「最近 KEEP_FINISHED 条已结束的」，运行/排队的全留
    const active = this.jobs.filter((j) => j.status === STATUS.queued || j.status === STATUS.running);
    const done = this.jobs
      .filter((j) => j.status !== STATUS.queued && j.status !== STATUS.running)
      .slice(-KEEP_FINISHED);
    const keep = new Set([...active, ...done].map((j) => j.id));
    this.jobs = this.jobs.filter((j) => keep.has(j.id));
    try {
      writeJSON(this.file, { seq: this.seq, jobs: this.jobs });
    } catch (e) {
      /* 落盘失败不影响下载本身 */
    }
  }

  /* ---------------- 查询 ---------------- */

  /** 全部任务快照（新任务在前，界面直接渲染） */
  list() {
    return this.jobs
      .slice()
      .sort((a, b) => (b.seq || 0) - (a.seq || 0))
      .map((j) => this._snapshot(j));
  }

  /** 概览：有多少在排队 / 在跑 / 最近失败，供标签角标用 */
  summary() {
    const s = { queued: 0, running: 0, done: 0, error: 0, canceled: 0, interrupted: 0, paused: 0, active: 0 };
    for (const j of this.jobs) {
      if (s[j.status] != null) s[j.status]++;
      if (j.status === STATUS.queued || j.status === STATUS.running) s.active++;
    }
    return s;
  }

  get(jobId) {
    const j = this.jobs.find((x) => x.id === jobId);
    return j ? this._snapshot(j) : null;
  }

  /** 某本书当前是否有任务在排队/运行 */
  activeJobOf(bookId) {
    const j = this.jobs.find(
      (x) => x.bookId === bookId && (x.status === STATUS.queued || x.status === STATUS.running)
    );
    return j ? this._snapshot(j) : null;
  }

  /* ---------------- 变更 ---------------- */

  /**
   * 入队一个下载任务。
   * @param {object} opts
   * @param {string} opts.bookId
   * @param {number} [opts.from] 0 基章序号，默认 0
   * @param {number} [opts.to]   0 基章序号，默认末章
   * @param {boolean} [opts.force] 强制重下已存在章节（此时无法用文件数算进度，按状态计）
   * @returns {object} 任务快照
   */
  enqueue(opts = {}) {
    const bookId = opts.bookId;
    if (!bookId) throw new Error('缺少 bookId');
    const book = this.lib.get(bookId);
    if (!book) throw new Error(`书架里没有这本书：${bookId}`);
    const toc = this.lib.toc(bookId);
    if (!toc.length) throw new Error(`本地没有目录：${bookId}`);

    // 同一本书已经在排队/下载 → 直接返回那条任务，不重复入队
    const running = this.activeJobOf(bookId);
    if (running) return running;

    const from = Math.max(0, Math.min(toc.length - 1, Number.isFinite(opts.from) ? opts.from : 0));
    const to = Math.max(from, Math.min(toc.length - 1, Number.isFinite(opts.to) ? opts.to : toc.length - 1));
    const force = !!opts.force;

    this.seq += 1;
    const job = {
      id: 'dl' + this.seq + '_' + Date.now().toString(36),
      seq: this.seq,
      bookId,
      bookName: book.name || bookId,
      sourceName: book.sourceName || '',
      from,
      to,
      force,
      // 区间总章数；进度分母按未下载的章数在启动时再校正（见 _run）
      total: to - from + 1,
      done: 0,
      skipped: 0,
      failed: 0,
      processed: 0,
      percent: 0,
      status: STATUS.queued,
      error: '',
      failedIndexes: [],
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
    };
    this.jobs.push(job);
    this._persist();
    this._emit(job);
    // 不 await：入队立刻返回，界面拿到 jobId 就能开始轮询
    setImmediate(() => this._pump());
    return this._snapshot(job);
  }

  /** 取消：排队中的直接撤下；运行中的打标记，本章跑完即收手 */
  cancel(jobId) {
    const j = this.jobs.find((x) => x.id === jobId);
    if (!j) throw new Error('没有这个下载任务：' + jobId);
    if (j.status === STATUS.queued) {
      j.status = STATUS.canceled;
      j.error = '已取消';
      j.finishedAt = Date.now();
      this._persist();
      this._emit(j);
      setImmediate(() => this._pump());
    } else if (j.status === STATUS.running) {
      j.cancelRequested = true;
      j.pauseRequested = false;
      this._emit(j);
    }
    return this._snapshot(j);
  }

  /**
   * 中途停下但**保留任务**：排队中的直接撤下；运行中的打停止标记。
   *
   * 与 `cancel()` 的区别只在收尾状态：cancel 收尾成 `canceled`（终态，界面显示「取消」），
   * 这里收尾成 `paused`（停住了但还能「继续」，进度/区间/失败章都留着）。
   *
   * 停止粒度是「章」：正在飞的那几章会让它跑完再收手，已下载的正文照常落盘，
   * 所以「继续」时天然断点续传，不会从头再来。
   */
  pause(jobId) {
    const j = this.jobs.find((x) => x.id === jobId);
    if (!j) throw new Error('没有这个下载任务：' + jobId);
    if (j.status === STATUS.running) {
      // running → 打标记，由 _run 在 downloader 返回后收尾成 paused
      j.pauseRequested = true;
      j.updatedAt = Date.now();
      this._persist();
      this._emit(j);
      return this._snapshot(j);
    }
    if (j.status === STATUS.queued) {
      // 还没开跑：直接停在这里（保留已下进度，之后可以继续）
      j.status = STATUS.paused;
      j.error = '已暂停（继续会接着下）';
      j.finishedAt = Date.now();
      j.updatedAt = Date.now();
      this._persist();
      this._emit(j);
      setImmediate(() => this._pump());
      return this._snapshot(j);
    }
    // 终态任务：先「重下」再重开一条？不：这里保持原样返回，交给界面判断
    return this._snapshot(j);
  }

  /**
   * 继续一条停下的任务（paused / canceled / interrupted / error 都可以）。
   *
   * 实现要点：在**原任务上**把状态推回 queued，而不是新开一条——这样进度、
   * 区间、失败章都留在一条记录里，界面也不会出现「一本两行」。
   * 已下载的章由 downloader 跳过，所以「继续」永远是断点续传。
   */
  resume(jobId) {
    const j = this.jobs.find((x) => x.id === jobId);
    if (!j) throw new Error('没有这个下载任务：' + jobId);
    if (j.status === STATUS.running || j.status === STATUS.queued) return this._snapshot(j);

    // 同一本书已经有别的任务在跑 → 不并发，直接返回那条
    const other = this.jobs.find(
      (x) => x !== j && x.bookId === j.bookId && (x.status === STATUS.queued || x.status === STATUS.running)
    );
    if (other) return this._snapshot(other);

    j.status = STATUS.queued;
    j.error = '';
    j.pauseRequested = false;
    j.cancelRequested = false;
    j.finishedAt = 0;
    j.startedAt = 0;
    j.updatedAt = Date.now();
    this._persist();
    this._emit(j);
    setImmediate(() => this._pump());
    return this._snapshot(j);
  }

  /** 一条任务能不能「继续」（界面按钮的 disabled 依据） */
  canResume(job) {
    if (!job) return false;
    return ![STATUS.queued, STATUS.running].includes(job.status);
  }
  /** 清空已结束的记录（不动排队/运行中的） */
  clearFinished() {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.status === STATUS.queued || j.status === STATUS.running);
    const removed = before - this.jobs.length;
    this._persist();
    this._emit(null);
    return { removed };
  }

  /* ---------------- 执行 ---------------- */

  _emit(job) {
    if (!this.onChange) return;
    try {
      this.onChange({
        type: 'job',
        job: job ? this._snapshot(job) : null,
        summary: this.summary(),
      });
    } catch (_) {
      /* 推送失败不影响下载 */
    }
  }

  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const next = this.jobs.find((j) => j.status === STATUS.queued);
        if (!next) break;
        await this._run(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** 区间内「已经存在的章文件数」——进度采样的唯一依据 */
  _haveCount(job) {
    try {
      const all = this.lib.downloadedIndexes(job.bookId);
      let n = 0;
      for (const i of all) if (i >= job.from && i <= job.to) n++;
      return n;
    } catch (_) {
      return 0;
    }
  }

  async _run(job) {
    const book = this.lib.get(job.bookId);
    if (!book) {
      job.status = STATUS.error;
      job.error = '这本书已从书架移除';
      job.finishedAt = Date.now();
      this._persist();
      this._emit(job);
      return;
    }
    const src = this._sourceOf(book);
    if (!src) {
      job.status = STATUS.error;
      job.error = `书源已不存在：${book.sourceKey}（可能已被删除，请重新添加）`;
      job.finishedAt = Date.now();
      this._persist();
      this._emit(job);
      return;
    }

    job.status = STATUS.running;
    job.startedAt = Date.now();
    job.error = '';
    job.bookName = book.name || job.bookName;
    job.sourceName = book.sourceName || job.sourceName;
    this._emit(job);

    // 未强制时，区间里已存在的章会被 downloader 跳过：进度分母按「真正要下的」算，
    // 否则断点续传的进度条会永远停在中间（分母含已跳过的章）。
    const haveBefore = this._haveCount(job);
    const pending = Math.max(1, job.total - (job.force ? 0 : haveBefore));

    let tick = 0;
    const timer = setInterval(() => {
      if (job.status !== STATUS.running) return;
      tick++;
      if (job.force) {
        // 强制重下时文件一直存在，数不出增量——用运行时长做一个「不知道进度」的暗示，
        // percent 保持 0（界面显示「下载中」而不是假百分比）。
        job.percent = 0;
        this._emit(job);
        return;
      }
      const now = this._haveCount(job);
      const finished = Math.max(0, now - haveBefore);
      job.done = finished;
      job.processed = job.done + job.skipped + job.failed;
      job.percent = Math.max(0, Math.min(99, Math.round((finished / pending) * 100)));
      this._emit(job);
    }, POLL_MS);

    try {
      const r = await this.downloader.downloadChapters(src, job.bookId, {
        from: job.from,
        to: job.to,
        force: job.force,
        // 本书任务取消/暂停 → 不再发起新的章节请求
        shouldStop: () => !!job.cancelRequested || !!job.pauseRequested,
        onProgress: (ev) => {
          if (job.cancelRequested) return;
          job.processed = (job.processed || 0) + 1;
        },
      });
      clearInterval(timer);
      job.done = r.done;
      job.skipped = r.skipped;
      job.failed = r.failed;
      job.failedIndexes = r.failedIndexes || [];
      job.processed = r.done + r.skipped + r.failed;
      job.total = r.total || job.total;
      if (job.cancelRequested) {
        job.status = STATUS.canceled;
        job.error = '已取消（已下载的章节保留）';
      } else if (job.pauseRequested) {
        job.status = STATUS.paused;
        job.error = '';
      } else {
        job.status = STATUS.done;
      }
      job.percent = job.status === STATUS.done ? 100 : Math.min(99, job.percent);
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
    } catch (e) {
      clearInterval(timer);
      job.status = job.cancelRequested ? STATUS.canceled : job.pauseRequested ? STATUS.paused : STATUS.error;
      job.error = e && e.message ? e.message : String(e);
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
    } finally {
      try {
        this.lib.syncDownloadedCount(job.bookId);
      } catch (_) {
        /* ignore */
      }
      this._persist();
      this._emit(job);
    }
  }

  /** 按书架条目找到书源（与 App.download 同口径） */
  _sourceOf(book) {
    const store = this.downloader.sources;
    if (!store || !book || !book.sourceKey) return null;
    try {
      return store.get(book.sourceKey) || null;
    } catch (_) {
      return null;
    }
  }

  /** 快照：只把界面要用的字段送出去，避免把 cancelRequested 之类的内部标记泄漏成契约 */
  _snapshot(job) {
    return {
      id: job.id,
      seq: job.seq,
      bookId: job.bookId,
      bookName: job.bookName,
      sourceName: job.sourceName,
      from: job.from,
      to: job.to,
      total: job.total,
      done: job.done,
      skipped: job.skipped,
      failed: job.failed,
      processed: job.processed,
      percent: job.percent,
      force: !!job.force,
      status: job.status,
      error: job.error || '',
      failedIndexes: (job.failedIndexes || []).slice(0, 50),
      canceling: !!job.cancelRequested && job.status === STATUS.running,
      pausing: !!job.pauseRequested && job.status === STATUS.running,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }
}

module.exports = { DownloadQueue, STATUS, POLL_MS, KEEP_FINISHED };