'use strict';
/**
 * Legado `@js:` 运行时。
 *
 * ## 为什么不用 Worker + SharedArrayBuffer 阻塞桥
 * Legado 的 Rhino 环境里 `java.ajax(url)` 是同步的。Node 里做同步 HTTP 只能靠
 * Worker + Atomics.wait 阻塞，实测（见 _recon/test_atomics*.js）问题很多：
 *   - 主线程一阻塞，worker 的定时器/IO 被拖慢，第二个请求直接 40s timeout
 *   - 一次只能发一个请求，无法并发；而本机到中文小说站单次 0.2–2.3s，串行不可接受
 *
 * 改用 **推测式预取 + 重跑**：
 *   1. 同步执行 JS；`java.ajax(url)` 查缓存，命中直接返回。
 *   2. 未命中 → 记进 miss 表、返回 ''，JS 继续跑完。
 *   3. 驱动层把所有 miss 的 URL **并发**取回，填进缓存，然后**重跑**这段 JS。
 *   4. 重复到无 miss 或达到最大轮数。
 * 对确定性 JS 完全等价于同步语义，且天然并发。缓存按 (method,url,body,headers) 去重，
 * 重跑时已取到的请求不再发第二次。
 *
 * ## java.* API 兼容层
 * 覆盖实测到的 API：ajax/post/getCookie/base64 系列/encodeURI/md5Encode/
 * aesEncodeToBase64String/getVerificationCode 等。
 * 另提供 `Packages.*` 的 JVM 类型门面（crypto/security/util/io/lang），用 Node crypto 实现，
 * 使依赖 AES-GCM / MessageDigest / android Base64 的书源（如「纸间」）可运行。
 * 依赖 Android WebView 的 API（J.startBrowserAwait / J.webView）无法实现，
 * 调用时返回空串并记入 `unsupported`，供可读性探测报告。
 */

const vm = require('vm');
const crypto = require('crypto');

/* ================================================================== *
 * HTTP 预取层
 * ================================================================== */

/**
 * 生成请求的规范化缓存键。
 *
 * 只纳入**真正影响请求**的四项：方法、URL、请求体、字符集。
 *
 * 历史教训：这里原本还把整个 `headers` 的 JSON 串进键里。但同一批请求在两个地方
 * 会以不同的 options 形态出现：
 *  - `getSync`（书源规则里的 `java.ajax(url, JSON.stringify(opt))`）带的是规则原样写的全部字段；
 *  - `peekSync`（引擎内部查落点）只带 `{ method, body, headers, charset }`。
 * 于是「带 headers / 带 timeout、retry 之类额外字段的 ajax」在 getSync 登记的键，与引擎
 * peekSync 查的键**永远不相等**，落点查询恒为 null，引擎误判「还有 miss」再次重跑，
 * 每轮都重发同一个请求，直到 MAX_ROUNDS（实测哔咔漫画 21s × 64 轮）。
 *
 * headers 不进键的代价：同一 URL 用不同 Cookie/UA 请求会命中同一缓存条目。
 * 这在书源场景里是可接受的取舍——Cookie 已由 CookieJar 在 HTTP 层统一维护，
 * 规则里手写的 headers 绝大多数是 UA/Referer 常量；而键不含 headers 换来的确定性
 * 远比重发一轮请求重要。
 */
function reqKey(url, opts) {
  const o = opts || {};
  const method = (o.method || 'GET').toUpperCase();
  const body = o.body == null ? '' : String(o.body);
  const charset = o.charset || '';
  return [method, url, body, charset].join('\u0001');
}

class Prefetcher {
  constructor() {
    /** @type {Map<string, {status:number,text:string,url:string,error?:string}>} */
    this.cache = new Map();
    /** @type {Map<string, {url:string, options:object}>} */
    this.misses = new Map();
  }

  clearMisses() { this.misses.clear(); }
  hasMisses() { return this.misses.size > 0; }
  /** 取出本轮 miss 的请求（去重后） */
  takeMisses() {
    const list = [];
    for (const [k, v] of this.misses) list.push({ key: k, ...v });
    this.misses.clear();
    return list;
  }

  /** 同步获取（miss 时登记并返回空） */
  getSync(url, options) {
    const key = reqKey(url, options);
    const hit = this.cache.get(key);
    if (hit) {
      if (hit.error) return '';
      return hit.text;
    }
    if (!this.misses.has(key)) this.misses.set(key, { url, options: options || {} });
    return '';
  }

  /** 是否有未取到的请求（用于决定是否重跑） */
  peekSync(url, options) {
    const key = reqKey(url, options);
    return this.cache.get(key) || null;
  }
}

/* ================================================================== *
 * JVM 类型门面（Packages.*）
 * ================================================================== */

/**
 * 冻结「当前时间」的 Date 构造器，注入沙箱替代全局 Date。
 *
 * `new Date()` / `Date.now()` 恒返回 `frozenMs`，其余行为（含 `new Date(ms)`、
 * `Date.parse`、`Date.UTC`、原型方法）与原生 Date 一致。
 *
 * 动机见 `JsRuntime` 构造函数里 `nowMs` 的说明：我们用「预取 + 重跑」模拟
 * Legado 的同步 `java.ajax`，同一条规则会被跑多次。规则里若用墙上时钟做
 * 请求签名，时间漂移会让每次重跑产出**不同的请求体**，预取缓存永不命中。
 */
function makeFrozenDate(frozenMs) {
  const RealDate = Date;
  function FrozenDate(...args) {
    if (!new.target) return new RealDate(frozenMs).toString();
    if (args.length === 0) return new RealDate(frozenMs);
    return new RealDate(...args);
  }
  FrozenDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(FrozenDate, RealDate);
  FrozenDate.now = () => frozenMs;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  return FrozenDate;
}

/** 把各种输入统一成 Buffer */
function toBuffer(x) {
  if (x == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array || x instanceof Int8Array) return Buffer.from(x.buffer || x, x.byteOffset || 0, x.byteLength || x.length);
  if (Array.isArray(x)) {
    // Java 里常见 new byte[]{1,2,3}，JS 侧是普通数组
    return Buffer.from(x.map((v) => (Number(v) & 0xff)));
  }
  if (typeof x === 'string') return Buffer.from(x, 'utf8');
  if (x._bytes) return toBuffer(x._bytes);
  if (x._v != null) return toBuffer(x._v);
  return Buffer.from(String(x), 'utf8');
}

/** Java 的 String 门面 */
class JavaString {
  constructor(v) { this._v = v == null ? '' : String(v); }
  toString() { return this._v; }
  length() { return this._v.length; }
  charAt(i) { return this._v.charAt(i); }
  substring(a, b) { return new JavaString(b === undefined ? this._v.slice(a) : this._v.slice(a, b)); }
  indexOf(s) { return this._v.indexOf(s); }
  equals(o) { return this._v === (o instanceof JavaString ? o._v : String(o)); }
  getBytes(charset) {
    const cs = (charset && (charset._v || charset)) || 'utf-8';
    return javaCharsetBuffer(this._v, cs);
  }
  replace(a, b) { return new JavaString(this._v.split(a).join(b)); }
  toUpperCase() { return new JavaString(this._v.toUpperCase()); }
  toLowerCase() { return new JavaString(this._v.toLowerCase()); }
  trim() { return new JavaString(this._v.trim()); }
  split(sep) { return this._v.split(sep).map((s) => new JavaString(s)); }
  valueOf() { return this._v; }
  [Symbol.toPrimitive]() { return this._v; }
}

let iconvLite = null;
function iconv() {
  if (!iconvLite) { try { iconvLite = require('iconv-lite'); } catch (_) { iconvLite = false; } }
  return iconvLite;
}
function javaCharsetBuffer(str, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/_/g, '-');
  const lib = iconv();
  if (lib && cs !== 'utf-8' && lib.encodingExists(cs)) return lib.encode(str, cs);
  return Buffer.from(str, 'utf8');
}
function javaDecodeBuffer(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/_/g, '-');
  const b = toBuffer(buf);
  const lib = iconv();
  if (cs === 'utf-8') return b.toString('utf8');
  if (lib && lib.encodingExists(cs)) return lib.decode(b, cs);
  return b.toString('utf8');
}

class MessageDigest {
  constructor(algo) { this.algo = normalizeDigest(algo); this._chunks = []; }
  update(b) { this._chunks.push(toBuffer(b)); return this; }
  digest(b) {
    const h = crypto.createHash(this.algo);
    for (const c of this._chunks) h.update(c);
    if (b !== undefined) h.update(toBuffer(b));
    const d = h.digest();
    return new Uint8Array(d);
  }
  static getInstance(algo) { return new MessageDigest(algo); }
}
function normalizeDigest(a) {
  const s = String(a || 'MD5').toUpperCase().replace(/_/g, '-');
  if (s === 'MD5') return 'md5';
  if (s === 'SHA-1' || s === 'SHA1') return 'sha1';
  if (s === 'SHA-256' || s === 'SHA256') return 'sha256';
  if (s === 'SHA-512') return 'sha512';
  return s.toLowerCase();
}

class Base64Facade {
  static decode(str, flags) { return new Uint8Array(Buffer.from(String(str).trim(), 'base64')); }
  static encodeToString(bytes, flags) { return toBuffer(bytes).toString('base64'); }
  static encode(bytes, flags) { return Base64Facade.encodeToString(bytes); }
  static decodeToString(str) { return toBuffer(Base64Facade.decode(str)).toString('utf8'); }
  static NO_WRAP = 2;
  static DEFAULT = 0;
  static URL_SAFE = 8;
}

class SecretKeySpec {
  constructor(key, algo) { this.key = toBuffer(key); this.algo = algo == null ? '' : String(algo); }
}
class GCMParameterSpec {
  constructor(tLen, iv) { this.tLen = tLen; this.iv = toBuffer(iv); }
}
class IvParameterSpec { constructor(iv) { this.iv = toBuffer(iv); } }

const AES_BLOCK = 16;
/** 把 Java 的 'AES/GCM/NoPadding' 转成 Node 的算法名 */
function normalizeCipher(transform) {
  const t = String(transform || '').toUpperCase();
  if (t.includes('GCM')) return { algo: 'aes-gcm', mode: 'gcm', padding: 'none' };
  if (t.includes('CBC')) return { algo: t.includes('AES') ? 'aes-cbc' : 'des-cbc', mode: 'cbc', padding: t.includes('NoPadding') ? 'none' : 'pkcs7' };
  if (t.includes('ECB')) return { algo: t.includes('AES') ? 'aes-ecb' : 'des-ecb', mode: 'ecb', padding: t.includes('NoPadding') ? 'none' : 'pkcs7' };
  if (t.includes('CTR')) return { algo: 'aes-ctr', mode: 'ctr', padding: 'none' };
  return { algo: 'aes-cbc', mode: 'cbc', padding: 'pkcs7' };
}
function keyLenName(algo, key) {
  const bits = key.length * 8;
  const base = algo.split('-')[0];
  const map = { 128: base + '-128', 192: base + '-192', 256: base + '-256' };
  return map[bits] || (base + '-' + bits);
}
function pkcs7Pad(buf) {
  const n = AES_BLOCK - (buf.length % AES_BLOCK);
  return Buffer.concat([buf, Buffer.alloc(n, n)]);
}
function pkcs7Unpad(buf) {
  if (!buf.length) return buf;
  const n = buf[buf.length - 1];
  if (n < 1 || n > AES_BLOCK || n > buf.length) return buf;
  return buf.subarray(0, buf.length - n);
}

class Cipher {
  constructor(transform) {
    this.transform = transform;
    const n = normalizeCipher(transform);
    this._n = n;
    this._key = null;
    this._iv = null;
    this._gcmTagLen = 128;
    this._out = [];
    this._inited = null;
  }
  static getInstance(transform) { return new Cipher(transform); }
  init(mode, keyOrSpec, ivOrSpec, extra) {
    // init(ENCRYPT_MODE, keySpec, ivSpec)  |  init(ENCRYPT_MODE, keySpec)
    this._inited = mode;
    const k = keyOrSpec && keyOrSpec.key !== undefined ? keyOrSpec.key : keyOrSpec;
    this._key = toBuffer(k);
    if (ivOrSpec && ivOrSpec.iv !== undefined) {
      this._iv = toBuffer(ivOrSpec.iv);
      if (ivOrSpec.tLen) this._gcmTagLen = ivOrSpec.tLen;
    } else if (ivOrSpec != null) {
      this._iv = toBuffer(ivOrSpec);
    }
    return this;
  }
  update(input) {
    const o = this._run(toBuffer(input), false);
    if (o) this._out.push(o);
    return new Uint8Array(0);
  }
  doFinal(input) {
    const buf = input === undefined ? Buffer.alloc(0) : toBuffer(input);
    const o = this._run(buf, true);
    if (o) this._out.push(o);
    // GCM 解密时，Java 把 tag 拼在密文尾部，Node 需要分开
    const all = Buffer.concat(this._out);
    this._out = [];
    if (this._gcmSplit) {
      const tag = Buffer.from(all.subarray(all.length - 16));
      const ct = all.subarray(0, all.length - 16);
      this._gcmSplit = false;
      return new Uint8Array(this._gcmDoFinal(ct, tag));
    }
    return new Uint8Array(all);
  }
  _run(buf, isFinal) {
    if (!buf.length) return null;
    return this._exec(buf, isFinal);
  }
  _exec(buf, isFinal) {
    const n = this._n;
    const key = keyLenName(n.algo, this._key);
    const isEnc = this._inited === Cipher.ENCRYPT_MODE || this._inited === 1;
    const iv = this._iv || Buffer.alloc(0);
    try {
      if (n.mode === 'gcm') {
        if (isEnc) {
          const c = crypto.createCipheriv(key, this._key, iv, { authTagLength: this._gcmTagLen / 8 });
          const out = Buffer.concat([c.update(pkcsNothing(buf)), c.final(), c.getAuthTag()]);
          return out;
        }
        this._gcmSplit = true;
        return buf;
      }
      if (n.mode === 'ecb') {
        const c = isEnc ? crypto.createCipheriv(key, this._key, null) : crypto.createDecipheriv(key, this._key, null);
        c.setAutoPadding(false);
        const padded = isEnc ? (n.padding === 'pkcs7' ? pkcs7Pad(buf) : buf) : buf;
        const out = Buffer.concat([c.update(padded), c.final()]);
        return isEnc ? out : (n.padding === 'pkcs7' ? pkcs7Unpad(out) : out);
      }
      const c = isEnc ? crypto.createCipheriv(key, this._key, iv) : crypto.createDecipheriv(key, this._key, iv);
      c.setAutoPadding(false);
      const padded = isEnc ? (n.padding === 'pkcs7' ? pkcs7Pad(buf) : buf) : buf;
      const out = Buffer.concat([c.update(padded), c.final()]);
      return isEnc ? out : (n.padding === 'pkcs7' ? pkcs7Unpad(out) : out);
    } catch (e) {
      return Buffer.alloc(0);
    }
  }
  _gcmDoFinal(ct, tag) {
    const n = this._n;
    const key = keyLenName(n.algo, this._key);
    try {
      const d = crypto.createDecipheriv(key, this._key, this._iv || Buffer.alloc(0), { authTagLength: this._gcmTagLen / 8 });
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    } catch (e) {
      return Buffer.alloc(0);
    }
  }
  static ENCRYPT_MODE = 1;
  static DECRYPT_MODE = 2;
}
function pkcsNothing(b) { return b; }

class Mac {
  constructor(algo) { this._algo = String(algo || 'HmacSHA256').replace(/^Hmac/i, '').replace(/-/g, '').toLowerCase(); this._key = null; this._chunks = []; }
  static getInstance(algo) { return new Mac(algo); }
  init(spec) { this._key = toBuffer(spec && spec.key !== undefined ? spec.key : spec); return this; }
  update(b) { this._chunks.push(toBuffer(b)); return this; }
  doFinal(b) {
    const h = crypto.createHmac(this._algo === 'sha256' ? 'sha256' : this._algo, this._key || Buffer.alloc(0));
    for (const c of this._chunks) h.update(c);
    if (b !== undefined) h.update(toBuffer(b));
    return new Uint8Array(h.digest());
  }
}

class SecureRandom {
  nextBytes(arr) {
    const r = crypto.randomBytes(arr.length || 16);
    for (let i = 0; i < arr.length; i++) arr[i] = r[i];
    return arr;
  }
  static getInstance() { return new SecureRandom(); }
}

class ByteArrayOutputStream {
  constructor() { this._chunks = []; }
  write(b) { this._chunks.push(toBuffer(b)); }
  writeBytes(b) { this._chunks.push(toBuffer(b)); }
  toByteArray() { return new Uint8Array(Buffer.concat(this._chunks)); }
  toString(charset) { return javaDecodeBuffer(Buffer.concat(this._chunks), charset); }
  size() { return this._chunks.reduce((a, c) => a + c.length, 0); }
  reset() { this._chunks = []; }
}

class HashMap {
  constructor() { this._m = new Map(); }
  put(k, v) { this._m.set(k == null ? 'null' : String(k), v); return this; }
  get(k) { const r = this._m.get(k == null ? 'null' : String(k)); return r === undefined ? null : r; }
  containsKey(k) { return this._m.has(k == null ? 'null' : String(k)); }
  remove(k) { this._m.delete(k == null ? 'null' : String(k)); }
  keySet() { return [...this._m.keys()]; }
  size() { return this._m.size; }
}

class ArrayList {
  constructor(a) { this._a = a ? [...a] : []; }
  add(v) { this._a.push(v); return true; }
  get(i) { return this._a[i]; }
  size() { return this._a.length; }
  toArray() { return [...this._a]; }
  iterator() { const a = this._a; let i = 0; return { hasNext: () => i < a.length, next: () => a[i++] }; }
}

/** 构造 Packages 门面 */
function makePackages(rt) {
  const javaLang = {
    String: JavaString,
    Integer: { parseInt: (s, r) => parseInt(s, r || 10), valueOf: (s) => parseInt(s, 10), MAX_VALUE: 2147483647 },
    Double: { parseDouble: parseFloat, valueOf: parseFloat },
    Boolean: { valueOf: (v) => !!v, parseBoolean: (s) => String(s) === 'true' },
    Character: { toString: (c) => String(c) },
    StringBuilder: class { constructor(s) { this._s = s == null ? '' : String(s); } append(x) { this._s += x == null ? 'null' : String(x); return this; } toString() { return this._s; } },
    Thread: { sleep: () => {} },
    Object: class {},
    Exception: class extends Error {},
    RuntimeException: class extends Error {},
  };
  const javaUtil = {
    HashMap, ArrayList,
    Arrays: {
      copyOf: (a, n) => { const o = new Array(n); for (let i = 0; i < n; i++) o[i] = a[i] === undefined ? 0 : a[i]; return o; },
      toString: (a) => '[' + (a || []).join(', ') + ']',
    },
    Base64: { getDecoder: () => Base64Facade, getEncoder: () => Base64Facade },
    Map: { Entry: class {} },
  };
  return {
    java: {
      lang: javaLang,
      util: javaUtil,
      io: { ByteArrayOutputStream, ByteArrayInputStream: class { constructor(b) { this._b = toBuffer(b); this._p = 0; } read() { return this._p < this._b.length ? this._b[this._p++] : -1; } } },
      security: { MessageDigest, SecureRandom, MessageDigestAlgo: undefined },
      nio: { ByteBuffer: { allocate: (n) => { const b = Buffer.alloc(n); b.position = 0; b.put = function (v) { if (v && v.length !== undefined && typeof v !== 'number') { Buffer.from(v).copy(b, this.position); this.position += v.length; } else { b[this.position++] = v; } return b; }; b.array = () => b; b.flip = () => b; b.get = (i) => b[i]; b.remaining = () => b.length - b.position; return b; }, wrap: (x) => toBuffer(x) }, Charset: { forName: (n) => ({ name: () => String(n) }) } },
    },
    javax: {
      crypto: {
        Cipher, Mac,
        spec: { SecretKeySpec, GCMParameterSpec, IvParameterSpec },
      },
    },
    android: { util: { Base64: Base64Facade } },
    org: {},
    com: {},
  };
}

/* ================================================================== *
 * JS 运行时
 * ================================================================== */

/** 需要联网的 java.* 方法名 */
const NET_METHODS = new Set(['ajax', 'post', 'get', 'connect', 'getVerificationCode']);
/** 依赖 Android WebView / 浏览器、无法实现的方法（调用即记 unsupported） */
const UNSUPPORTED_METHODS = new Set([
  'startBrowserAwait', 'startBrowser', 'webView', 'getVerificationCode',
  'startAutoRefresh', 'refreshToc', 'openUrl', 'setCookieAsync',
]);

/**
 * 沙箱里由本运行时提供的**保留名**。规则变量（vars）不得覆盖它们。
 *
 * 事故背景：engine 的求值回调习惯性把 `source` / `cookie` 原样塞进 vars
 * （`{ ...vars, cookie: this.jar, source: this.source }`）。而沙箱字面量里
 * `...vars` 展开在适配层之后，于是**原始书源 JSON 覆盖了带 `getKey()`/`key`
 * 的 source 适配层**（`source.getKey is not a function`），原始 CookieJar 覆盖了
 * 带 `getCookie`/`setCookie` 的 cookie 适配层（CookieJar 只有 getCookieHeader 等）。
 * 表现为整条 searchUrl 的 `@js:` 崩掉 → 「searchUrl 解析结果不是合法 URL」
 * （7054/7383 笔趣全家桶、7808 格格党网）。
 */
const RESERVED_SANDBOX_KEYS = new Set([
  'java', 'source', 'cookie', 'C', 'J', 'Packages',
  'JSON', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'Date', 'RegExp',
  'Error', 'TypeError', 'parseInt', 'parseFloat', 'isNaN',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'Map', 'Set', 'Promise', 'Symbol', 'console',
]);

/** 过滤掉 vars 里的保留名，只留真正的规则变量（result/key/page/book/nextUrl/baseUrl…） */
function stripReservedVars(vars) {
  const out = {};
  for (const [k, v] of Object.entries(vars || {})) {
    if (!RESERVED_SANDBOX_KEYS.has(k)) out[k] = v;
  }
  return out;
}

class JsRuntime {
  /**
   * @param {object} [opts]
   * @param {Prefetcher} [opts.prefetcher]
   * @param {import('../net/cookiejar').CookieJar} [opts.jar]
   * @param {object} [opts.source] 书源对象
   * @param {Function} [opts.logger]
   */
  constructor(opts = {}) {
    this.prefetcher = opts.prefetcher || new Prefetcher();
    this.jar = opts.jar || null;
    this.source = opts.source || {};
    this.baseUrl = this.source.bookSourceUrl || '';
    this.logger = opts.logger || null;
    // key -> value，对应 Legado 的 C.putMemory/getFromMemory（一次求值会话内有效）
    this.memory = new Map();
    this.unsupported = new Set();
    this.errors = [];
    this._ctxCache = null;
    /**
     * 书源 jsLib 注入（对齐 Legado Rhino 全局函数语义）。
     *
     * Legado 把书源 `jsLib` 字段（单串或数组）注入 Rhino 全局作用域，规则里的
     * `<js>`/`@js:`/`{{}}` 块可直接调用其中定义的辅助函数（如 zzPost/Api/zj_search）。
     * 我们在 vm 沙箱里等效实现：jsLib 预编译成 IIFE 一次性执行，把其顶层
     * `function f(){}`/`var x=` 声明挂到沙箱 globalThis 上，后续每次求值可见。
     */
    this._jsLibCache = null;
    this._jsLibState = '';
    this._jsLibFn = null;
    /**
     * 会话内冻结的「当前时间」。
     *
     * 为什么需要：Legado 的 `java.ajax` 是同步的，一条规则只在**一次**执行里跑完；
     * 我们用「推测式预取 + 重跑」模拟它，同一条规则会被执行多次。若规则里读了
     * 墙上时钟（如 `Math.floor(new Date().getTime()/1000)` 生成请求签名 `_ts`），
     * 每次重跑都会算出**不同的请求体** ⇒ 预取缓存永远不命中 ⇒ 每轮都发新请求，
     * 且新请求会重用上一次已消费掉的一次性令牌，最终服务端 403。
     * 真实样本：7940 uu书库 `searchUrl`（`_t` 令牌 + `_ts` 时间戳 + `_s` 签名）。
     *
     * 冻结后，同一次 `_runWithPrefetch` 的所有轮次看到同一个「现在」，重跑就是确定性的，
     * 与 Legado 的单次执行语义等价。
     */
    this.nowMs = opts.nowMs != null ? Number(opts.nowMs) : Date.now();
  }

  /** java.ajax 的实现：查预取缓存 */
  _ajax(url, optionsJson) {
    let opts = {};
    if (optionsJson) {
      try { opts = typeof optionsJson === 'string' ? JSON.parse(optionsJson) : optionsJson; } catch (_) { opts = {}; }
    }
    return this.prefetcher.getSync(String(url), opts);
  }

  _buildSandbox(vars) {
    const self = this;
    const P = makePackages(this);

    const java = {
      /* ---- 网络 ---- */
      ajax: (url, optionsJson) => self._ajax(url, optionsJson),
      post: (url, body, optionsJson) => {
        let o = {};
        try { o = optionsJson ? (typeof optionsJson === 'string' ? JSON.parse(optionsJson) : optionsJson) : {}; } catch (_) { o = {}; }
        return self._ajax(url, { ...o, method: 'POST', body });
      },
      get: (url, optionsJson) => self._ajax(url, optionsJson),
      getVerificationCode: () => { self.unsupported.add('java.getVerificationCode'); return ''; },
      /* ---- Cookie ---- */
      getCookie: (url) => (self.jar ? self.jar.getCookieHeader(String(url)) : ''),
      setCookie: (url, c) => { if (self.jar) self.jar.setCookieString(String(url), String(c)); },
      /* ---- 编码 ---- */
      base64Decode: (s) => javaDecodeBuffer(Buffer.from(String(s), 'base64'), 'utf-8'),
      base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
      base64DecodeToByteArray: (s) => new Uint8Array(Buffer.from(String(s), 'base64')),
      encodeURI: (s) => encodeURI(String(s)),
      decodeURI: (s) => { try { return decodeURI(String(s)); } catch (_) { return String(s); } },
      encodeURIComponent: (s) => encodeURIComponent(String(s)),
      decodeURIComponent: (s) => { try { return decodeURIComponent(String(s)); } catch (_) { return String(s); } },
      hexDecodeToString: (h) => Buffer.from(String(h), 'hex').toString('utf8'),
      hexEncodeToString: (s) => Buffer.from(String(s), 'utf8').toString('hex'),
      utf8ToGbk: (s) => javaDecodeBuffer(javaCharsetBuffer(String(s), 'utf-8'), 'gbk'),
      gbkToUtf8: (s) => javaDecodeBuffer(javaCharsetBuffer(String(s), 'gbk'), 'utf-8'),
      /* ---- 摘要 ---- */
      md5Encode: (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex'),
      md5Encode16: (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex').slice(8, 24),
      sha1Encode: (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex'),
      sha256Encode: (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'),
      digestHex: (algo, s) => crypto.createHash(normalizeDigest(algo)).update(String(s), 'utf8').digest('hex'),
      /* ---- 对称加密 ---- */
      aesEncodeToBase64String: (data, key, transformation, iv) => {
        try {
          const n = normalizeCipher(transformation || 'AES/CBC/PKCS5Padding');
          const k = keyLenName(n.algo, Buffer.from(String(key), 'utf8'));
          const ivBuf = iv == null ? Buffer.alloc(0) : javaCharsetBuffer(String(iv), 'utf-8');
          const c = crypto.createCipheriv(k, Buffer.from(String(key), 'utf8'), ivBuf);
          return Buffer.concat([c.update(Buffer.from(String(data), 'utf8')), c.final()]).toString('base64');
        } catch (_) { return ''; }
      },
      aesDecodeToString: (b64, key, transformation, iv) => {
        try {
          const n = normalizeCipher(transformation || 'AES/CBC/PKCS5Padding');
          const k = keyLenName(n.algo, Buffer.from(String(key), 'utf8'));
          const ivBuf = iv == null ? Buffer.alloc(0) : javaCharsetBuffer(String(iv), 'utf-8');
          const d = crypto.createDecipheriv(k, Buffer.from(String(key), 'utf8'), ivBuf);
          return Buffer.concat([d.update(Buffer.from(String(b64), 'base64')), d.final()]).toString('utf8');
        } catch (_) { return ''; }
      },
      aesBase64DecodeToString: (b64, key, transformation, iv) => {
        return java.aesDecodeToString(b64, key, transformation, iv);
      },
      /* ---- 其它 ---- */
      log: (...a) => { if (self.logger) self.logger('[js] ' + a.map(String).join(' ')); },
      toast: (...a) => { if (self.logger) self.logger('[toast] ' + a.map(String).join(' ')); },
      longToast: (...a) => { if (self.logger) self.logger('[toast] ' + a.map(String).join(' ')); },
      timeFormat: () => self.nowMs,
      androidId: () => '',
      getWebViewUA: () => '',
      readFile: () => '',
      writeFile: () => {},
    };

    const source = {
      bookSourceUrl: this.source.bookSourceUrl || '',
      bookSourceName: this.source.bookSourceName || '',
      bookSourceGroup: this.source.bookSourceGroup || '',
      bookSourceComment: this.source.bookSourceComment || '',
      loginUrl: this.source.loginUrl || '',
      header: this.source.header || '',
      concurrentRate: this.source.concurrentRate || '',
      // Rhino 里 Kotlin `getKey()` 既能 `source.getKey()` 也能 `source.key` 属性访问；
      // 7054/7383 笔趣全家桶的 @js: searchUrl 用的就是 `source.key`
      get key() { return self.source.bookSourceUrl || ''; },
      getKey: () => (self.source.bookSourceUrl || ''),
      getVariable: () => '',
      setVariable: () => {},
      putLoginInfo: () => {},
      getLoginInfoMap: () => ({}),
      getLoginInfo: () => '',
      removeLoginInfo: () => {},
    };

    const cookie = {
      getCookie: (url) => (self.jar ? self.jar.getCookieHeader(String(url)) : ''),
      setCookie: (url, c) => { if (self.jar) self.jar.setCookieString(String(url), String(c)); },
      removeCookie: (url) => { if (self.jar) self.jar.removeCookie(String(url)); },
      getKey: (name, url) => (self.jar ? self.jar.get(String(name), String(url)) : ''),
    };

    const C = {
      putMemory: (k, v) => { self.memory.set(String(k), v); },
      getFromMemory: (k) => { const v = self.memory.get(String(k)); return v === undefined ? '' : v; },
      put: (k, v) => { self.memory.set(String(k), v); },
      get: (k) => { const v = self.memory.get(String(k)); return v === undefined ? '' : v; },
    };

    const mkUnsupported =
      (name) =>
        (..._a) => {
          self.unsupported.add('J.' + name);
          return '';
        };

    const J = new Proxy(
      {
        startBrowserAwait: mkUnsupported('startBrowserAwait'),
        startBrowser: mkUnsupported('startBrowser'),
        webView: mkUnsupported('webView'),
        startAutoRefresh: mkUnsupported('startAutoRefresh'),
        refreshToc: mkUnsupported('refreshToc'),
        openUrl: mkUnsupported('openUrl'),
        callJava: () => '',
        get: (o, k) => (o ? o[k] : undefined),
        set: (o, k, v) => { if (o) o[k] = v; return true; },
        toJs: (o) => o,
        toStr: (o) => (o == null ? '' : String(o)),
        create: (o) => o,
        createArray: (o) => (Array.isArray(o) ? o : []),
        copy: (o) => o,
      },
      {
        get(t, k) {
          if (k in t) return t[k];
          if (typeof k === 'string' && /^[a-zA-Z]/.test(k)) {
            return (..._a) => { self.unsupported.add('J.' + String(k)); return ''; };
          }
          return undefined;
        },
      }
    );

    const sandbox = {
      java,
      source,
      cookie,
      C,
      J,
      Packages: P.Packages || { java: P.java, javax: P.javax, android: P.android },
      JSON,
      String,
      Number,
      Boolean,
      Array,
      Object,
      Math,
      Date: makeFrozenDate(this.nowMs),
      RegExp,
      Error,
      TypeError,
      parseInt,
      parseFloat,
      isNaN,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      Map,
      Set,
      Promise,
      Symbol,
      console: { log: (...a) => java.log(...a), error: (...a) => java.log(...a), warn: (...a) => java.log(...a) },
      baseUrl: this.baseUrl,
      ...this._jsLibExports(),
      ...stripReservedVars(vars),
    };
    // Packages 需要按 Legado 的写法：Packages.javax.crypto.Cipher
    sandbox.Packages = { java: { ...P.java, ...P.Packages?.java }, javax: P.javax, android: P.android, org: P.org, com: P.com };
    return sandbox;
  }

  /**
   * 书源 jsLib 的导出表（对齐 Legado：jsLib 注入全局作用域）。
   *
   * 实现：把 jsLib 包成 IIFE 在 vm 沙箱里跑一次，捕获其顶层 function/var 声明；
   * 之后每次 _buildSandbox 把导出表并入沙箱。首跑发生在一个**没有 jsLib 的**
   * 最小沙箱里（真实 Legado 中 jsLib 编译期就注入，跑期间不会再引用自身），
   * 若书源逻辑确需自引用，导出表会在下一次求值时可见（预取重跑天然多轮，无碍）。
   */
  _jsLibExports() {
    const libText = Array.isArray(this.source.jsLib)
      ? this.source.jsLib.filter((x) => x != null).map(String).join('\n')
      : String(this.source.jsLib || '');
    if (!libText.trim()) return {};
    if (this._jsLibState === 'ok') return this._jsLibFn || {};
    if (this._jsLibState === 'fail') return {};
    // 首次：预编译。用无 jsLib 的最小沙箱执行收集顶层声明。
    // 注意：必须在**顶层作用域**执行（不能包 IIFE——IIFE 会把 function/var 声明私有化，
    // 永远到不了 globalThis）。顶层 function/var 声明会挂到 vm 全局，前后 key 差集即导出表。
    this._jsLibState = 'fail';
    try {
      const probeSandbox = this._buildSandbox({});
      const before = new Set(Reflect.ownKeys(probeSandbox));
      const ctx = vm.createContext(probeSandbox, { name: 'jslib-init' });
      vm.runInContext(libText, ctx, { timeout: 8000, filename: 'jslib.js' });
      const out = {};
      for (const k of Reflect.ownKeys(probeSandbox)) {
        if (before.has(k)) continue;
        try {
          const v = probeSandbox[k];
          if (v !== undefined && v !== null) out[k] = v;
        } catch (_) {}
      }
      this._jsLibFn = out;
      this._jsLibState = 'ok';
      if (this.logger && Object.keys(this._jsLibFn).length) {
        this.logger(`[jslib] 注入 ${Object.keys(this._jsLibFn).length} 个全局：${Object.keys(this._jsLibFn).slice(0, 12).join(', ')}`);
      }
    } catch (e) {
      this._jsLibFn = null;
      this._jsLibState = 'fail';
      this.errors.push(`jsLib 预编译失败：${e && e.message ? e.message : e}`);
    }
    return this._jsLibFn || {};
  }

  /**
   * 同步执行一段 JS。
   * @param {string} code
   * @param {object} vars 注入变量：result / book / key / page / nextUrl / ...
   * @returns {*} 脚本返回值
   */
  run(code, vars = {}) {
    return normalizeResult(this.runRaw(code, vars));
  }

  /**
   * 同步执行一段 JS 并返回**原始值**（不规整成字符串）。
   *
   * 规则管线里需要拿到原始值：JS 块可以返回对象数组（如起点目录规则的
   * `list.push({text, href, ...})`），规整成字符串就丢了结构。
   *
   * 求值策略（对齐 Rhino `Script.eval` 的「脚本完成值」语义）：
   *   1. `(function(){ return (CODE) })()`  —— 单表达式 / IIFE
   *   2. 裸脚本 `CODE`                      —— 语句块，取最后一条表达式的完成值
   *      （`list=[]; ...; list` 这种以裸表达式结尾的规则必须走这条，否则拿不到返回值）
   *   3. `(function(){ CODE })()`           —— 兜底（含顶层 `return` 的写法）
   */
  runRaw(code, vars = {}) {
    if (code == null || !String(code).trim()) return '';
    const src = String(code).trim();
    const sandbox = this._buildSandbox(vars);
    const ctx = vm.createContext(sandbox, { name: 'legado-js' });
    try {
      return vm.runInContext(`(function(){ return (${src}\n); })()`, ctx, { timeout: 8000, filename: 'rule.js' });
    } catch (_e1) { /* 落到下一种写法 */ }
    try {
      return vm.runInContext(src, ctx, { timeout: 8000, filename: 'rule.js' });
    } catch (_e2) { /* 落到下一种写法 */ }
    try {
      return vm.runInContext(`(function(){ ${src}\n })()`, ctx, { timeout: 8000, filename: 'rule.js' });
    } catch (e3) {
      this.errors.push(String(e3 && e3.message ? e3.message : e3));
      if (this.logger) this.logger('[js error] ' + (e3 && e3.stack ? e3.stack.split('\n')[0] : e3));
      return '';
    }
  }

  /**
   * 记录一次求值中未覆盖的 API（供探测器用）
   */
  resetDiagnostics() { this.unsupported.clear(); this.errors.length = 0; }
  getDiagnostics() { return { unsupported: [...this.unsupported], errors: [...this.errors] }; }
}

/** 把 JS 返回值规整为字符串 */
function normalizeResult(v, sandbox) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof JavaString) return v._v;
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return javaDecodeBuffer(v, 'utf-8');
  if (Array.isArray(v)) return v.map((x) => (x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n');
  // cheerio 对象（规则里常把 result 当 $ 用）
  if (typeof v === 'object' && typeof v.text === 'function') {
    try { return v.text(); } catch (_) { return ''; }
  }
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

module.exports = {
  JsRuntime, Prefetcher, reqKey, normalizeResult,
  JavaString, MessageDigest, Cipher, Mac, SecureRandom, Base64Facade,
  ByteArrayOutputStream, HashMap, ArrayList, toBuffer, makePackages,
  javaDecodeBuffer, javaCharsetBuffer, NET_METHODS, UNSUPPORTED_METHODS,
};
