'use strict';
/**
 * URL / 表单参数编码 —— 逐字对齐 Legado `utils/NetworkUtils.kt` 与
 * `AnalyzeUrl.encodeParams` / `appendEncoded`。
 *
 * 关键语义（与 JS 的 encodeURIComponent 不同）：
 *  - form 分支用 java.net.URLEncoder 语义：**空格 → `+`**，保留字仅 `*-._`
 *  - query 分支按 notNeedEncodingQuery 保留表
 *  - charset 未指定时，仍会尝试「已是合法编码则原样保留」（checkEncoded 语义）
 *  - charset 可指定 gbk/gb18030，此时百分号编码基于该字符集的字节
 */

const iconv = require('iconv-lite');

/* --- 保留字符位图（对应 Kotlin BitSet(256)） --- */

function bitSetFrom(chars) {
  const set = new Set();
  for (const ch of chars) set.add(ch.codePointAt(0));
  return set;
}

/** 对应 notNeedEncodingQuery */
const NOT_NEED_ENCODING_QUERY = (() => {
  const s = new Set();
  for (let i = 0x61; i <= 0x7a; i++) s.add(i); // a-z
  for (let i = 0x41; i <= 0x5a; i++) s.add(i); // A-Z
  for (let i = 0x30; i <= 0x39; i++) s.add(i); // 0-9
  for (const ch of '!$&()*+,-./:;=?@[\\]^_`{|}~') s.add(ch.codePointAt(0));
  return s;
})();

/** 对应 notNeedEncodingForm */
const NOT_NEED_ENCODING_FORM = (() => {
  const s = new Set();
  for (let i = 0x61; i <= 0x7a; i++) s.add(i);
  for (let i = 0x41; i <= 0x5a; i++) s.add(i);
  for (let i = 0x30; i <= 0x39; i++) s.add(i);
  for (const ch of '*-._') s.add(ch.codePointAt(0));
  return s;
})();

const isDigit16Char = (c) => /[0-9a-fA-F]/.test(c);

/** 对应 NetworkUtils.encodedQuery —— 为 true 表示「无需再编码」 */
function encodedQuery(str) {
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (NOT_NEED_ENCODING_QUERY.has(c.codePointAt(0))) continue;
    if (c === '%' && i + 2 < s.length) {
      const c1 = s[++i];
      const c2 = s[++i];
      if (isDigit16Char(c1) && isDigit16Char(c2)) continue;
    }
    return false;
  }
  return true;
}

/** 对应 NetworkUtils.encodedForm */
function encodedForm(str) {
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (NOT_NEED_ENCODING_FORM.has(c.codePointAt(0))) continue;
    if (c === '%' && i + 2 < s.length) {
      const c1 = s[++i];
      const c2 = s[++i];
      if (isDigit16Char(c1) && isDigit16Char(c2)) continue;
    }
    return false;
  }
  return true;
}

/**
 * 对应 java.net.URLEncoder.encode(value, charset)
 * 空格 → `+`；保留字 alnum + `*-._`；其余按 charset 字节做 %XX（大写）
 */
function urlEncoderEncode(value, charsetName) {
  const s = String(value == null ? '' : value);
  const cs = normalizeCharset(charsetName);
  let out = '';
  for (const ch of s) {
    if (ch === ' ') {
      out += '+';
      continue;
    }
    const cp = ch.codePointAt(0);
    if (NOT_NEED_ENCODING_FORM.has(cp)) {
      out += ch;
      continue;
    }
    const buf = iconv.encode(ch, cs.name);
    for (let i = 0; i < buf.length; i++) {
      out += '%' + buf[i].toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/**
 * 对应 EncoderUtils.escape —— **注意不是 JS 的 escape()**。
 * 仅保留 0-9 / A-Z / a-z；其余按码点拼：
 *   code < 16  → `%0` + 小写 hex（无补零）
 *   code < 256 → `%`  + 小写 hex（无补零）
 *   否则       → `%u` + 小写 hex
 * 例：空格(32)→`%20`、`!`(33)→`%21`、`\n`(10)→`%0a`、`中`(20013)→`%u4e2d`
 */
function escapeEncode(value) {
  const s = String(value == null ? '' : value);
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      out += ch;
      continue;
    }
    const prefix = code < 16 ? '%0' : code < 256 ? '%' : '%u';
    out += prefix + code.toString(16);
  }
  return out;
}

function normalizeCharset(name) {
  if (!name) return { name: 'utf-8', null: false };
  const n = String(name).toLowerCase();
  if (n === 'escape') return { name: 'utf-8', null: true };
  return { name: n, null: false };
}

/** 对应 AnalyzeUrl.encodeQueryParams —— query 里逐字符保留表（注意含 `&` `=`） */
const QUERY_ENCODER_SAFE = (() => {
  const s = new Set();
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~!$%&()*+,/:;=?@[\\]^`{|}') {
    s.add(ch.codePointAt(0));
  }
  return s;
})();

/** 对应 AnalyzeUrl.encodeQueryParams，%XX 用大写 hex */
function encodeQueryParams(str, charsetName) {
  const cs = normalizeCharset(charsetName).name;
  let out = '';
  for (const ch of String(str == null ? '' : str)) {
    const code = ch.codePointAt(0);
    if (code < 128 && QUERY_ENCODER_SAFE.has(code)) {
      out += ch;
      continue;
    }
    const buf = iconv.encode(ch, cs);
    for (let i = 0; i < buf.length; i++) {
      out += '%' + buf[i].toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/**
 * 对应 AnalyzeUrl.encodeParams —— 逐段解析 `k=v&k2=v2`，分别编码 key/value。
 * @param {string} params
 * @param {string} [charset] 未指定 → 假定「已编码则原样」，否则按 utf-8 编码
 * @param {boolean} isQuery
 */
function encodeParams(params, charset, isQuery) {
  const checkEncoded = !charset; // charset.isNullOrEmpty()
  const cs = charset
    ? (charset === 'escape' ? null : charset)
    : 'utf-8';

  const s = String(params == null ? '' : params);

  if (isQuery && cs != null) {
    if (encodedQuery(s)) return s;
    return encodeQueryParams(s, cs);
  }

  const len = s.length;
  const out = [];
  let pos = 0;
  while (pos <= len) {
    let ampOffset = s.indexOf('&', pos);
    if (ampOffset === -1) ampOffset = len;
    const eqOffset = s.indexOf('=', pos);
    let key;
    let value = null;
    if (eqOffset === -1 || eqOffset > ampOffset) {
      key = s.slice(pos, ampOffset);
    } else {
      key = s.slice(pos, eqOffset);
      value = s.slice(eqOffset + 1, ampOffset);
    }
    let seg = appendEncodedBuf(key, checkEncoded, cs);
    if (value != null) seg += '=' + appendEncodedBuf(value, checkEncoded, cs);
    out.push(seg);
    pos = ampOffset + 1;
  }
  return out.join('&');
}

/** 对应 appendEncoded（charset 为 null 时走 escape） */
function appendEncodedBuf(value, checkEncoded, cs) {
  if (cs == null) return escapeEncode(value);
  return urlEncoderEncodeWithCheck(value, checkEncoded, cs);
}

function urlEncoderEncodeWithCheck(value, checkEncoded, cs) {
  if (checkEncoded && encodedForm(value)) return value;
  return urlEncoderEncode(value, cs);
}

module.exports = {
  encodedQuery,
  encodedForm,
  urlEncoderEncode,
  escapeEncode,
  encodeQueryParams,
  encodeParams,
};
