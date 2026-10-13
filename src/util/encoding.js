'use strict';
/**
 * 编码工具：把 Buffer 按「声明 charset / HTML meta / BOM / 启发式」解码为字符串。
 *
 * 中文小说站大量使用 GBK/GB2312/GB18030，Legado 通过 AnalyzeUrl 的 charset
 * 参数或响应头 + 页面 meta 自动识别。这里实现同一套策略。
 */
const iconv = require('iconv-lite');

/** charset 别名归一化到 iconv-lite 认识的名字 */
const ALIAS = {
  'gbk': 'gbk',
  'gb2312': 'gbk',
  'gb-2312': 'gbk',
  'gb18030': 'gb18030',
  'big5': 'big5',
  'big5-hkscs': 'big5',
  'utf8': 'utf-8',
  'utf-8': 'utf-8',
  'unicode': 'utf-16le',
  'ucs-2': 'utf-16le',
  'utf-16': 'utf-16le',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'iso-8859-1': 'latin1',
  'latin1': 'latin1',
  'windows-1252': 'windows-1252',
  'shift_jis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'euc-kr': 'euc-kr',
};

function normalize(charset) {
  if (!charset) return null;
  const c = String(charset).trim().toLowerCase().replace(/^["']|["']$/g, '');
  return ALIAS[c] || c;
}

/** 从 HTTP Content-Type 里取 charset */
function fromContentType(contentType) {
  if (!contentType) return null;
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
  return m ? normalize(m[1]) : null;
}

/** 从 HTML `<meta charset>` / `<meta http-equiv>` 里取 charset */
function fromHtmlMeta(buf) {
  // 只看前 4KB，避免大页面开销
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
  let m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  if (m) return normalize(m[1]);
  m = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head);
  if (m) return normalize(m[1]);
  return null;
}

/** BOM 检测 */
function fromBom(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  return null;
}

/** 看起来像 UTF-8 吗？（严格校验多字节序列） */
function looksLikeUtf8(buf) {
  let i = 0;
  const n = buf.length;
  let multibyte = 0;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    let len;
    if ((b & 0xe0) === 0xc0) len = 2;
    else if ((b & 0xf0) === 0xe0) len = 3;
    else if ((b & 0xf8) === 0xf0) len = 4;
    else return false;
    if (i + len > n) return false;
    for (let k = 1; k < len; k++) if ((buf[i + k] & 0xc0) !== 0x80) return false;
    // 拒绝过长编码
    if (len === 2 && b < 0xc2) return false;
    if (len === 3 && b === 0xe0 && buf[i + 1] < 0xa0) return false;
    if (len === 4 && b === 0xf0 && buf[i + 1] < 0x90) return false;
    multibyte++;
    i += len;
  }
  return multibyte > 0 ? true : null; // null = 纯 ASCII，无法判断
}

/**
 * 解码 Buffer。
 * @param {Buffer} buf
 * @param {object} [opts] { charset: 强制 charset, contentType: 响应头, defaultCharset }
 * @returns {{ text: string, charset: string, source: string }}
 */
function decode(buf, opts = {}) {
  const { charset, contentType, defaultCharset = 'utf-8' } = opts;
  let cs = null, source = '';

  if (charset) { cs = normalize(charset); source = 'declared'; }
  if (!cs) { const b = fromBom(buf); if (b) { cs = b; source = 'bom'; } }
  if (!cs) { const c = fromContentType(contentType); if (c) { cs = c; source = 'content-type'; } }
  if (!cs) {
    const m = fromHtmlMeta(buf);
    // meta 声明的 utf-8 经常是假的（站点实际发 GBK），所以 meta 优先级要低于内容启发
    if (m) { cs = m; source = 'meta'; }
  }

  // 启发式：若没有明确声明，或声明为 utf-8 但内容不是合法 UTF-8，则退回 GBK
  if (!cs) { cs = defaultCharset; source = 'default'; }
  if (cs === 'utf-8') {
    const looks = looksLikeUtf8(buf);
    if (looks === false) { cs = 'gb18030'; source = (source || 'default') + '+heur-gbk'; }
  }

  if (cs === 'utf-8') {
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { text, charset: 'utf-8', source: source || 'utf-8' };
  }
  if (!iconv.encodingExists(cs)) cs = 'utf-8';
  let text = iconv.decode(buf, cs);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, charset: cs, source };
}

/** 编码字符串为 Buffer（用于 POST body 的 charset 转换） */
function encode(str, charset) {
  const cs = normalize(charset) || 'utf-8';
  if (cs === 'utf-8') return Buffer.from(str, 'utf8');
  if (!iconv.encodingExists(cs)) return Buffer.from(str, 'utf8');
  return iconv.encode(str, cs);
}

module.exports = { decode, encode, normalize, fromContentType, fromHtmlMeta, looksLikeUtf8, ALIAS };
