'use strict';
/**
 * HTTP 客户端（异步）。
 *
 * 设计要点：
 *  - keepAlive 连接池（实测首个 TLS 握手可达 1.5s，必须复用连接）
 *  - 自动 30x 跟随，跨协议安全降级
 *  - gzip / deflate / br 自动解压
 *  - CookieJar 集成（enabledCookieJar 语义）
 *  - 返回 Buffer，交给 encoding.decode 判断字符集
 *  - 默认 UA 与 Legado 保持一致：**桌面 Windows Chrome**（不是移动 UA）。
 *    实测大量小说站按 UA 返回两套模板，且书源规则是按桌面模板写的。
 *  - POST 三分支（对齐 AnalyzeUrl.kt:476-489）：form / 显式 Content-Type / JSON
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const { decode } = require('../util/encoding');
const { encodeParams } = require('./encode');

/** 对应 Legado FeatureSettingsRepositories.kt:158-162 的默认 UA */
const CHROME_MAIN_VERSION = '128.0.0.0';
const DEFAULT_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAIN_VERSION} Safari/537.36`;

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const JSON_CONTENT_TYPE = 'application/json; charset=UTF-8';

/** 对应 StringExtensions.kt:47-73 */
function isJsonLike(s) {
  const t = String(s == null ? '' : s).trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}
function isXmlLike(s) {
  const t = String(s == null ? '' : s).trim();
  return t.startsWith('<') && t.endsWith('>');
}

/**
 * 对应 AnalyzeUrl.kt:277-285 + :481-488 的 POST 三分支。
 * @returns {{body:string|null, contentType:string|null}} contentType 为 null 表示
 *          已有显式 Content-Type（不要覆盖）
 */
function preparePostBody(body, headers, charset) {
  const hasCT = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  const raw = body == null ? '' : String(body);
  // 分支 1：body 非 JSON/XML 且未显式指定 Content-Type → 表单编码
  if (!hasCT && !isJsonLike(raw) && !isXmlLike(raw)) {
    return { body: encodeParams(raw, charset, false), contentType: FORM_CONTENT_TYPE };
  }
  // 分支 2：显式 Content-Type → 原样发送
  if (hasCT) return { body: raw, contentType: null };
  // 分支 3：JSON
  return { body: raw, contentType: JSON_CONTENT_TYPE };
}

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 24, keepAliveMsecs: 30000 }),
  'https:': new https.Agent({
    keepAlive: true,
    maxSockets: 24,
    keepAliveMsecs: 30000,
    // 部分小说站证书配置糟糕，Legado 默认也是宽松策略
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
  }),
};

/** 预热：提前建立某个主机的 TLS 连接，避免首个业务请求吃满握手时间 */
async function preconnect(url) {
  try {
    await request(url, { method: 'HEAD', timeout: 8000, redirect: 0, quiet: true });
  } catch (_) {
    /* 忽略预热失败 */
  }
}

function decompress(buf, encoding) {
  if (!buf || buf.length === 0) return buf;
  const e = String(encoding || '').toLowerCase();
  try {
    if (e.includes('br')) return zlib.brotliDecompressSync(buf);
    if (e.includes('gzip') || e.includes('x-gzip')) return zlib.gunzipSync(buf);
    if (e.includes('deflate')) {
      try { return zlib.inflateSync(buf); } catch (_) { return zlib.inflateRawSync(buf); }
    }
  } catch (_) {
    // 解压失败就按原文返回，交给上层容错
    return buf;
  }
  return buf;
}

/**
 * 发起请求。
 * @param {string} url
 * @param {object} [options]
 * @param {'GET'|'POST'|string} [options.method]
 * @param {object} [options.headers] 额外请求头（会与默认头合并）
 * @param {string|Buffer} [options.body]
 * @param {number} [options.timeout=25000]
 * @param {number} [options.redirect=5] 最多跟随次数
 * @param {import('./cookiejar').CookieJar} [options.jar]
 * @param {string} [options.charset] 强制字符集
 * @returns {Promise<{status:number, headers:object, body:Buffer, text:string, charset:string, url:string}>}
 */
function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 25000,
    redirect = 5,
    jar = null,
    charset = null,
  } = options;

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      const err = new Error('无效 URL: ' + url);
      err.code = 'EINVALURL';
      return reject(err);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      const err = new Error('不支持的协议: ' + u.protocol);
      err.code = 'EPROTO';
      return reject(err);
    }

    const finalHeaders = {
      'User-Agent': DEFAULT_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      ...headers,
    };
    if (!finalHeaders['User-Agent']) finalHeaders['User-Agent'] = DEFAULT_UA;

    const cookieStr = jar ? jar.getCookieHeader(url) : '';
    if (cookieStr && !finalHeaders.Cookie && !finalHeaders.cookie) {
      finalHeaders.Cookie = cookieStr;
    }

    let payload = body;
    const methodUpper = String(method).toUpperCase();
    if (methodUpper === 'POST') {
      const prep = preparePostBody(payload, finalHeaders, charset);
      payload = prep.body;
      if (prep.contentType) finalHeaders['Content-Type'] = prep.contentType;
    }
    if (typeof payload === 'string') payload = Buffer.from(payload, 'utf8');
    if (payload) finalHeaders['Content-Length'] = String(payload.length);

    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: methodUpper,
        headers: finalHeaders,
        agent: agents[u.protocol],
        timeout,
      },
      (res) => {
        // 30x 跟随
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirect > 0) {
          res.resume();
          if (jar) jar.setFromResponse(url, res.headers['set-cookie']);
          let next;
          try {
            next = new URL(res.headers.location, url).toString();
          } catch (_) {
            return reject(new Error('无效跳转地址: ' + res.headers.location));
          }
          const nextMethod = status === 303 || (status === 301 && method === 'POST') || (status === 302 && method === 'POST') ? 'GET' : method;
          return resolve(
            request(next, { ...options, method: nextMethod, body: nextMethod === 'GET' ? null : body, redirect: redirect - 1 })
          );
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (jar) jar.setFromResponse(url, res.headers['set-cookie']);
          let buf = Buffer.concat(chunks);
          buf = decompress(buf, res.headers['content-encoding']);
          const dec = decode(buf, {
            charset,
            contentType: res.headers['content-type'],
          });
          resolve({
            status,
            headers: res.headers,
            body: buf,
            text: dec.text,
            charset: dec.charset,
            url,
          });
        });
        res.on('error', reject);
      }
    );

    req.on('timeout', () => {
      const err = new Error('请求超时: ' + url);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', (e) => {
      if (!e.code) e.code = 'ENETWORK';
      reject(e);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/** GET 便捷封装 */
async function get(url, options = {}) {
  return request(url, { ...options, method: 'GET' });
}

/** POST 便捷封装 */
async function post(url, body, options = {}) {
  return request(url, { ...options, method: 'POST', body });
}

module.exports = {
  request,
  get,
  post,
  preconnect,
  DEFAULT_UA,
  CHROME_MAIN_VERSION,
  FORM_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  isJsonLike,
  isXmlLike,
  preparePostBody,
  agents,
};
