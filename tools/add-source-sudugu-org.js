/**
 * 落库：速读谷（www.sudugu.cc）
 *
 * 背景：书源库里的速读谷条目已被删除，本次按用户要求重新添加。
 *
 * 站点实测（2026-10-15）：
 * - www.sudugu.org / www.suduguu.com **均已废弃**：.org 恒返回 HTTP 500（连 /favicon.ico 也 500，
 *   是站点级故障）；.com 连接超时。**www.sudugu.cc 是当前唯一存活域名**（200）。
 * - 站点已从 ASP.NET（/i/sor.aspx、/xuanhuan/）**整体换成杰奇 CMS**：
 *   分类页 /fenlei/{分类id}/{页码}/、书籍页 /{bookid}/、章节页 /{bookid}/{chapterid}.html
 * - 搜索：**POST** /modules/article/search.php，参数 searchkey（表单 method="post"）。
 *   单结果时站点 302 跳到书籍页 /4291/（引擎已有 302 落点修复，能正确处理）。
 * - 分类页与页面顶栏均使用 `<div class="item">` 作为条目容器（注意：书籍详情页里
 *   这个 item 是「书籍信息卡片」，不是搜索条目，所以 ruleBookInfo 不能拿它当容器）。
 * - 目录：`div#list ul li a`（实测 301 个 li，章节链接是绝对 URL）。
 * - 正文：`div.con`；**站方分页** /4291/3915511.html → /4291/3915511_2.html（用 nextContentUrl 续页）。
 * - 详情页 h1 是 `<h1><i>字数</i><a href="/4291/#dir">书名</a></h1>` → name 用 `h1 a@text`。
 * - 详情页书籍元信息字面量（实测片段）：
 *     <div class="itemtxt"><h1>…</h1><p><span>连载中</span><span>玄幻小说</span></p>
 *     <p><a href="…/modules/article/authorarticle.php?author=…">无用一书生</a>…</p>
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'sources', 'sources.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sudugu = {
  bookSourceName: '速读谷',
  bookSourceGroup: '自定义',
  bookSourceType: 0,
  bookSourceUrl: 'https://www.sudugu.cc',
  bookSourceComment:
    '速读谷当前域名 www.sudugu.cc（.org 与 .com 均已废弃：.org 恒 500、.com 超时）。' +
    '站点是杰奇 CMS：搜索走 POST /modules/article/search.php?searchkey=，单结果会 302 跳书籍页；' +
    '分类 /fenlei/{id}/{page}/，书籍 /{id}/，章节 /{id}/{cid}.html。' +
    '正文章节站方分页（_2.html），用 nextContentUrl 自动续页。',
  enabled: true,
  enabledExplore: true,
  enabledCookieJar: true,
  customOrder: 0,
  concurrentRate: '1/1000',
  header: JSON.stringify({ 'User-Agent': UA, Referer: 'https://www.sudugu.cc/' }),
  // 表单是 method="post"、input name="searchkey"；引擎会在 {{key}} 出现在 searchUrl 时按表单提交
  searchUrl: '/modules/article/search.php?searchkey={{key}}',
  ruleSearch: {
    bookList: '.item',
    // 搜索结果条目里书名在 h1 > a（与分类页的 h3 a 不同，用 || 兜底两种）
    name: 'h1 a@text||h3 a@text',
    author: 'p a[href*=author]@text||p a[href*=zuozhe]@text',
    kind: 'p span@text',
    intro: '',
    coverUrl: 'img@src',
    bookUrl: 'h1 a@href||h3 a@href',
    lastChapter: 'ul li a@text',
  },
  ruleBookInfo: {
    // 实测 h1 内是 <i>字数</i><a>书名</a>，必须取 a 的文本，否则书名带字数
    name: 'h1 a@text||h1@text',
    author: 'p a[href*=author]@text||p a[href*=zuozhe]@text',
    kind: 'p span@text',
    intro: '#dir@text||.des@text||.intro@text',
    coverUrl: 'img@src',
    tocUrl: '',
    lastChapter: 'ul li a@text',
    wordCount: 'h1 i@text',
  },
  ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: {
    // .con 里首段重复了章节标题（页面 h1 也有），阅读器自己会显示标题，不去掉会重复。
    // `.con@html` 返回整个带外层标签的 div，所以不能锚 ^，用无锚 <p> 匹配。
    content: '.con@html##<p>\\s*第[^<]{0,30}?[章回节][^<]*</p>',
    // 分页链接：<span><a href="/4291/3915511_2.html">下一页</a></span>
    // 「下一页」是元素【文本】不是 href 片段，必须用 :contains()。
    nextContentUrl: 'a:contains(下一页)@href',
    // 整章全文替换（对齐 BookContent.kt:189-195），只写正则本体，不带 /g
    replaceRegex: '速读谷|shudugu\\.org|suduguu\\.com|sudugu\\.org|sudugu\\.cc',
  },
  ruleExplore: [
    { name: '玄幻', url: '/fenlei/1/1/' },
    { name: '仙侠', url: '/fenlei/2/1/' },
    { name: '都市', url: '/fenlei/3/1/' },
    { name: '历史', url: '/fenlei/4/1/' },
    { name: '军事', url: '/fenlei/5/1/' },
    { name: '科幻', url: '/fenlei/6/1/' },
    { name: '网游', url: '/fenlei/7/1/' },
    { name: '最新更新', url: '/top/lastupdate/1.html' },
    { name: '全本', url: '/quanben/1.html' },
  ],
  ruleExplore_item: {
    bookList: '.item',
    name: 'h3 a@text||h1 a@text||p a@text||a@text',
    bookUrl: 'h3 a@href||h1 a@href||p a@href||a@href',
    coverUrl: 'img@src',
    author: 'p a[href*=author]@text||p a[href*=zuozhe]@text',
  },
  weight: 0,
  respondTime: 8000,
};

const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const out = [];
for (const s of list) {
  const n = String(s.bookSourceName || '');
  const u = String(s.bookSourceUrl || '');
  // 清掉所有旧速读谷（含别名域名版本），再统一插入
  if (/速读谷/.test(n) || /sudugu/i.test(u)) {
    console.log('移除旧条目: ' + n + ' @ ' + u);
    continue;
  }
  out.push(s);
}
out.push(sudugu);
fs.writeFileSync(FILE, JSON.stringify(out, null, 2), 'utf8');
console.log('\n书源数 ' + list.length + ' -> ' + out.length);
console.log('已写入: ' + sudugu.bookSourceName + ' @ ' + sudugu.bookSourceUrl);
