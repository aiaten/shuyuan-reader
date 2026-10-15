/**
 * 修正并落库：速读谷 + 得奇小说网
 *
 * 本次修复的两个真实缺陷（由引擎实跑发现）：
 *
 * ① 速读谷 URL 形态：书源库原先存在 `https://suduguu.com/`（无 www），站点 301 到 www。
 *    相对 URL 解析基准变成非 www 域后，`a@href` 会把整段 li 链接串起来
 *    → bookUrl = `/287//zuozhe/?tag=...` 这种垃圾串，目录必然解析失败。
 *    统一用 `https://www.suduguu.com`，且 bookUrl 明确用 `h3 a@href`（避免落到作者链接）。
 *
 * ② 得奇正文：ajax2.php 需要 **Referer(章节页) + X-Requested-With: XMLHttpRequest** 同送，
 *    只送 UA/Referer 会得到 `{"status":0,"message":"仅支持网页端访问"}`；
 *    只送 X-Requested-With（无 Referer）会得到「非法访问来源」。
 *    两次 java.ajax 都必须带上同一份 headers（Prefetcher 的缓存键含 options）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'sources', 'sources.json');

const CONTENT_DQ = [
  '@js:',
  'var url = String(baseUrl);',
  'var m = url.match(/\\/books\\/(\\d+)\\/(\\d+)\\.html/);',
  'var out = "";',
  'if (m) {',
  '  var origin = url.match(/(https?:\\/\\/[^\\/]+)/)[1];',
  '  var H = JSON.stringify({ headers: { "X-Requested-With": "XMLHttpRequest", "Referer": url } });',
  '  var jsUrl = origin + "/scripts/chapter.js.php?aid=" + m[1] + "&cid=" + m[2] + "&referrer=" + encodeURIComponent(url);',
  '  var sc = String(java.ajax(jsUrl, H));',
  '  var tk = sc.match(/chapterToken\\s*=\\s*[\'\"]([^\'\"]+)[\'\"]/);',
  '  var ts = sc.match(/timestamp\\s*=\\s*[\'\"]?(\\d+)/);',
  '  var nc = sc.match(/nonce\\s*=\\s*[\'\"]?([0-9a-fA-F]+)/);',
  '  if (tk && ts && nc) {',
  '    var api = origin + "/modules/article/ajax2.php?aid=" + m[1] + "&cid=" + m[2] + "&token=" + tk[1] + "&timestamp=" + ts[1] + "&nonce=" + nc[1];',
  '    var res = String(java.ajax(api, H));',
  '    try { var j = JSON.parse(res); out = (j && j.data && j.data.content) ? j.data.content : ("<p>" + ((j && j.message) || res.slice(0,60)) + "</p>"); }',
  '    catch (e) { out = "<p>解析失败:" + res.slice(0,60) + "</p>"; }',
  '  } else { out = "<p>token 获取失败</p>"; }',
  '}',
  'result = out;',
].join('\n');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const suduguu = {
  bookSourceName: '速读谷',
  bookSourceGroup: '自定义',
  bookSourceType: 0,
  bookSourceUrl: 'https://www.suduguu.com',
  bookSourceComment: '速读谷（www.suduguu.com）。别名 sudugu.org / shudugu.org 均 301 到此站。长章节站方分页（-2/-3.html），用 nextContentUrl 自动续页。',
  enabled: true, enabledExplore: true, enabledCookieJar: true, customOrder: 0,
  concurrentRate: '1/1000',
  header: JSON.stringify({ 'User-Agent': UA, Referer: 'https://www.suduguu.com/' }),
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
  ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: {
    // 速读谷 .con 的首个 <p> 就是章节标题（页面 h1 也有），阅读器自己会显示标题，
    // 不去掉会变成「第1章 绯红 第1章 绯红 痛！…」。
    // `.con@html` 返回的是整个 <div class="con">…</div>（带外层标签），所以不能锚 `^`，
    // 用无锚的 <p> 匹配即可：正文段落不会以「第N章」开头，这是安全前提。
    content: '.con@html##<p>\\s*第[^<]{0,30}?[章回节][^<]*</p>',
    nextContentUrl: 'a[href*=下一页]@href',
    // ruleContent.replaceRegex 是【整章】全文替换（对齐 BookContent.kt:189-195），
    // 与上面 `##` 的区别见 src/engine/source.js 内注释。这里只写正则本体，不带 /g 定界符。
    replaceRegex: '速读谷|shudugu\\.org|sudugu\\.org',
  },
  ruleExplore: [
    { name: '玄幻', url: '/xuanhuan/' }, { name: '仙侠', url: '/xianxia/' },
    { name: '都市', url: '/dushi/' }, { name: '历史', url: '/lishi/' },
    { name: '军事', url: '/junshi/' }, { name: '科幻', url: '/kehuan/' },
    { name: '言情', url: '/yanqing/' }, { name: '排行榜', url: '/paihang/' },
    { name: '完结', url: '/wanjie/' }, { name: '最新更新', url: '/zuixin/' },
  ],
  ruleExplore_item: { bookList: '.list li.top li||.list li', name: 'p a@text||a@text', bookUrl: 'p a@href||a@href', coverUrl: 'img@src', author: '' },
  weight: 0,
  respondTime: 6000,
};

const deqixss = {
  bookSourceName: '得奇小说网',
  bookSourceGroup: '自定义',
  bookSourceType: 0,
  bookSourceUrl: 'https://www.deqixss.com',
  bookSourceComment: '得奇小说网（deqixss.com）。正文 AJAX + token，需 Referer + X-Requested-With 才放行。',
  enabled: true, enabledExplore: true, enabledCookieJar: true, customOrder: 0,
  concurrentRate: '1/1500',
  header: JSON.stringify({ 'User-Agent': UA, Referer: 'https://www.deqixss.com/' }),
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
    // 得奇「单结果搜索」会 302 到详情页 /books/N/，引擎走 bookList 兜底 → 必须靠这里解析。
    // 实测详情页类名：.booktitle / .booktag a / .bookintro / .bookcover img / a.bookchapter
    name: 'h1.booktitle@text||h1@text',
    author: '.booktag a[href*=author]@text||p a[href*=author]@text',
    kind: '.booktag span@text||.cat span@text',
    intro: 'p.bookintro@text||.intro@text',
    coverUrl: '.bookcover img@src||.bookimg img@src',
    tocUrl: '',
    lastChapter: 'a.bookchapter@text||#newchapter a@text',
  },
  ruleToc: {
    // 得奇目录容器是 div#list-chapterAll，内部是 <dd><a href="绝对URL">章名</a></dd>（没有 li！）
    chapterList: 'div#list-chapterAll dd',
    chapterName: 'a@text',
    chapterUrl: 'a@href',
  },
  ruleContent: { content: CONTENT_DQ, nextContentUrl: '', replaceRegex: '/得奇小说网|deqixss\\.com/g' },
  ruleExplore: [
    { name: '书库', url: '/sort/0/1.html' }, { name: '玄幻', url: '/sort/1/1.html' },
    { name: '都市', url: '/sort/2/1.html' }, { name: '仙侠', url: '/sort/3/1.html' },
    { name: '历史', url: '/sort/4/1.html' }, { name: '科幻', url: '/sort/5/1.html' },
    { name: '诸天无限', url: '/sort/6/1.html' }, { name: '悬疑', url: '/sort/7/1.html' },
    { name: '排行', url: '/top.html' },
  ],
  ruleExplore_item: { bookList: '.bookbox||.item', name: 'h4 a@text||a@text', bookUrl: 'h4 a@href||a@href', coverUrl: 'img@src', author: '' },
  weight: 0,
  respondTime: 8000,
};

const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const out = [];
// 丢掉所有 速读谷/得奇 旧条目（含无 www 的坏源、以及 yck 的别名重复项），再统一插入
for (const s of list) {
  const n = String(s.bookSourceName || '');
  const u = String(s.bookSourceUrl || '');
  const isSd = /速读谷/.test(n) || /suduguu/.test(u);
  const isDq = /得奇/.test(n) || /deqixs/.test(u);
  if (isSd || isDq) { console.log('移除旧条目: ' + n + ' @ ' + u); continue; }
  out.push(s);
}
out.push(suduguu, deqixss);
fs.writeFileSync(FILE, JSON.stringify(out, null, 2), 'utf8');
console.log('\n书源数 ' + list.length + ' -> ' + out.length);
console.log('已写入: ' + suduguu.bookSourceName + ' @ ' + suduguu.bookSourceUrl);
console.log('已写入: ' + deqixss.bookSourceName + ' @ ' + deqixss.bookSourceUrl);
