'use strict';
/**
 * 轻量 CookieJar：按域名维护 cookie，支持 Legado 的 enabledCookieJar 语义。
 * 不做 Public Suffix 域匹配的完整实现，只做「同域或父域」匹配，够用且可预测。
 */

function domainMatch(cookieDomain, host) {
  if (!cookieDomain) return true;
  let d = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  const h = String(host || '').toLowerCase();
  return h === d || h.endsWith('.' + d);
}

/**
 * 容错解析 URL。
 * Legado 的 `cookie.removeCookie(source.key)` 这类写法在 key 为空时传进来的是 `undefined`，
 * 若直接 `new URL(undefined)` 会抛错并让整条 `@js:` 规则失败（实测 7941「最终小说网」搜索前的
 * `<js>cookie.removeCookie(source.key);</js>` 正是这种情况）。这里统一降级为 null，调用方视为 no-op。
 */
function safeUrl(url) {
  if (url == null) return null;
  const s = String(url).trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.hostname ? u : null;
  } catch (_) {
    return null;
  }
}

function defaultPath(pathname) {
  if (!pathname || !pathname.startsWith('/')) return '/';
  const i = pathname.lastIndexOf('/');
  if (i <= 0) return '/';
  return pathname.slice(0, i);
}

class CookieJar {
  constructor() {
    /** @type {Map<string, Map<string,{value:string,domain:string,path:string,expires:number,secure:boolean,httpOnly:boolean}>>} */
    this.byDomain = new Map();
  }

  _key(name, domain, path) { return name + '\u0000' + domain + '\u0000' + path; }

  /** 从 Set-Cookie 字符串列表写入 */
  setFromResponse(url, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const u = safeUrl(url);
    if (!u) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const raw of list) {
      // Set-Cookie 可能被 HTTP 层用 ", " 合并，这里按 "expires=" 之外的分隔粗切
      for (const line of splitSetCookie(raw)) this._setOne(u, line);
    }
  }

  _setOne(u, line) {
    const parts = line.split(';');
    const [nameValue, ...attrs] = parts;
    const eq = nameValue.indexOf('=');
    if (eq < 0) return;
    const name = nameValue.slice(0, eq).trim();
    const value = nameValue.slice(eq + 1).trim();
    if (!name) return;

    let domain = u.hostname;
    let path = defaultPath(u.pathname);
    let expires = 0;
    let secure = false;
    let httpOnly = false;

    for (const a of attrs) {
      const i = a.indexOf('=');
      const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? '' : a.slice(i + 1).trim();
      if (k === 'domain' && v) domain = v.replace(/^\./, '');
      else if (k === 'path' && v) path = v;
      else if (k === 'max-age' && v) expires = Date.now() + parseInt(v, 10) * 1000;
      else if (k === 'expires' && v) { const t = Date.parse(v); if (!Number.isNaN(t)) expires = t; }
      else if (k === 'secure') secure = true;
      else if (k === 'httponly') httpOnly = true;
    }

    if (!this.byDomain.has(u.hostname)) this.byDomain.set(u.hostname, new Map());
    const store = this.byDomain.get(u.hostname);
    const key = this._key(name, domain, path);
    if (expires && expires <= Date.now()) {
      store.delete(key);
      return;
    }
    store.set(key, { name, value, domain, path, expires, secure, httpOnly });
  }

  /** 取某 URL 适用的 cookie 串（"a=1; b=2"） */
  getCookieHeader(url) {
    const u = safeUrl(url);
    if (!u) return '';
    const pairs = [];
    const now = Date.now();
    const expired = [];
    // 注意：不能按「存它的 host」过滤 —— 带 Domain 属性的 cookie 存储在响应 host 下，
    // 却要能被该 domain 的任意子域读到。判定完全交给 cookie.domain。
    for (const store of this.byDomain.values()) {
      for (const [k, c] of store) {
        if (c.expires && c.expires <= now) { expired.push([store, k]); continue; }
        if (!domainMatch(c.domain, u.hostname)) continue;
        if (!u.pathname.startsWith(c.path)) continue;
        if (c.secure && u.protocol !== 'https:') continue;
        pairs.push(c);
      }
    }
    for (const [store, k] of expired) store.delete(k);
    return pairs.map((c) => c.name + '=' + c.value).join('; ');
  }

  /** Legado java.getCookie(url) 的返回形式 */
  getCookieString(url) { return this.getCookieHeader(url); }

  /** 反查某 cookie 的值 */
  get(name, url) {
    const header = this.getCookieHeader(url);
    for (const p of header.split('; ')) {
      const i = p.indexOf('=');
      if (i > 0 && p.slice(0, i) === name) return p.slice(i + 1);
    }
    return '';
  }

  remove(name, url) {
    const host = url ? (safeUrl(url) || {}).hostname : null;
    for (const store of this.byDomain.values()) {
      for (const [k, c] of store) {
        if (host && !domainMatch(c.domain, host)) continue;
        if (c.name === name) store.delete(k);
      }
    }
  }

  removeCookie(url) {
    if (!url) { this.byDomain.clear(); return; }
    const u = safeUrl(url);
    if (!u) return;
    const host = u.hostname;
    for (const [storeHost, store] of this.byDomain) {
      for (const [k, c] of store) {
        // 既清掉「属于该域的 cookie」，也清掉「恰好存在该 host 下的 cookie」
        if (domainMatch(c.domain, host) || domainMatch(storeHost, host)) store.delete(k);
      }
      if (store.size === 0) this.byDomain.delete(storeHost);
    }
  }

  /** 直接注入 cookie 串（用于书源 header 或登录态） */
  setCookieString(url, cookieString) {
    if (!cookieString) return;
    const u = safeUrl(url);
    if (!u) return;
    if (!this.byDomain.has(u.hostname)) this.byDomain.set(u.hostname, new Map());
    const store = this.byDomain.get(u.hostname);
    for (const part of String(cookieString).split(';')) {
      const p = part.trim();
      if (!p) continue;
      const i = p.indexOf('=');
      if (i < 0) continue;
      const name = p.slice(0, i).trim();
      const value = p.slice(i + 1).trim();
      store.set(this._key(name, u.hostname, '/'), { name, value, domain: u.hostname, path: '/', expires: 0, secure: false, httpOnly: false });
    }
  }

  toJSON() {
    const out = [];
    for (const [host, store] of this.byDomain) {
      for (const c of store.values()) out.push({ host, ...c });
    }
    return out;
  }

  loadJSON(arr) {
    if (!Array.isArray(arr)) return;
    this.byDomain.clear();
    for (const c of arr) {
      const host = c.host || c.domain;
      if (!host) continue;
      if (!this.byDomain.has(host)) this.byDomain.set(host, new Map());
      this.byDomain.get(host).set(this._key(c.name, c.domain || host, c.path || '/'), {
        name: c.name, value: c.value, domain: c.domain || host, path: c.path || '/',
        expires: c.expires || 0, secure: !!c.secure, httpOnly: !!c.httpOnly,
      });
    }
  }

  clone() {
    const j = new CookieJar();
    j.loadJSON(this.toJSON());
    return j;
  }
}

/** Set-Cookie 头可能被合并成一个字符串，尽量拆开 */
function splitSetCookie(raw) {
  const s = String(raw);
  // 用 ", xxx=" 作为分隔（cookie 名不含逗号）
  const out = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ',') {
      const rest = s.slice(i + 1, i + 80);
      if (/^\s*[A-Za-z0-9_.\-]+=/.test(rest) && !/^\s*expires=/i.test(rest)) {
        out.push(cur); cur = ''; continue;
      }
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

module.exports = { CookieJar, domainMatch, splitSetCookie };
