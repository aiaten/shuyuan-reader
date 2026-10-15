/**
 * 生成并导入两个笔趣阁系书源：笔趣阁52（m.bqg52.com）与笔趣阁（www.redan.cc）
 * 由「网页转书源」嗅探生成后固化，供干净数据目录一键复现（2026-10-15 实测入库，探测闸门 score=100 通过）。
 *
 * 站点逆向结论（三站排障记录）：
 *
 * 【笔趣阁52 m.bqg52.com】
 *   - 搜索：POST /search.html 参数 s —— 但 302 → /login.html（登录墙），静态书源不可用；
 *     找书走 ruleExplore 分类入口。
 *   - 详情页目录只列前 112 章 + 12 条「最新章节」捷径块；完整目录在 /book/<id>/my1.html
 *     分页（my1..my7，「下一页」a.y）。→ ruleBookInfo.tocUrl + ruleToc.nextTocUrl。
 *   - 「查看更多章节」按钮的省略号是 CSS ::after 画的，DOM 文本只有前 6 字
 *     → tocUrl 用 text.查看更多章节@href（生成器自动剥尾部 ….。等标点）。
 *   - 目录混序（689..682 降序头 + 101..200 升序主体 + 1..6 尾块）
 *     → ruleToc.sortByOrdinal:true，引擎 toc() 按章节序号稳定重排。
 *   - 正文 div.word_read；长章节站方分页 → nextContentUrl 续页 + replaceRegex 清洗
 *     「上一章…下一章」「（第N页）」行。
 *   - 站点偶发返回「请勿开启浏览器阅读模式」空壳章（同一 URL 有时有全文）——站方反爬间歇，非书源问题，
 *     重读该章即可；嗅探生成器已改为多章采样取最长正文，避免被空壳章骗到正文红线。
 *
 * 【笔趣阁 www.redan.cc】
 *   - 搜索：表单由外链 /js/common.js 的 document.write('<form action="/user/search.html">…') 注入；
 *     /user/search.html?q= 页面结果靠 POST /api/search（带 31 个混淆 var + sign 人机参数），
 *     完整复刻仍回「搜索太频繁」（IP 限流，与 7054 同家族）→ 找书走 ruleExplore 分类入口。
 *   - 详情目录 dl.book dd：前 3 项为杂质（最新章节：…／【在百度搜索…】／【…TXT下载】）
 *     → chapterList 自动加 dd:nth-of-type(n+4) 跳过；余 1174 章正序（引子…第1183章）。
 *   - 正文 div#box；页尾随机轮换「加入书签/推荐本书/打开书架/报告错误/返回目录…」及面包屑
 *     「xxx > yyy > zzz」行 → replaceRegex 行级清洗 + 「[^\n]*\s>\s[^\n]*」结构剥。
 *   - UTF-8。
 *
 * 【www.bqg711.cc】不随本脚本入库：SPA 壳站——章节页 302 /user/verify.html → /userverify
 * 轮换镜像域名（bqg308.xyz/bqg371.cc…）且 book id 被翻译；正文 API 参数 AES 加密
 * （read.js get_api: encodeURIComponent(enaes(JSON.stringify(params)))），静态规则无法生成正文，
 * 「网页转书源」按红线正确拒收。同类书请用书内 ryw笔趣阁78 / 📖笔趣阁 / 新笔趣阁 等源。
 */

const fs = require('fs');
const path = require('path');

const sources = [
  {
    "bookSourceName": "笔趣阁52（m.bqg52.com）",
    "bookSourceGroup": "自动生成",
    "bookSourceType": 0,
    "bookSourceUrl": "https://m.bqg52.com",
    "bookSourceComment": "由「网页转书源」自动生成（2026-10-15）。搜索是登录墙（POST /search.html 302→/login.html），请用顶部「发现」分类找书。目录 689 章走 my1..my7 分页合并；站点偶发「空壳章/请勿开启浏览器阅读模式」提示页，重读或换章即可（非书源问题）。",
    "enabled": true,
    "enabledExplore": true,
    "enabledCookieJar": true,
    "customOrder": 0,
    "concurrentRate": "1/1000",
    "header": "{\"User-Agent\":\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36\",\"Referer\":\"https://m.bqg52.com/\"}",
    "searchUrl": "",
    "ruleSearch": {
      "bookList": "div > div > div.layout.layout2 > ul.txt-list.txt-list-row5 li",
      "name": "span.s2 > a@text",
      "author": "",
      "intro": "",
      "coverUrl": "",
      "bookUrl": "span.s2 > a@href",
      "kind": "",
      "lastChapter": "span.s3 > a@text"
    },
    "ruleBookInfo": {
      "name": "meta[property=\"og:novel:book_name\"]@content||meta[property=\"og:title\"]@content",
      "author": "meta[property=\"og:novel:author\"]@content",
      "intro": "meta[property=\"og:description\"]@content",
      "coverUrl": "meta[property=\"og:image\"]@content",
      "kind": "meta[property=\"og:novel:category\"]@content",
      "lastChapter": "meta[property=\"og:novel:latest_chapter_name\"]@content",
      "tocUrl": "text.查看更多章节@href"
    },
    "ruleToc": {
      "chapterList": "div.biqunaicc li",
      "chapterName": "a@text",
      "chapterUrl": "a@href",
      "nextTocUrl": "text.下一页@href",
      "sortByOrdinal": true
    },
    "ruleContent": {
      "content": "div.word_read@html",
      "nextContentUrl": "",
      "replaceRegex": "\\s*上一章[\\s\\S]{0,24}?下一章|（第\\s*\\d+\\s*页）|\\(\\s*第\\s*\\d+\\s*页\\s*\\)|[^\\n]*(?:加入书签|推荐本书|打开书架|添加书签|阅读记录|报告错误|相邻推荐|返回目录|返回书页)[^\\n]*|[^\\n]*浏览器阅读模式[^\\n]*"
    },
    "ruleExplore": [
      {
        "name": "玄幻小说",
        "url": "/fenlei/1_1/"
      },
      {
        "name": "修真小说",
        "url": "/fenlei/2_1/"
      },
      {
        "name": "都市小说",
        "url": "/fenlei/3_1/"
      },
      {
        "name": "历史小说",
        "url": "/fenlei/4_1/"
      },
      {
        "name": "网游小说",
        "url": "/fenlei/5_1/"
      },
      {
        "name": "科幻小说",
        "url": "/fenlei/6_1/"
      },
      {
        "name": "极品修真邪少",
        "url": "/book/206/"
      },
      {
        "name": "网游之锦衣卫",
        "url": "/book/5218/"
      }
    ],
    "ruleExplore_item": {
      "bookList": "div > div > div.layout.layout2 > ul.txt-list.txt-list-row5 li",
      "name": "span.s2 > a@text",
      "bookUrl": "span.s2 > a@href",
      "coverUrl": "",
      "author": ""
    },
    "weight": 0,
    "respondTime": 8000
  },
  {
    "bookSourceName": "笔趣阁（www.redan.cc）",
    "bookSourceGroup": "自动生成",
    "bookSourceType": 0,
    "bookSourceUrl": "https://www.redan.cc",
    "bookSourceComment": "由「网页转书源」自动生成（2026-10-15）。搜索接口带人机验证不可自动用，请用顶部「发现」分类找书。目录前 3 项导航杂质已跳过（1174 章：引子…第1183章 大结局），正文自动清洗面包屑/书签按钮行。",
    "enabled": true,
    "enabledExplore": true,
    "enabledCookieJar": true,
    "customOrder": 0,
    "concurrentRate": "1/1000",
    "header": "{\"User-Agent\":\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36\",\"Referer\":\"https://www.redan.cc/\"}",
    "searchUrl": "",
    "ruleSearch": {
      "bookList": "div#update > div.con dl.eachitem",
      "name": "dt > h3.xstl > a.caption@text",
      "author": "",
      "intro": "",
      "coverUrl": "dd.img > a > img@src",
      "bookUrl": "dt > h3.xstl > a.caption@href",
      "kind": "",
      "lastChapter": ""
    },
    "ruleBookInfo": {
      "name": "meta[property=\"og:novel:book_name\"]@content||meta[property=\"og:title\"]@content",
      "author": "meta[property=\"og:novel:author\"]@content",
      "intro": "meta[property=\"og:description\"]@content",
      "coverUrl": "meta[property=\"og:image\"]@content",
      "kind": "meta[property=\"og:novel:category\"]@content",
      "lastChapter": "meta[property=\"og:novel:latest_chapter_name\"]@content"
    },
    "ruleToc": {
      "chapterList": "dl.book dd:nth-of-type(n+4)",
      "chapterName": "a@text",
      "chapterUrl": "a@href",
      "sortByOrdinal": true
    },
    "ruleContent": {
      "content": "div#box@html",
      "nextContentUrl": "",
      "replaceRegex": "[^\\n]*(?:加入书签|推荐本书|打开书架|添加书签|阅读记录|报告错误|相邻推荐|返回目录|返回书页)[^\\n]*|[^\\n]*\\s>\\s[^\\n]*"
    },
    "ruleExplore": [
      {
        "name": "在线书库",
        "url": "/sort/all.html"
      },
      {
        "name": "小说排行榜",
        "url": "/rank/1.html"
      },
      {
        "name": "全本小说",
        "url": "/quanben/"
      },
      {
        "name": "玄幻魔法",
        "url": "/sort/1/"
      },
      {
        "name": "武侠修真",
        "url": "/sort/2/"
      },
      {
        "name": "都市言情",
        "url": "/sort/3/"
      },
      {
        "name": "历史军事",
        "url": "/sort/4/"
      },
      {
        "name": "女生言情",
        "url": "/sort/5/"
      }
    ],
    "ruleExplore_item": {
      "bookList": "div#update > div.con dl.eachitem",
      "name": "dt > h3.xstl > a.caption@text",
      "bookUrl": "dt > h3.xstl > a.caption@href",
      "coverUrl": "dd.img > a > img@src",
      "author": ""
    },
    "weight": 0,
    "respondTime": 8000
  }
];
/* ------------------------------ 写入 ------------------------------ */
const SOURCES_FILE = path.join(path.resolve(__dirname, '..'), 'data', 'sources', 'sources.json');
const list = fs.existsSync(SOURCES_FILE) ? JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8')) : [];
const added = [];
for (const src of sources) {
  const key = (s) => String(s.bookSourceUrl || '').replace(/\/+$/, '').toLowerCase();
  const i = list.findIndex((s) => key(s) === key(src));
  if (i >= 0) {
    list[i] = src;
    added.push(src.bookSourceName + '(已更新)');
  } else {
    list.push(src);
    added.push(src.bookSourceName + '(新增)');
  }
}
fs.mkdirSync(path.dirname(SOURCES_FILE), { recursive: true });
fs.writeFileSync(SOURCES_FILE, JSON.stringify(list, null, 2), 'utf8');
console.log('已写入 ' + SOURCES_FILE + '：' + added.join('、'));
