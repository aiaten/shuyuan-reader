'use strict';
/**
 * 「网页转书源」自动嗅探单测（不联网）。
 *
 * 两层覆盖：
 *   1. 纯函数：normalizeSiteUrl / findSearchForm / templateSearchUrl /
 *      itemSelectorSeg / looksLikeDetailPage / looksLikeChapterName /
 *      sniffBookList（主列表 vs 侧栏）/ deriveListItemRules（相对条目 + .0 消歧）
 *   2. generateSource 全链路：opts.fetchText 注入假站点（离线可跑），
 *      验证 POST+隐藏字段模板、探测关键词回退、正文红线拒收。
 */

const assert = require('assert');
const cheerio = require('cheerio');

const A = require('../src/source/autogen');

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('异步用例请用 at()');
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    fail++;
  }
}
async function at(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

/* ================= 假站点夹具（形似得奇/笔趣阁家族） ================= */

const HOME = `<!DOCTYPE html><html><head><title>魔卡小说网_无弹窗在线阅读</title></head>
<body>
<div class="header"><a href="/">首页</a> <a href="/sort/1/1.html">都市</a> <a href="/quanben/">完结小说</a></div>
<form id="searchform" action="/modules/article/search.php" method="post">
  <input type="hidden" name="action" value="login">
  <input type="hidden" name="searchtype" value="all">
  <input type="text" name="searchkey" placeholder="请输入搜索关键字">
  <input type="submit" value="搜索">
</form>
</body></html>`;

/** 三本结果，主列表容器故意命名成 fengtui（站点模板如此），另放一个侧栏推荐块 */
function listBox(id, name, author, chap) {
  return `  <div class="bookbox"><div class="bookinfo">
    <h4 class="bookname"><a href="/book/${id}.html">${name}</a></h4>
    <div class="author">作者：${author}</div>
    <div class="update">简介：${name}是一部测试作品，内容简介从这里开始，用于验证嗅探规则。</div>
    <div class="cat"><a href="/book/${id}/2${id}.html">${chap}</a></div>
  </div></div>`;
}
const LIST = `<!DOCTYPE html><html><head><title>搜索结果</title></head>
<body>
<div class="header"><a href="/">首页</a></div>
<div class="content book" id="fengtui">
  <h2 class="title">「都市」的搜索结果</h2>
${listBox(1001, '剑来', '烽火戏诸侯', '第1454章 不得不死')}
${listBox(1002, '诡秘之主', '爱潜水的乌贼', '第1430章 结束')}
${listBox(1003, '牧神记', '宅猪', '第1300章 成神')}
  <div class="clear"></div>
</div>
<div class="sidebar"><ul class="hot"><li><a href="/book/1001.html">剑来</a></li><li><a href="/book/1001.html">剑来</a></li><li><a href="/book/1001.html">剑来</a></li></ul></div>
</body></html>`;

const DETAIL = `<!DOCTYPE html><html><head>
<meta property="og:novel:book_name" content="剑来">
<meta property="og:novel:author" content="烽火戏诸侯">
<meta property="og:description" content="一个少年从故乡走出。">
<meta property="og:image" content="https://fake.test/img/1001.jpg">
<meta property="og:novel:category" content="都市">
<meta property="og:novel:latest_chapter_name" content="第1454章 不得不死">
<meta property="og:url" content="https://fake.test/book/1001.html">
<title>剑来_目录_魔卡小说网</title></head>
<body>
<div class="info"><h1>剑来</h1></div>
<dl class="listsection" id="list">
${Array.from({ length: 10 }, (_, i) => `  <dd><a href="/book/1001/200${i}.html">第${i + 1}章 初入江湖</a></dd>`).join('\n')}
</dl>
</body></html>`;

const CONTENT = `<!DOCTYPE html><html><head><title>第1章 初入江湖_魔卡小说网</title></head>
<body>
<div class="header"><a href="/">首页</a> <a href="/book/1001.html">剑来</a></div>
<div id="rtext" class="content">
<p>夜色深沉，窗外的雨淅淅沥沥地下着，他坐在书桌前，静静想着自己前世的种种经历。那些年的记忆如同走马灯一般在眼前浮现，让他唏嘘不已。</p>
<p>“又是一个轮回。”黑暗中传来的声音带着几分疲惫，也带着几分欣喜。他停下了脚步，并没有多说什么。有些事情不需要解释，也不需要辩解。</p>
<p>雨渐渐停了，天光即将放亮。他知道天亮之后又要上路，而这一次，他不会再回头。山那边的世界，正在等着他。</p>
</div>
<div class="page"><a href="/book/1001/2000_2.html">下一页</a></div>
</body></html>`;

/** AJAX 壳页：正文不在 HTML 里 → 必须触发生成红线 */
const CONTENT_SHELL = `<!DOCTYPE html><html><head><title>第1章_魔卡小说网</title></head>
<body>
<div id="rtext"><script>loadChapter();</script>加载中，请稍候…</div>
<div class="footer"><a href="/">首页</a></div>
</body></html>`;

/** 无结果页（关键词太短被拒） */
const NOHIT = `<!DOCTYPE html><html><head><title>搜索结果</title></head><body><div class="tips">对不起，未找到相关内容，请更换关键字重试。</div></body></html>`;

function makeFetcher(map, opts = {}) {
  const calls = [];
  const fn = async (url, o = {}) => {
    const method = (o.method || 'GET').toUpperCase();
    calls.push({ url, method, body: o.body || '' });
    const key = `${method} ${url}`;
    if (map[key]) return { status: 200, headers: {}, url, text: map[key] };
    if (map[url] && (o.method || 'GET').toUpperCase() === 'GET') return { status: 200, headers: {}, url, text: map[url] };
    if (opts.failKey === key) { const e = new Error('socket hang up'); throw e; }
    return { status: 404, headers: {}, url, text: '<html><head><title>404 Not Found</title></head><body></body></html>' };
  };
  fn.calls = calls;
  return fn;
}

/* ================= 1. 纯函数 ================= */

console.log('\n[1] 网址归一化 / 搜索表单');

t('normalizeSiteUrl 补协议、只留站点根', () => {
  assert.strictEqual(A.normalizeSiteUrl('fake.test'), 'https://fake.test');
  assert.strictEqual(A.normalizeSiteUrl('https://fake.test/'), 'https://fake.test');
  assert.strictEqual(A.normalizeSiteUrl('http://x.com/book/1.html'), 'http://x.com');
  assert.strictEqual(A.normalizeSiteUrl(''), '');
});

t('findSearchForm 抓到参数名与全部隐藏字段', () => {
  const $ = cheerio.load(HOME);
  const f = A.findSearchForm($, 'https://fake.test');
  assert.ok(f, '应找到表单');
  assert.strictEqual(f.param, 'searchkey');
  assert.strictEqual(f.method, 'post');
  assert.strictEqual(f.action, 'https://fake.test/modules/article/search.php');
  assert.deepStrictEqual(f.hidden, { action: 'login', searchtype: 'all' });
});

t('findSearchForm 跳过登录表单', () => {
  const $ = cheerio.load(`<html><body>
    <form action="/login"><input name="username"><input type="password" name="pwd"><input type="submit"></form>
    <form action="/s" method="get"><input name="q"><input type="submit"></form>
  </body></html>`, null, false);
  const f = A.findSearchForm($, 'https://fake.test');
  assert.strictEqual(f.param, 'q');
  assert.strictEqual(f.action, 'https://fake.test/s');
});

console.log('\n[2] 模板与判定');

t('templateSearchUrl GET：静态参数保留、试探词换成 {{key}}', () => {
  const s = A.templateSearchUrl(
    { method: 'GET', url: 'https://fake.test/s.php?q=1&searchkey=%E5%89%91', kw: '剑' },
    'searchkey'
  );
  assert.strictEqual(s, '/s.php?q=1&searchkey={{key}}');
});

t('templateSearchUrl POST：隐藏字段留在 body，选项串是合法 JSON', () => {
  const s = A.templateSearchUrl(
    { method: 'POST', url: 'https://fake.test/modules/article/search.php?a=1', body: 'action=login&searchtype=all&searchkey=%E9%83%BD%E5%B8%82', kw: '都市' },
    'searchkey'
  );
  assert.ok(s.startsWith('/modules/article/search.php?a=1,'), s);
  const opt = JSON.parse(s.slice(s.indexOf(',') + 1));
  assert.strictEqual(opt.method, 'POST');
  assert.strictEqual(opt.body, 'action=login&searchtype=all&searchkey={{key}}');
});

t('templateSearchUrl POST：body 里没匹配到试探词时追加 {{key}}', () => {
  const s = A.templateSearchUrl(
    { method: 'POST', url: 'https://fake.test/s', body: 'x=1', kw: '都市' },
    'searchkey'
  );
  const opt = JSON.parse(s.slice(s.indexOf(',') + 1));
  assert.strictEqual(opt.body, 'x=1&searchkey={{key}}');
});

t('looksLikeDetailPage：有 og 元数据即书页', () => {
  assert.strictEqual(A.looksLikeDetailPage(cheerio.load(DETAIL)), true);
  assert.strictEqual(A.looksLikeDetailPage(cheerio.load(LIST)), false);
  assert.strictEqual(A.looksLikeDetailPage(cheerio.load(HOME)), false);
});

t('looksLikeChapterName 基本判定', () => {
  assert.strictEqual(A.looksLikeChapterName('第1454章 不得不死'), true);
  assert.strictEqual(A.looksLikeChapterName('第一百二十回 贾元素'), true);
  assert.strictEqual(A.looksLikeChapterName('都市'), false);
});

t('itemSelectorSeg 滤掉工具类', () => {
  const $ = cheerio.load('<div class="bookbox clearfix"></div>');
  assert.strictEqual(A.itemSelectorSeg($('div').get(0), 'div.bookbox.clearfix'), 'div.bookbox');
});

console.log('\n[3] 列表嗅探与条目规则');

t('sniffBookList 选主列表而不是侧栏（即便主容器 id 叫 fengtui）', () => {
  const $ = cheerio.load(LIST);
  const cont = A.sniffBookList($, 'https://fake.test/modules/article/search.php');
  assert.ok(cont, '应找到列表容器');
  assert.strictEqual(cont.containerSel, 'div#fengtui');
  assert.strictEqual(cont.itemSel, 'div.bookbox');
  assert.strictEqual(cont.itemCount, 3);
});

t('deriveListItemRules：bookList=容器+条目，字段全部相对条目', () => {
  const $ = cheerio.load(LIST);
  const baseUrl = 'https://fake.test/modules/article/search.php';
  const cont = A.sniffBookList($, baseUrl);
  const rule = A.deriveListItemRules($, baseUrl, cont);
  assert.strictEqual(rule.bookList, 'div#fengtui div.bookbox');
  assert.ok(/h4\.bookname > a@text$/.test(rule.name), rule.name);
  assert.ok(/h4\.bookname > a@href$/.test(rule.bookUrl), rule.bookUrl);
  assert.ok(rule.author.endsWith('@text##作者[:：]'), rule.author);
  assert.ok(rule.intro.includes('简介[:：]'), rule.intro);
  assert.ok(rule.lastChapter && /div\.cat > a@text$/.test(rule.lastChapter), rule.lastChapter);
});

t('deriveListItemRules：条目内多命中时末段加 .0', () => {
  const html = `<html><body><div id="box">
    <div class="it"><h4><a href="/b/1.html">书名甲</a></h4><div class="author">作者：甲</div><div class="author">阅读量：532</div></div>
    <div class="it"><h4><a href="/b/2.html">书名乙</a></h4><div class="author">作者：乙</div><div class="author">阅读量：118</div></div>
  </body></html>`;
  const $ = cheerio.load(html);
  const cont = A.sniffBookList($, 'https://fake.test/s');
  assert.ok(cont, '应找到列表容器');
  const rule = A.deriveListItemRules($, 'https://fake.test/s', cont);
  assert.ok(/div\.author\.0@text/.test(rule.author), rule.author);
});

console.log('\n[3b] m12537 三站修复回归（selectorOf/sniffToc/JS模板/分组key）');

t('chapterOrdinal / cn2num 解析', () => {
  assert.strictEqual(A.chapterOrdinal('第123章 打开新世界的大门'), 123);
  assert.strictEqual(A.chapterOrdinal('第一千二百三十四章 剑'), 1234);
  assert.strictEqual(A.chapterOrdinal('第689章　挑选人手'), 689);
  assert.strictEqual(A.chapterOrdinal('引子'), null);
  assert.strictEqual(A.cn2num('二百五'), 250);
});

t('selectorOf 不产出假直接子（中间隔层的祖先退回后代组合）', () => {
  const html = `<html><body><div id="biqunaicc"><div class="row row-detail"><div class="layout layout-col1"><a href="/x">1</a></div></div></div></body></html>`;
  const $ = cheerio.load(html);
  const el = $('div.layout-col1').get(0);
  const sel = A.selectorOf($, el);
  assert.ok($(sel).length >= 1, `选择器必须能命中自身：${sel}`);
  assert.ok(!/#biqunaicc\s*>\s*div\.layout/.test(sel), `祖先非真父时不得用 > 直连：${sel}`);
});

t('jsFormTemplates 从内联脚本的 document.write 模板里找表单（redan/笔趣阁壳族）', () => {
  const html = `<html><body><div id="sb"></div><script>function search(){ document.write('<form action="/user/search.html" method="get"><input type="text" name="q" /></form>'); }</script></body></html>`;
  const $ = cheerio.load(html);
  assert.strictEqual($('form').length, 0, '静态 DOM 里确实没有表单');
  const out = A.jsFormTemplates($);
  assert.ok(out.length >= 1, '应从模板串解析出表单');
  assert.strictEqual(out[0].param, 'q');
  assert.strictEqual(out[0].method, 'get');
});

t('sniffToc 主导目录分组：少量异目录链接不再砍死前缀（redan 判决）', () => {
  const real = Array.from({ length: 20 }, (_, i) => `  <dd><a href="/novel/2607/${1680000 + i}.html">第${i + 1}章 标题${i}</a></dd>`).join('\n');
  const nav = ['/', '/rank.html', '/top.html', '/author/x', '/category/y', '/', '/z/w', '/u/v', '/a/b', '/c/d']
    .map((h) => `  <dd><a href="${h}">导航或推荐位文字不超长的</a></dd>`).join('\n');
  const html = `<html><body><dl class="book">\n${real}\n${nav}\n</dl></body></html>`;
  const $ = cheerio.load(html);
  const r = A.sniffToc($, 'https://fake.test/novel/2607/');
  assert.ok(r, '20 条同目录章链必须成组（旧 commonPrefix 版会误拒）');
  assert.ok(r.inChapter >= 20, `主导目录内章链数应≥20，实为 ${r.inChapter}`);
  assert.ok(/(^|\s)dd$/.test(r.itemSel) || r.itemSel.endsWith('dd'), `条目应落在 dd 层：${r.itemSel}`);
});

t('sniffToc 条目落在父签名层而不是容器层（bqg52 的 119 吞 li 判决）', () => {
  const lis = Array.from({ length: 40 }, (_, i) => `<li><div class="f"><a href="/book/492339/${180315300 + i}.html">第${i + 1}章 标题</a></div></li>`).join('');
  const html = `<html><body><div id="biqunaicc"><div class="row row-section"><ul class="section-list fix ycxsid">${lis}</ul></div></div></body></html>`;
  const $ = cheerio.load(html);
  const r = A.sniffToc($, 'https://fake.test/book/492339/');
  assert.ok(r, '应识别出目录');
  assert.ok(r.itemSel.endsWith('li'), `条目选择器必须到 li 层，实为 ${r.itemSel}`);
  assert.ok(!/ul[^ ]*$/.test(r.itemSel), `不能停在 ul 容器层：${r.itemSel}`);
});

t('sniffBookList 无 class 条目分组 key 不带尾点（li. 非法 CSS 判决）', () => {
  const items = Array.from({ length: 4 }, (_, i) => `<li><h3><a href="/b/${i + 1}.html">书名${i}</a></h3><div>作者：某某</div><p>简介文字要超过二十个字这样才能够被识别为简介内容。</p></li>`).join('');
  const html = `<html><body><div class="content"><ul class="booklist">${items}</ul></div></body></html>`;
  const $ = cheerio.load(html);
  const cont = A.sniffBookList($, 'https://fake.test/s');
  assert.ok(cont, '应找到列表容器');
  assert.strictEqual(cont.itemSel, 'li', '无 class 的条目选择器不能是 "li."');
  const rule = A.deriveListItemRules($, 'https://fake.test/s', cont);
  assert.ok(!rule.bookList.endsWith('.'), `bookList 不能以点结尾：${rule.bookList}`);
});

/* ================= 4. generateSource 全链路（假站点） ================= */

console.log('\n[4] generateSource 全链路（fetchText 注入，不联网）');

async function mainFlow() {
  await at('正常站：搜索(POST+隐藏字段)→列表→详情→目录→正文 → 生成完整书源', async () => {
    const map = {
      'https://fake.test/': HOME,
      'POST https://fake.test/modules/article/search.php': LIST,
      'https://fake.test/book/1001.html': DETAIL,
      'https://fake.test/book/1001/2000.html': CONTENT,
    };
    const fetchText = makeFetcher(map);
    const r = await A.generateSource('fake.test', { fetchText });
    assert.strictEqual(r.ok, true, `应成功：${r.error || ''} steps=${JSON.stringify(r.steps)}`);
    const s = r.source;
    assert.strictEqual(s.bookSourceUrl, 'https://fake.test');
    assert.ok(s.bookSourceName, '站点名非空');
    assert.ok(s.searchUrl.includes('searchkey={{key}}'), s.searchUrl);
    assert.ok(s.searchUrl.includes('action=login'), '隐藏字段必须留在模板里：' + s.searchUrl);
    assert.strictEqual(s.ruleSearch.bookList, 'div#fengtui div.bookbox');
    assert.strictEqual(s.ruleToc.chapterList, 'dl#list dd');
    assert.strictEqual(s.ruleContent.content, 'div#rtext@html');
    assert.strictEqual(s.ruleContent.nextContentUrl, 'a:contains(下一页)@href');
    assert.ok(Array.isArray(s.ruleExplore) && s.ruleExplore.length >= 1);
    // 嗅探真实发出的那次 POST：隐藏字段 + 默认关键词都带上
    const post = fetchText.calls.find((c) => c.method === 'POST');
    assert.ok(post, '应有 POST 尝试');
    assert.ok(post.body.includes('action=login') && post.body.includes('searchtype=all'), post.body);
    assert.ok(post.body.includes(`searchkey=${encodeURIComponent('都市')}`), post.body);
  });

  await at('正文 AJAX 壳页：红线拒收且给出 partial 规则', async () => {
    const map = {
      'https://fake.test/': HOME,
      'POST https://fake.test/modules/article/search.php': LIST,
      'https://fake.test/book/1001.html': DETAIL,
      'https://fake.test/book/1001/2000.html': CONTENT_SHELL,
    };
    const r = await A.generateSource('https://fake.test', { fetchText: makeFetcher(map) });
    assert.strictEqual(r.ok, false);
    assert.ok(/动态加载/.test(r.error), r.error);
    assert.strictEqual(r.source, null);
    assert.ok(r.partial && r.partial.tocRule && r.partial.listRule, '应回传已嗅到的规则');
    const contentStep = r.steps.find((x) => x.name === '识别正文');
    assert.ok(contentStep && contentStep.ok === false);
  });

  await at('默认关键词无结果：回退备选词并写入 notes', async () => {
    const list2 = LIST.replace('「都市」的搜索结果', '「剑」的搜索结果');
    const calls = [];
    const fetchText = async (url, o = {}) => {
      const method = (o.method || 'GET').toUpperCase();
      const body = o.body || '';
      calls.push({ url, method, body });
      if (url === 'https://fake.test/') return { status: 200, headers: {}, url, text: HOME };
      if (method === 'POST' && url.endsWith('/modules/article/search.php')) {
        const text = body.includes(encodeURIComponent('都市')) ? NOHIT : list2;
        return { status: 200, headers: {}, url, text };
      }
      if (url === 'https://fake.test/book/1001.html') return { status: 200, headers: {}, url, text: DETAIL };
      if (url === 'https://fake.test/book/1001/2000.html') return { status: 200, headers: {}, url, text: CONTENT };
      return { status: 404, headers: {}, url, text: '<html><head><title>404</title></head></html>' };
    };
    const r = await A.generateSource('https://fake.test', { fetchText });
    assert.strictEqual(r.ok, true, `应成功：${r.error || ''}`);
    assert.ok(r.notes.some((n) => n.includes('备选关键词')), JSON.stringify(r.notes));
    assert.ok(r.source.searchUrl.includes('searchkey={{key}}'), r.source.searchUrl);
    const hit = calls.find((c) => c.method === 'POST' && !c.body.includes(encodeURIComponent('都市')));
    assert.ok(hit, '应发起过备选词 POST');
  });

  await at('站点完全不可达：报错在首页步骤', async () => {
    const fetchText = async () => { throw new Error('ECONNREFUSED'); };
    const r = await A.generateSource('https://fake.test', { fetchText });
    assert.strictEqual(r.ok, false);
    assert.ok(/站点无法访问/.test(r.error), r.error);
    assert.strictEqual(r.steps[0].name, '首页可达');
    assert.strictEqual(r.steps[0].ok, false);
  });

  await at('非法网址：不进流程直接报错', async () => {
    const r = await A.generateSource('', { fetchText: async () => ({ status: 200, text: '' }) });
    assert.strictEqual(r.ok, false);
    assert.ok(/不是合法的网址/.test(r.error), r.error);
  });
}

/* ================= 5. m12537 修复的全链路用例（目录分页/杂质/清洗/引擎重排） ================= */

async function extraFlow() {
  await at('假 bqg52 家族：目录分页+杂质跳过+非升序 sortByOrdinal+正文清洗全进规则', async () => {
    const dd = (i) => `  <dd><a href="/book/1001/${3000 + i}.html">第${i}章 标题${i}</a></dd>`;
    const junk = [
      '  <dd><a href="/book/1001/9999.html">最新章节：第120章 新</a></dd>',
      '  <dd><a href="/book/1001/9998.html">【在百度搜索某书】</a></dd>',
      '  <dd><a href="/book/1001/9997.html">【某书TXT全集下载】</a></dd>',
    ];
    const DETAIL5 = `<!DOCTYPE html><html><head>
<meta property="og:novel:book_name" content="某书">
<meta property="og:novel:author" content="甲">
<title>某书_目录</title></head><body>
<dl id="toc">
${Array.from({ length: 30 }, (_, i) => `  <dd><a href="/book/1001/${2000 + i}.html">第${i + 1}章 标题${i + 1}</a></dd>`).join('\n')}
</dl>
<a href="/book/1001/my1.html">更多章节...</a>
</body></html>`;
    const MY5 = `<!DOCTYPE html><html><head><title>某书目录</title></head><body>
<div id="biqunaicc"><div class="row row-section">
<dl class="toc2">
${junk.join('\n')}
${Array.from({ length: 115 }, (_, i) => dd(i + 1)).join('\n')}
  <dd><a href="/book/1001/3999.html">第120章 大结局</a></dd>
  <dd><a href="/book/1001/3998.html">第119章 转折</a></dd>
</dl>
<a href="/book/1001/my2.html">下一页</a>
</div></div>
</body></html>`;
    const para = '夜色深沉，他坐在书桌前，想着前世的经历。';
    const CONTENT5 = `<!DOCTYPE html><html><head><title>第1章</title></head><body>
<div id="rtext">
<p>好看的小说 > 介绍 > 某书 返回目录</p>
<p>加入书签 推荐本书</p>
<p>　　（第1页）</p>
<p>${para.repeat(16)}</p>
</div>
</body></html>`;
    const map = {
      'https://fake.test/': HOME,
      'POST https://fake.test/modules/article/search.php': LIST,
      'https://fake.test/sort/1/1.html': LIST,
      'https://fake.test/book/1001.html': DETAIL5,
      'https://fake.test/book/1001/my1.html': MY5,
    };
    map['https://fake.test/book/1001/3001.html'] = CONTENT5;
    const r = await A.generateSource('fake.test', { fetchText: makeFetcher(map) });
    assert.strictEqual(r.ok, true, `应成功：${r.error || ''} steps=${JSON.stringify(r.steps)}`);
    const s = r.source;
    assert.strictEqual(s.ruleBookInfo.tocUrl, 'text.更多章节@href', `尾部假省略号必须剥掉：${s.ruleBookInfo.tocUrl}`);
    assert.strictEqual(s.ruleToc.nextTocUrl, 'text.下一页@href');
    assert.strictEqual(s.ruleToc.sortByOrdinal, true, '混序目录要启用引擎重排');
    assert.ok(/:nth-of-type\(n\+4\)/.test(s.ruleToc.chapterList), `杂质块要被跳过：${s.ruleToc.chapterList}`);
    assert.ok(/dd(:|\b)/.test(s.ruleToc.chapterList) && /(div#biqunaicc|dl\.toc2)/.test(s.ruleToc.chapterList), `chapterList 应落在 dd 条目层：${s.ruleToc.chapterList}`);
    const rr = String(s.ruleContent.replaceRegex || '');
    assert.ok(rr.includes('加入书签'), `书签词清洗缺失：${rr}`);
    assert.ok(rr.includes('\\\\s>\\\\s') || rr.includes('\\s>\\s'), `面包屑 > 结构清洗缺失：${rr}`);
    assert.ok(/第\\s\*\\d\+\\s\*页/.test(rr), `（第N页）清洗缺失：${rr}`);
    assert.ok(r.steps.some((x) => x.name === '目录分页' && x.ok), '应有目录分页步骤');
  });

  await at('引擎 sortByOrdinal：混序目录按章号稳定重排（解析不了的跟随前值）', async () => {
    const { SourceEngine } = require('../src/engine/source.js');
    const names = ['第5章 戊', '第3章 丙', '第4章 丁', '第1章 甲', '番外 乙'];
    const html = `<html><body><dl>${names.map((n, i) => `<dd><a href="/b/1/${i}.html">${n}</a></dd>`).join('')}</dl></body></html>`;
    const eng = new SourceEngine({
      bookSourceName: 'x', bookSourceUrl: 'https://fake.test',
      ruleToc: { chapterList: 'dl dd', chapterName: 'a@text', chapterUrl: 'a@href', sortByOrdinal: true },
    });
    eng._fetch = async (url) => ({ status: 200, headers: { 'content-type': 'text/html;charset=utf-8' }, url, text: html });
    const toc = await eng.toc('https://fake.test/b/1/');
    assert.deepStrictEqual(toc.map((t) => t.name), ['第1章 甲', '番外 乙', '第3章 丙', '第4章 丁', '第5章 戊']);
  });
}

mainFlow().then(extraFlow).then(() => {
  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
});
