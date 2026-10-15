/**
 * 落库：速读谷（www.sudugu.org）
 *
 * 背景：书源库里的速读谷条目已被删除，本次按用户指定的 www.sudugu.org 重新添加。
 *
 * 站点实测（2026-10）：
 * - www.sudugu.org 301 → www.suduguu.com（同一站点，但 bookSourceUrl 用用户指定的 .org）
 * - ⚠️ **搜索接口已坏**：/i/sor.aspx 恒返回 HTTP 500「运行时错误」，
 *   带 key / 不带 key / GET / POST / 大小写变体 / 带 Referer 全部 500。
 *   搜索页 /i/so.aspx 的表单 action 仍指向 sor.aspx（服务端脚本报错，非我方请求问题）。
 *   ⇒ searchUrl 仍按站点真实表单填写（站点修好后立即恢复可用），
 *     但**不能依赖 search**。可读性闸门是 reach && (search||explore) && toc，
 *     所以本源的 Explore（分类页）是主入口 —— 实测分类页结构完好。
 * - ✅ 可用链路（全实测通过）：分类页 /xuanhuan/ → 详情页 /{id}/ → 目录（1039 章）→ 正文页
 * - 正文章节有分页：/{id}/{cid}.html → /{id}/{cid}-2.html（用 nextContentUrl 自动续页）
 * - 详情页 h1 结构：<h1><i>585.4万字</i><a href="/1666/#dir">大荒剑帝</a></h1>
 *   → name 规则用 `h1 a@text`（直接取 h1 会把字数带进来）
 * - 分类页与搜索页的结果项结构一致：`.item` + `h3 a`
 * - 排行榜/完结页（/paihang/、/wanjie/）没有 h3，只有 .item → 这两项 Explore 的
 *   ruleExplore_item 兜底用 `a@text`/`a@href`，靠 `||` 分隔符生效。
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
  bookSourceUrl: 'https://www.sudugu.org',
  bookSourceComment:
    '速读谷（www.sudugu.org，301 到 suduguu.com）。注意：站点搜索接口 /i/sor.aspx 当前恒 500（服务端故障，' +
    '带不带 key 都一样），所以搜索暂时不可用；但分类浏览（Explore）全链路正常，可通过分类页找书并整本下载。' +
    '正文章节站方分页（-2.html），用 nextContentUrl 自动续页。',
  enabled: true,
  enabledExplore: true,
  enabledCookieJar: true,
  customOrder: 0,
  concurrentRate: '1/1000',
  header: JSON.stringify({ 'User-Agent': UA, Referer: 'https://www.sudugu.org/' }),
  // 站点表单真实 action 是相对于 /i/ 的 sor.aspx，参数名 key。
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
    // 实测 h1 内是 <i>字数</i><a>书名</a>，必须取 a 的文本，否则书名带字数
    name: 'h1 a@text||h1@text',
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
    // .con 的首个 <p> 是章节标题（页面 h1 也有），阅读器自己会显示标题，
    // 不去掉会变成「第1章 xx 第1章 xx 痛！…」。
    // `.con@html` 返回整个 <div class="con">…</div>（带外层标签），所以不能锚 ^，
    // 用无锚的 <p> 匹配：正文段落不会以「第N章」开头，这是安全前提。
    content: '.con@html##<p>\\s*第[^<]{0,30}?[章回节][^<]*</p>',
    // ⚠️ 分页链接长这样：<div class="prenext">…<span><a href="/1666/435178-2.html">下一页</a></span></div>
    // 「下一页」是元素【文本】，不是 href 的一部分，所以必须用 :contains()，
    // 写成 a[href*=下一页] 永远命中 0 个（实测过，pageCount 会恒为 1，后半章丢失）。
    nextContentUrl: 'a:contains(下一页)@href',
    // 整章全文替换（对齐 BookContent.kt:189-195），只写正则本体，不带 /g
    replaceRegex: '速读谷|shudugu\\.org|suduguu\\.com|sudugu\\.org',
  },
  ruleExplore: [
    { name: '玄幻', url: '/xuanhuan/' },
    { name: '仙侠', url: '/xianxia/' },
    { name: '都市', url: '/dushi/' },
    { name: '历史', url: '/lishi/' },
    { name: '军事', url: '/junshi/' },
    { name: '科幻', url: '/kehuan/' },
    { name: '言情', url: '/yanqing/' },
    { name: '最新更新', url: '/zuixin/' },
    { name: '排行榜', url: '/paihang/' },
    { name: '完结', url: '/wanjie/' },
  ],
  // 分类/最新页是 <h3><a>；排行榜与完结页只有 .item 下的 a，用 || 兜底
  ruleExplore_item: {
    bookList: '.item',
    name: 'h3 a@text||p a@text||a@text',
    bookUrl: 'h3 a@href||p a@href||a@href',
    coverUrl: 'img@src',
    author: '',
  },
  weight: 0,
  respondTime: 6000,
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
