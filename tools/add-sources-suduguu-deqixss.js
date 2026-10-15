/**
 * 生成并导入两个新书源：速读谷（suduguu.com）与得奇小说网（deqixss.com）
 *
 * 站点逆向结论（2026-10 实测）：
 *
 * 【速读谷 www.suduguu.com】
 *   - 搜索：GET /i/sor.aspx?key=<GBK? 不，UTF-8 urlencode>，结果 .item / h3 a / .itemtxt p span
 *   - 详情/目录：GET /<bookId>/ 同一页含 #list.dir 下全部章节；书名 h1 a、作者 .itemtxt p a[href*=zuozhe]、简介 .des
 *   - 正文：GET /<bookId>/<chapterId>.html，正文 div.con 内 <p>…</p>
 *   - 关键：长章节被站方切成多页 /<bookId>/<chapterId>-2.html、-3.html…（同章续页），
 *     靠 a[href$=下一页] 串联，最后一页无「下一页」→ 必须用 nextContentUrl 拼接，否则正文被截断。
 *   - 编码 UTF-8。
 *
 * 【得奇小说网 www.deqixss.com】
 *   - 搜索：GET /modules/article/search.php?searchkey=<kw>，结果 div.bookbox / h4.bookname a /
 *     div.author / div.cat a（最新章节）/ div.update（简介）。
 *     注意：请求需带 Referer=https://www.deqixss.com/ ，否则部分关键词 (中文) 会 302 到 /books/<id>/。
 *   - 详情/目录：GET /books/<id>/ 页面含书名(.bookname/h1)、作者、简介 与 全部章节 a[href*=/books/<id>/<num>.html]。
 *   - 正文：**不是静态 HTML**，须两步：
 *       ① GET /scripts/chapter.js.php?aid=<aid>&cid=<cid>&referrer=<详情页URL> 取 chapterToken/timestamp/nonce
 *       ② GET /modules/article/ajax2.php?aid&cid&token&timestamp&nonce 取 JSON 的 data.content（HTML 片段）
 *     响应体本身是 UTF-8 JSON（站点另一处 gbkToString 是历史遗留，实测直接 JSON.parse 可成）。
 *     该 token 有时效（timestamp 与请求时刻相差数百 ms 即有效），所以必须在同一次规则里连做两步。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCES_FILE = path.join(ROOT, 'data', 'sources', 'sources.json');

/* ------------------------------- 速读谷 ------------------------------- */
const suduguu = {
  bookSourceName: '速读谷',
  bookSourceGroup: '自定义',
  bookSourceType: 0,
  bookSourceUrl: 'https://www.suduguu.com',
  bookSourceComment: '速读谷（suduguu.com）。正文长章节站方分页（-2/-3.html），已用 nextContentUrl 自动续页。',
  enabled: true,
  enabledExplore: true,
  enabledCookieJar: true,
  customOrder: 0,
  concurrentRate: '1/1000',
  header: JSON.stringify({
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://www.suduguu.com/',
  }),
  searchUrl: '/i/sor.aspx?key={{key}}',
  ruleSearch: {
    bookList: '.item',
    name: 'h3 a@text',
    author: 'p a[href*=zuozhe]@text##作者：',
    kind: '.itemtxt p span@text',
    intro: '',
    coverUrl: 'img@src',
    bookUrl: 'h3 a@href',
    lastChapter: 'ul li a@text',
  },
  ruleBookInfo: {
    name: 'h1 a@text',
    author: 'p a[href*=zuozhe]@text##作者：',
    kind: '.itemtxt p span@text',
    intro: '.des@text',
    coverUrl: '.item img@src',
    tocUrl: '',
    lastChapter: 'ul li a@text',
    wordCount: 'h1 i@text',
  },
  ruleToc: {
    chapterList: '#list li',
    chapterName: 'a@text',
    chapterUrl: 'a@href',
  },
  ruleContent: {
    content: '.con',
    // 同章续页：/51/4419509.html → /51/4419509-2.html → -3 …；末页无「下一页」即为终止
    nextContentUrl: 'a[href*=下一页]@href',
    replaceRegex: '/速读谷|shudugu\\.org|看最新完整章節，就上速讀谷/g',
  },
  ruleExplore: [
    { name: '玄幻', url: '/xuanhuan/' },
    { name: '仙侠', url: '/xianxia/' },
    { name: '都市', url: '/dushi/' },
    { name: '历史', url: '/lishi/' },
    { name: '军事', url: '/junshi/' },
    { name: '科幻', url: '/kehuan/' },
    { name: '言情', url: '/yanqing/' },
    { name: '排行榜', url: '/paihang/' },
    { name: '完结', url: '/wanjie/' },
    { name: '最新更新', url: '/zuixin/' },
  ],
  ruleExplore_item: { bookList: '.list li, .item', name: 'a@text', bookUrl: 'a@href', coverUrl: 'img@src', author: '' },
  weight: 0,
  respondTime: 6000,
};

/* ------------------------------ 得奇小说网 ------------------------------ */
// 得奇正文两步：先取 token，再取内容。Legado 规则里用 @js: 发两次 java.ajax 拼 JSON。
const DQ_TOKEN_URL =
  "'/scripts/chapter.js.php?aid=' + aid + '&cid=' + cid + '&referrer=' + encodeURIComponent(baseUrl + '/books/' + aid + '/' + cid + '.html')";
const DQ_CONTENT_JS = `<js>
var aid = java.getString('//input[@id="articleId"]/@value');
if (!aid) aid = java.getString('//script[contains(text(),"initChapterContent")]/text()');
</js>`;

const deqixss = {
  bookSourceName: '得奇小说网',
  bookSourceGroup: '自定义',
  bookSourceType: 0,
  bookSourceUrl: 'https://www.deqixss.com',
  bookSourceComment:
    '得奇小说网（deqixss.com）。正文为 AJAX 动态加载（ajax2.php + token 时效校验），已用 @js 两步取回并解析。搜索需带 Referer，否则中文关键词会被 302。',
  enabled: true,
  enabledExplore: true,
  enabledCookieJar: true,
  customOrder: 0,
  concurrentRate: '1/1500',
  header: JSON.stringify({
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://www.deqixss.com/',
  }),
  searchUrl: '/modules/article/search.php?searchkey={{key}}',
  ruleSearch: {
    bookList: '.bookbox',
    name: 'h4.bookname a@text',
    author: '.author@text##作者：',
    kind: '',
    intro: '.update@text##简介：',
    coverUrl: '',
    bookUrl: 'h4.bookname a@href',
    lastChapter: '.cat a@text',
  },
  ruleBookInfo: {
    name: 'h1@text||.bookname@text',
    author: 'p a[href*=author]@text||.author@text##作者：',
    kind: '.cat span@text||p span@text',
    intro: '.intro@text||.update@text##简介：',
    coverUrl: '.bookimg img@src',
    tocUrl: '',
    lastChapter: '#newchapter a@text||.cat a@text',
  },
  ruleToc: {
    // 得奇目录就在详情页 /books/<id>/ 内
    chapterList: 'div.book_list li||#chapterlist li||ul.chapter li',
    chapterName: 'a@text',
    chapterUrl: 'a@href',
  },
  ruleContent: {
    // 正文两步：① 取 token ② 换正文 JSON。用 @js 串联，返回 HTML 片段交给解析器。
    content: `<js>
var href = baseUrl + java.get('url');
var m = /\\/books\\/(\\d+)\\/(\\d+)\\.html/.exec(java.get('url'));
if (!m) { result = '<p>无法解析章节地址</p>'; } else {
  var aid = m[1], cid = m[2];
  var tk = java.ajax(baseUrl + '/scripts/chapter.js.php?aid=' + aid + '&cid=' + cid + '&referrer=' + encodeURIComponent(baseUrl + '/books/' + aid + '/' + cid + '.html'));
  var token = /chapterToken\\s*=\\s*'([^']+)'/.exec(tk);
  var ts = /timestamp\\s*=\\s*(\\d+)/.exec(tk);
  var nonce = /nonce\\s*=\\s*'([^']+)'/.exec(tk);
  if (!token || !ts || !nonce) { result = '<p>token 获取失败</p>'; }
  else {
    var j = java.ajax(baseUrl + '/modules/article/ajax2.php?aid=' + aid + '&cid=' + cid
      + '&token=' + token[1] + '&timestamp=' + ts[1] + '&nonce=' + nonce[1]);
    var o = JSON.parse(j);
    result = (o && o.data && o.data.content) ? o.data.content : '<p>' + ((o && o.message) || '正文为空') + '</p>';
  }
}
</js>`,
    nextContentUrl: '',
    replaceRegex: '/得奇小说网|deqixss\\.com|请记住本站/g',
  },
  ruleExplore: [
    { name: '书库', url: '/sort/0/1.html' },
    { name: '玄幻', url: '/sort/1/1.html' },
    { name: '都市', url: '/sort/2/1.html' },
    { name: '仙侠', url: '/sort/3/1.html' },
    { name: '历史', url: '/sort/4/1.html' },
    { name: '科幻', url: '/sort/5/1.html' },
    { name: '诸天无限', url: '/sort/6/1.html' },
    { name: '悬疑', url: '/sort/7/1.html' },
    { name: '排行', url: '/top.html' },
  ],
  ruleExplore_item: { bookList: '.bookbox||.item', name: 'h4 a@text||a@text', bookUrl: 'h4 a@href||a@href', coverUrl: 'img@src', author: '' },
  weight: 0,
  respondTime: 8000,
};

/* ------------------------------- 写入 ------------------------------- */
const raw = fs.readFileSync(SOURCES_FILE, 'utf8');
const list = JSON.parse(raw);
const before = list.length;
const added = [];
for (const src of [suduguu, deqixss]) {
  const i = list.findIndex((s) => s.bookSourceUrl === src.bookSourceUrl);
  if (i >= 0) {
    list[i] = src; // 覆盖已存在的同名/同 URL 源
    added.push(src.bookSourceName + '(已更新)');
  } else {
    list.push(src);
    added.push(src.bookSourceName + '(新增)');
  }
}
fs.writeFileSync(SOURCES_FILE, JSON.stringify(list, null, 2), 'utf8');
console.log('已写入 ' + SOURCES_FILE);
console.log('书源数 ' + before + ' -> ' + list.length + '：' + added.join('、'));
