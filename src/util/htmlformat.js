'use strict';
/**
 * HTML 净化格式化 —— 逐行移植 Legado `app/src/main/java/io/legado/app/utils/HtmlFormatter.kt`。
 *
 * 书源产出的正文/简介是 HTML 片段（`<p>…</p><br>`、`&nbsp;`、`<script>`…），
 * 阅读器与导出需要的是带段首缩进的纯文本。Legado 的等价步骤是：
 *
 *   BookContent.kt:244  content = HtmlFormatter.formatKeepImg(content, rUrl)  // 正文
 *   BookInfo.kt:139     HtmlFormatter.format(intro).take(5000)               // 简介
 *
 * 两者共用同一套正则，差别只在「保留 img」与「不保留」：
 *   format()        → `otherHtmlRegex` 会把所有标签（含 img）删掉
 *   formatKeepImg() → `notImgHtmlRegex` 只删非 img 标签，img 再单独重写为绝对 URL
 */

/* ---- HtmlFormatter.kt:9-68 的正则表，逐条对齐 ---- */
const NBSP_RE = /(&nbsp;)+/g;
const ESP_RE = /(&ensp;|&emsp;)/g;
const NO_PRINT_RE = /(&thinsp;|&zwnj;|&zwj;|\u2009|\u200C|\u200D)/g;

/** 会形成段落分隔的块级标签 → 统一换行 */
const WRAP_HTML_RE = /<\/?(?:div|p|br|hr|h\d|article|dd|dl)[^>]*>/g;
const COMMENT_RE = /<!--[^>]*-->/g;
/** 删除**除 img 外**的所有标签（formatKeepImg 用） */
const NOT_IMG_HTML_RE = /<\/?(?!img)[a-zA-Z]+(?=[ >])[^<>]*>/g;
/** 删除所有标签（format 用） */
const OTHER_HTML_RE = /<\/?[a-zA-Z]+(?=[ >])[^<>]*>/g;

const INDENT1_RE = /\s*\n+\s*/g;
const INDENT2_RE = /^[\n\s]+/;
const LAST_RE = /[\n\s]+$/;

/** `{...}` 是书源模板变量，与 Legado 一致地放行「src 里带占位符」的图 */
const FORMAT_IMAGE_RE = new RegExp(
  '<img[^>]*\\ssrc\\s*=\\s*[\'"]([^\'"{>]*\\{(?:[^{}]|\\{[^}>]+\\})+\\})[\'"][^>]*>'
  + '|<img[^>]*\\s(?:data-src|src)\\s*=\\s*[\'"]([^\'">]+)[\'"][^>]*>'
  + '|<img[^>]*\\sdata-[^=>]*=\\s*[\'"]([^\'">]*)[\'"][^>]*>',
  'gi',
);

/** 段首缩进：两个全角空格（HtmlFormatter.PARAGRAPH_INDENT） */
const PARAGRAPH_INDENT = '\u3000\u3000';

/** `<usehtml>…</usehtml>` 整块保留（AppPattern.useHtmlRegex） */
const USE_HTML_RE = /<usehtml>.*?<\/usehtml>/gs;

/** 半角空白由 indent 正则处理，这里去掉全角及特殊宽度空格再 trim */
const BLANK_CHARS = new Set([' ', '\t', '\u00a0', '\u2002', '\u2003', '\u2009', '\u3000']);

function trimBlank(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (BLANK_CHARS.has(s[a]) || /\s/.test(s[a]))) a++;
  while (b > a && (BLANK_CHARS.has(s[b - 1]) || /\s/.test(s[b - 1]))) b--;
  return s.slice(a, b);
}

/**
 * HtmlFormatter.format 的私有核心（`:76-87`）。
 * @param {string} html
 * @param {RegExp} otherRegex 删标签用的正则（notImg vs other）
 * @param {string} paragraphIndent 段首缩进串
 */
function formatCore(html, otherRegex, paragraphIndent) {
  if (html == null) return '';
  return String(html)
    .replace(NBSP_RE, ' ')
    .replace(ESP_RE, ' ')
    .replace(NO_PRINT_RE, '')
    .replace(WRAP_HTML_RE, '\n')
    .replace(COMMENT_RE, '')
    .replace(otherRegex, '')
    .replace(INDENT1_RE, `\n${paragraphIndent}`)
    .replace(INDENT2_RE, paragraphIndent)
    .replace(LAST_RE, '');
}

/** `HtmlFormatter.format(html)` —— 全删标签，段首补两个全角空格 */
function format(html, paragraphIndent = PARAGRAPH_INDENT) {
  return formatCore(html, OTHER_HTML_RE, paragraphIndent);
}

/**
 * `HtmlFormatter.formatKeepImg(html, redirectUrl)`（`:151-181` 前半）。
 *
 * 先按 `notImgHtmlRegex` 删掉除 img 外的标签，再把每个 img 重写成
 * `<img src="绝对URL">`：src 取自 `src=`（允许 `{...}` 模板）/`data-src`/`data-*` 三级回退，
 * 且 src 若形如 `url,{options}` 则只取 url 部分、把 `,{options}` 原样拼回属性后。
 */
function formatKeepImg(html, redirectUrl = null, absUrl = null) {
  if (html == null) return '';
  const keep = formatCore(html, NOT_IMG_HTML_RE, PARAGRAPH_INDENT);

  let out = '';
  let appendPos = 0;
  FORMAT_IMAGE_RE.lastIndex = 0;
  let m = FORMAT_IMAGE_RE.exec(keep);
  while (m !== null) {
    let param = '';
    const raw = m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]);
    let src = raw == null ? '' : raw;
    // `url,{options}` 分离（对应 AnalyzeUrl.paramPattern）
    const pm = /\s*,\s*(?=\{)/.exec(src);
    if (pm) {
      param = `,${src.slice(pm.index + pm[0].length)}`;
      src = src.slice(0, pm.index);
    }
    const abs = absUrl ? absUrl(redirectUrl, src) : src;
    out += `${keep.slice(appendPos, m.index)}<img src="${abs}${param}">`;
    appendPos = m.index + m[0].length;
    m = FORMAT_IMAGE_RE.exec(keep);
  }
  if (appendPos < keep.length) out += keep.slice(appendPos);
  return out;
}

/**
 * 正文格式化总入口，对齐 `BookContent.kt:234-251`：
 * 1. `adaptSpecialStyle` 时把 `<usehtml>…</usehtml>` 挖出来占位（默认开启，与阅读设置默认值一致）
 * 2. `formatKeepImg` 净化
 * 3. 有 `&` 时做 HTML 实体反转义（`StringEscapeUtils.unescapeHtml4` 的常用子集）
 * 4. 占位符还原
 */
function formatContent(html, redirectUrl = null, absUrl = null, adaptSpecialStyle = true) {
  if (html == null) return '';
  let content = String(html);
  const useHtmlMap = new Map();
  if (adaptSpecialStyle) {
    content = content.replace(USE_HTML_RE, (whole) => {
      const ph = `{usehtml_${useHtmlMap.size}}`;
      useHtmlMap.set(ph, whole);
      return ph;
    });
  }
  content = formatKeepImg(content, redirectUrl, absUrl);
  if (content.indexOf('&') > -1) content = unescapeHtml4(content);
  for (const [ph, original] of useHtmlMap) content = content.split(ph).join(original);
  return content;
}

/** `StringEscapeUtils.unescapeHtml4` 的常用实体子集（数字实体 + 命名表） */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', middot: '\u00b7', times: '\u00d7',
  divide: '\u00f7', laquo: '\u00ab', raquo: '\u00bb', deg: '\u00b0',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', sect: '\u00a7',
  para: '\u00b6', bull: '\u2022', dagger: '\u2020', permil: '\u2030',
  prime: '\u2032', Prime: '\u2033', larr: '\u2190', uarr: '\u2191',
  rarr: '\u2192', darr: '\u2193', harr: '\u2194', infin: '\u221e',
  ne: '\u2260', le: '\u2264', ge: '\u2265', ensp: '\u2002', emsp: '\u2003',
  thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', shy: '\u00ad',
};

function unescapeHtml4(str) {
  return String(str).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch (_) {
        return whole;
      }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

module.exports = {
  format,
  formatKeepImg,
  formatContent,
  unescapeHtml4,
  PARAGRAPH_INDENT,
  trimBlank,
};
