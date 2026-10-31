'use strict';
/**
 * 书源库：本地书源的增删改查 + 导入导出 + 可读性探测准入。
 *
 * 存储用 JSON 落盘（免依赖、可人工检视）：
 * ```
 * <dataDir>/sources/sources.json     全部书源（数组）
 * <dataDir>/sources/probe.json       每个书源的探测结果（按 bookSourceUrl 索引）
 * <dataDir>/sources/rss.json         全部订阅源（数组，Legado 订阅源格式 source*）
 * ```
 */

const fs = require('fs');
const path = require('path');
const { probe, canAdd, cleanSourceUrl } = require('./probe');

/** 书源唯一键：优先 URL，其次名称 */
function keyOf(s) {
  const u = String((s && s.bookSourceUrl) || '').trim().replace(/\/+$/, '');
  if (u) return u.toLowerCase();
  return 'name:' + String((s && s.bookSourceName) || '').trim().toLowerCase();
}

/**
 * 把用户传入的 key 归一成与 keyOf 相同的形式。
 * 查表方与建键方必须用同一套归一化，否则 `source list` 打印出的 URL
 * （末尾带 `/`）无法回喂给 `--source`。
 */
function normKey(key) {
  const k = String(key == null ? '' : key).trim().replace(/\/+$/, '');
  return k.toLowerCase();
}

const REQUIRED = ['bookSourceName', 'bookSourceUrl'];

/** 基本结构校验（不做网络探测） */
function validateShape(s) {
  const errs = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return ['书源必须是一个 JSON 对象'];
  }
  for (const k of REQUIRED) {
    if (!s[k] || !String(s[k]).trim()) errs.push(`缺少必填字段 ${k}`);
  }
  if (s.bookSourceUrl && !/^https?:\/\//i.test(String(s.bookSourceUrl))) {
    errs.push(`bookSourceUrl 必须是 http/https 地址：${s.bookSourceUrl}`);
  }
  if (!s.searchUrl && !(Array.isArray(s.ruleExplore) && s.ruleExplore.length)) {
    errs.push('书源既没有 searchUrl 也没有 ruleExplore，无法取书');
  }
  if (!s.ruleToc || !s.ruleToc.chapterList) {
    errs.push('缺少 ruleToc.chapterList，无法解析目录');
  }
  if (!s.ruleContent || !s.ruleContent.content) {
    errs.push('缺少 ruleContent.content，无法解析正文');
  }
  return errs;
}

class SourceStore {
  /**
   * @param {string} dataDir 数据根目录
   */
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'sources');
    this.file = path.join(this.dir, 'sources.json');
    this.probeFile = path.join(this.dir, 'probe.json');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 读取全部书源 */
  all() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  _write(list) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** 已保存的探测结果 */
  probeResults() {
    try {
      return JSON.parse(fs.readFileSync(this.probeFile, 'utf8')) || {};
    } catch (_) {
      return {};
    }
  }

  saveProbeResult(key, result) {
    const m = this.probeResults();
    m[key] = {
      ok: result.ok,
      score: result.score,
      elapsed: result.elapsed,
      stages: Object.fromEntries(
        Object.entries(result.stages || {}).map(([k, v]) => [
          k,
          { ok: v.ok, count: v.count, chars: v.chars, error: v.error || '', message: v.message || '' },
        ])
      ),
      errors: result.errors,
      warnings: result.warnings,
      diagnostics: result.details && result.details.diagnostics,
      at: Date.now(),
    };
    // 目录可能在运行中被清掉（冒烟测试会 rmSync 整个数据目录），写前补一次并原子落盘，
    // 避免 ENOENT / 半截 JSON 让一次探测结果把整条调用链炸掉。
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.probeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
    fs.renameSync(tmp, this.probeFile);
    return m[key];
  }

  get(key) {
    const k = normKey(key);
    return this.all().find((s) => keyOf(s) === k || String(s.bookSourceName || '').toLowerCase() === k) || null;
  }

  /**
   * 添加书源。
   * @param {object} source
   * @param {object} [opts] { dataDir, probe: true, keyword, logger, force }
   * @returns {Promise<{added:boolean, reason:string, probe?:object, errors?:string[]}>}
   */
  async add(source, opts = {}) {
    if (opts.dataDir) this.dir = path.join(opts.dataDir, 'sources');
    // bookSourceUrl 清洗：在线源里常见「https://xxx.com（作者备注）」这类带尾巴的写法，
    // 直接落盘会让后续所有请求 DNS 失败。提取开头那段合法地址再校验/探测/入库。
    if (source && typeof source === 'object' && source.bookSourceUrl) {
      const cleaned = cleanSourceUrl(source.bookSourceUrl);
      if (cleaned && cleaned !== source.bookSourceUrl && /^https?:\/\//i.test(cleaned)) {
        source = { ...source, bookSourceUrl: cleaned };
      }
    }
    const shapeErrs = validateShape(source);
    if (shapeErrs.length) {
      return { added: false, reason: '书源结构校验失败', errors: shapeErrs };
    }
    const key = keyOf(source);
    const existing = this.get(key);
    if (existing && !opts.force) {
      return { added: false, reason: `书源已存在：${existing.bookSourceName}` };
    }

    // 可读性探测——「不能读取的网站不能添加」
    let pr = null;
    if (opts.probe !== false) {
      pr = await probe(source, {
        keyword: opts.keyword,
        checkContent: opts.checkContent !== false,
        logger: opts.logger,
      });
      this.saveProbeResult(key, pr);
      const gate = canAdd(pr);
      if (!gate.allowed) {
        return {
          added: false,
          reason: `可读性探测未通过（${gate.reason}）→ 不允许添加`,
          probe: pr,
          errors: pr.errors,
        };
      }
    }

    const list = this.all();
    const idx = list.findIndex((s) => keyOf(s) === key);
    if (idx >= 0) list[idx] = source;
    else list.push(source);
    this._write(list);
    return { added: true, reason: idx >= 0 ? '已更新' : '已添加', probe: pr };
  }

  /** 删除书源 */
  remove(key) {
    const k = normKey(key);
    const kRaw = String(key == null ? '' : key).trim().toLowerCase();
    const list = this.all();
    const next = list.filter(
      (s) => keyOf(s) !== k && String(s.bookSourceName || '').trim().toLowerCase() !== kRaw
    );
    if (next.length === list.length) return false;
    this._write(next);
    return true;
  }

  /** 导入 JSON（单个对象或数组，或 Legado 的导出格式） */
  static parseImport(text) {
    let data;
    // 文件可能带 UTF-8 BOM（Windows 记事本、PowerShell Set-Content、部分 Legado 导出），
    // JSON.parse 不认 BOM，必须先剥掉。
    const cleaned = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
    if (!cleaned) throw new Error('文件是空的');
    try {
      data = JSON.parse(cleaned);
    } catch (e) {
      throw new Error('不是合法 JSON：' + e.message);
    }
    if (!data || typeof data !== 'object') {
      throw new Error('不是合法书源：顶层必须是对象或数组');
    }
    const arr = Array.isArray(data) ? data : [data];
    return arr.filter((s) => s && typeof s === 'object' && (s.bookSourceName || s.bookSourceUrl));
  }

  /** 导出为 JSON 文本 */
  static export(list, pretty = true) {
    return JSON.stringify(list, null, pretty ? 2 : 0);
  }

  /** 统计信息 */
  stats() {
    const list = this.all();
    const pr = this.probeResults();
    let probed = 0;
    let passed = 0;
    for (const s of list) {
      const r = pr[keyOf(s)];
      if (r) {
        probed++;
        if (r.ok && canAdd({ stages: r.stages }).allowed) passed++;
      }
    }
    return { total: list.length, probed, passed };
  }
}

/** 订阅源唯一键：sourceUrl 优先，其次 sourceName */
function rssKeyOf(s) {
  const u = String((s && s.sourceUrl) || '').trim().replace(/\/+$/, '');
  if (u) return u.toLowerCase();
  return 'name:' + String((s && s.sourceName) || '').trim().toLowerCase();
}

/**
 * Legado 订阅源（RSS）基本结构校验。
 * 订阅源没有 searchUrl/ruleToc 概念，核心字段只有 sourceName/sourceUrl，
 * 允许 singleUrl 或订阅正文两用（规则字段缺省合法）。
 */
function validateRssShape(s) {
  const errs = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return ['订阅源必须是一个 JSON 对象'];
  }
  if (!s.sourceName || !String(s.sourceName).trim()) errs.push('缺少必填字段 sourceName');
  if (!s.sourceUrl || !String(s.sourceUrl).trim()) errs.push('缺少必填字段 sourceUrl');
  if (s.sourceUrl && !/^(https?|data):/i.test(String(s.sourceUrl))) {
    errs.push(`sourceUrl 必须是 http/https/data 地址：${s.sourceUrl}`);
  }
  return errs;
}

/**
 * 订阅源库（Legado RSS）。
 * 与书源分开存（rss.json）：字段结构不同、数量大、且不做五阶段可读性探测
 * （订阅源是信息流/网页集合，没有「搜索→目录→正文」链路可言）。
 */
class RssStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'sources');
    this.file = path.join(this.dir, 'rss.json');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  all() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  _write(list) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get(key) {
    const k = String(key == null ? '' : key).trim().toLowerCase().replace(/\/+$/, '');
    return (
      this.all().find((s) => rssKeyOf(s) === k || String(s.sourceName || '').toLowerCase() === k) ||
      null
    );
  }

  /**
   * 添加/更新订阅源（跳过重复，除非 force）。
   * @returns {{added:number, updated:number, skipped:number, items:Array}}
   */
  addMany(list, opts = {}) {
    const all = this.all();
    const index = new Map(all.map((s, i) => [rssKeyOf(s), i]));
    const out = { added: 0, updated: 0, skipped: 0, items: [] };
    for (const s of list) {
      const errs = validateRssShape(s);
      if (errs.length) {
        out.skipped++;
        out.items.push({ name: (s && s.sourceName) || '(未命名)', ok: false, reason: errs[0] });
        continue;
      }
      const key = rssKeyOf(s);
      if (index.has(key) && !opts.force) {
        out.skipped++;
        out.items.push({ name: s.sourceName, ok: false, reason: '已存在' });
        continue;
      }
      if (index.has(key)) {
        all[index.get(key)] = s;
        out.updated++;
        out.items.push({ name: s.sourceName, ok: true, reason: '已更新' });
      } else {
        index.set(key, all.length);
        all.push(s);
        out.added++;
        out.items.push({ name: s.sourceName, ok: true, reason: '已添加' });
      }
    }
    if (out.added || out.updated) this._write(all);
    return out;
  }

  remove(key) {
    const k = String(key == null ? '' : key).trim().toLowerCase();
    const list = this.all();
    const next = list.filter((s) => rssKeyOf(s) !== k);
    if (next.length === list.length) return false;
    this._write(next);
    return true;
  }

  /** 导入 JSON 文本（对象/数组，识别 source* 字段） */
  static parseImport(text) {
    const cleaned = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
    if (!cleaned) throw new Error('文件是空的');
    let data;
    try {
      data = JSON.parse(cleaned);
    } catch (e) {
      throw new Error('不是合法 JSON：' + e.message);
    }
    const arr = Array.isArray(data) ? data : [data];
    return arr.filter((s) => s && typeof s === 'object' && (s.sourceName || s.sourceUrl));
  }
}

module.exports = { SourceStore, validateShape, keyOf, REQUIRED, RssStore, validateRssShape, rssKeyOf };
