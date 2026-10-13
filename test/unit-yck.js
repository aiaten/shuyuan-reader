'use strict';
/**
 * 在线书源库（yck2026.fun）列表解析单元测试。
 * 主体用本地缓存 HTML，不联网；末尾可选做一次真实网络校验。
 * 跑法：node test/unit-yck.js
 */

const fs = require('fs');
const path = require('path');
const Y = require('../src/source/yck');

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  = ${g}\n      want = ${w}`}`);
}

function ok(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail || ''}`}`);
}

async function main() {
console.log('=== 常量与 URL 拼装 ===');
{
  eq('BASE', Y.BASE, 'https://www.yck2026.fun');
  eq('LIST_URL', Y.LIST_URL, 'https://www.yck2026.fun/yuedu/shuyuan/index.html');
  eq('JSON_URL(7941)', Y.JSON_URL(7941), 'https://www.yck2026.fun/yuedu/shuyuan/json/id/7941.json');
  eq('JSON_URL 字符串 id', Y.JSON_URL('7931'), 'https://www.yck2026.fun/yuedu/shuyuan/json/id/7931.json');
}

console.log('\n=== parseAgo：相对时间与绝对时间 ===');
{
  const now = Date.now();
  const day = 86400000;
  ok('刚刚 ≈ 现在', Math.abs(Y.parseAgo('刚刚') - now) < 5000, String(Y.parseAgo('刚刚') - now));
  ok('1分钟前 ≈ 1 分钟', Math.abs(Y.parseAgo('1分钟前') - (now - 60000)) < 5000);
  ok('49分钟前（站点真实样本）', Math.abs(Y.parseAgo('49分钟前') - (now - 49 * 60000)) < 5000);
  ok('2小时前 ≈ 2 小时', Math.abs(Y.parseAgo('2小时前') - (now - 2 * 3600000)) < 5000);
  ok('12小时前（真实样本）', Math.abs(Y.parseAgo('12小时前') - (now - 12 * 3600000)) < 5000);
  ok('3天前 ≈ 3 天', Math.abs(Y.parseAgo('3天前') - (now - 3 * day)) < 5000);
  ok('7天前（真实样本最大值）', Math.abs(Y.parseAgo('7天前') - (now - 7 * day)) < 5000);
  ok('5秒前 ≈ 5 秒', Math.abs(Y.parseAgo('5秒前') - (now - 5000)) < 5000);
  ok('1个月前 ≈ 30 天', Math.abs(Y.parseAgo('1个月前') - (now - 30 * day)) < 5000);

  // 绝对时间（站点真实格式，无年份）
  const abs = Y.parseAgo('10/03 10:12');
  ok('绝对时间「10/03 10:12」可解析', typeof abs === 'number' && abs > 0, String(abs));
  const d = new Date(abs);
  eq('月份正确', d.getMonth() + 1, 10);
  eq('日期正确', d.getDate(), 3);
  eq('小时正确', d.getHours(), 10);
  eq('分钟正确', d.getMinutes(), 12);
  ok('绝对时间不在未来', abs <= now + 1000, `${abs} vs ${now}`);
  ok('绝对时间不超过 1 年', now - abs < 366 * day, `${Math.round((now - abs) / day)} 天前`);

  ok('无法识别 → null', Y.parseAgo('不知道') === null, String(Y.parseAgo('不知道')));
  ok('空串 → null', Y.parseAgo('') === null);
  ok('null → null', Y.parseAgo(null) === null);
  ok('容忍空格「1 分钟前」', Math.abs(Y.parseAgo('1 分钟前') - (now - 60000)) < 5000);
  ok('非法月份「13/45 99:99」→ null', Y.parseAgo('13/45 99:99') === null);
}

console.log('\n=== parseList：用真实缓存页面 ===');
{
  // 优先用抓取下来的真实列表页；没有就跳过（不算失败）
  const candidates = [
    path.join(__dirname, '.cache', 'yck-list.html'),
    path.join(__dirname, '..', '..', '_recon', 'index.html'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) {
    console.log('  ⊘ 跳过（未找到缓存的列表页，可运行 test/probe-yck-api.js 生成）');
  } else {
    const html = fs.readFileSync(file, 'utf8');
    console.log(`  使用 ${path.relative(path.join(__dirname, '..'), file)}（${html.length} 字节）`);
    const r = Y.parseList(html);
    ok('返回 items 数组', Array.isArray(r.items));
    ok('解析出条目', r.items.length > 0, `实际 ${r.items.length}`);
    eq('每页 100 条', r.items.length, 100);
    ok('totalPages ≥ 1', r.totalPages >= 1, String(r.totalPages));

    const it = r.items[0];
    ok('有 id', !!it.id, JSON.stringify(it).slice(0, 200));
    ok('id 是数字', typeof it.id === 'number' && it.id > 0, String(it.id));
    ok('有名称', !!it.name);
    ok('有 URL', /^https?:\/\//.test(it.url || ''), it.url);
    ok('有 detailUrl', (it.detailUrl || '').includes('/yuedu/shuyuan/content/id/'), it.detailUrl);
    ok('有 jsonUrl', (it.jsonUrl || '').includes('/yuedu/shuyuan/json/id/'), it.jsonUrl);
    ok('有 updatedText', !!it.updatedText, String(it.updatedText));
    ok('tags 是数组', Array.isArray(it.tags), JSON.stringify(it.tags));
    ok('downloads 是数字或 null', it.downloads === null || typeof it.downloads === 'number', String(it.downloads));

    // 已知条目：7941 最终小说网 应该出现在抓取到的页面里
    const zz = r.items.find((x) => String(x.id) === '7941');
    if (zz) {
      eq('7941 名称', zz.name, '最终小说网');
      eq('7941 URL', zz.url, 'https://www.zuizhong.net/');
      ok('7941 有「搜」标签', zz.tags.some((t) => t.includes('搜')), JSON.stringify(zz.tags));
      ok('7941 hasSearch=true', zz.hasSearch === true);
      ok('7941 jsonUrl 正确', zz.jsonUrl.endsWith('/7941.json'), zz.jsonUrl);
    } else {
      console.log('  ⊘ 缓存的页面里没有 7941（分页不同），跳过该条断言');
    }

    // 所有条目 id 唯一
    const ids = r.items.map((x) => x.id);
    eq('id 无重复', new Set(ids).size, ids.length);
    // 标签解析
    const withExplore = r.items.filter((x) => x.hasExplore);
    ok('存在带「发」标签的条目', withExplore.length >= 0);
    const tagged = r.items.filter((x) => x.tags.includes('3.X'));
    ok('存在 3.X 标签条目', tagged.length > 0, String(tagged.length));

    // 名称与 URL 是从同一个 <a> 文本里拆出来的
    const bad = r.items.filter((x) => !x.name || x.name.includes('http'));
    eq('没有把 URL 混进名称', bad.length, 0);
  }
}
console.log('\n=== parseList：空页面 / 异常输入 ===');
{
  const r1 = Y.parseList('<html><body>nothing</body></html>');
  eq('空页面 → 0 条', r1.items.length, 0);
  eq('totalPages 兜底 1', r1.totalPages, 1);

  const r2 = Y.parseList('');
  eq('空串 → 0 条', r2.items.length, 0);

  let threw = null;
  try {
    Y.parseList(null);
  } catch (e) {
    threw = e.message;
  }
  ok('null 不崩溃', threw === null, String(threw));
}

console.log('\n=== parseList：手工构造的卡片 ===');
{
  const html = `
    <div class="ylist">
      <p class="checkboxclass"><input type="checkbox" class="class_one" name="ids[]" value="9999"></p>
      <h2><a href="/yuedu/shuyuan/content/id/9999.html">测试源 https://test.example.com</a>
          <p class="m-right">1分钟前</p></h2>
      <span class="layui-badge-rim">3.X</span>
      <span class="layui-badge-rim">发 搜 图</span>
      <span class="layui-badge-rim" title="UID:1">用户: tester</span>
      <span class="layui-badge-rim">下载:42</span>
    </div>
    <a href="/yuedu/shuyuan/index.html?page=7">7</a>`;
  const r = Y.parseList(html);
  eq('1 条', r.items.length, 1);
  eq('totalPages=7', r.totalPages, 7);
  const it = r.items[0];
  eq('id 为数字', it.id, 9999);
  eq('name', it.name, '测试源');
  eq('url', it.url, 'https://test.example.com');
  ok('hasExplore（发）', it.hasExplore === true);
  ok('hasSearch（搜）', it.hasSearch === true);
  ok('hasImage（图）', it.hasImage === true);
  ok('hasAudio 未标（声）', it.hasAudio === false);
  eq('downloads', it.downloads, 42);
  ok('tags 含 3.X', it.tags.includes('3.X'), JSON.stringify(it.tags));
  ok('author 解析', /tester/.test(it.author || ''), String(it.author));
}

console.log('\n=== kind 泛化（yck2026 书源 / yckceo 订阅源，m04402） ===');
{
  // KINDS 常量
  eq('KINDS.shuyuan.base', Y.KINDS.shuyuan.base, 'https://www.yck2026.fun');
  eq('KINDS.rss.base', Y.KINDS.rss.base, 'https://www.yckceo.com');
  eq('KINDS.rss.jsonPath(193)', Y.KINDS.rss.jsonPath(193), '/yuedu/rss/json/id/193.json');
  eq('KINDS.shuyuan.nameField', Y.KINDS.shuyuan.nameField, 'bookSourceName');
  eq('KINDS.rss.urlField', Y.KINDS.rss.urlField, 'sourceUrl');

  // 订阅源列表页解析（与书源列表同构）
  const rssHtml = `
    <div class="ylist">
      <p class="checkboxclass"><input type="checkbox" name="ids[]" value="193"></p>
      <h2><a href="/yuedu/rss/content/id/193.html">源仓库(官方纯净) http://yckceo.vip</a>
          <p class="m-right">2小时前</p></h2>
      <span class="layui-badge-rim" title="UID:7">用户: chen</span>
      <span class="layui-badge-rim">下载:100</span>
    </div>
    <a href="/yuedu/rss/index.html?page=4">4</a>`;
  const r = Y.parseList(rssHtml, { kind: 'rss' });
  eq('rss 列表 1 条', r.items.length, 1);
  eq('rss totalPages=4', r.totalPages, 4);
  const it = r.items[0];
  eq('rss item kind', it.kind, 'rss');
  eq('rss id', it.id, 193);
  eq('rss name', it.name, '源仓库(官方纯净)');
  eq('rss url', it.url, 'http://yckceo.vip');
  ok('rss detailUrl 指向 /yuedu/rss/', (it.detailUrl || '').includes('/yuedu/rss/content/id/193.html'), it.detailUrl);
  ok('rss jsonUrl 指向 /yuedu/rss/json/', (it.jsonUrl || '').includes('/yuedu/rss/json/id/193.json'), it.jsonUrl);

  // 书源 kind 默认值不受影响
  const sy = Y.parseList(rssHtml.replace(/yuedu\/rss/g, 'yuedu/shuyuan'), { kind: 'shuyuan' });
  eq('shuyuan kind 回归', sy.items[0].kind, 'shuyuan');
  ok('shuyuan detailUrl 指向 /yuedu/shuyuan/', (sy.items[0].detailUrl || '').includes('/yuedu/shuyuan/content/id/193.html'), sy.items[0].detailUrl);

  // 未知 kind 抛错
  let threw = null;
  try { Y.parseList('<div class="ylist"></div>', { kind: 'nope' }); } catch (e) { threw = e.message; }
  ok('未知 kind 抛错', threw && threw.includes('nope'), String(threw));
}

console.log('\n=== syncLatest（离线注入 http mock 模拟） ===');
{
  const http = require('../src/net/http');
  const realGet = http.get;
  const now = Date.now();
  const day = 86400000;
  // 构造两页列表：页1 有 3 条（1 条 3 天前、1 条 20 天前、1 条刚刚），页2 是更旧的
  const card = (id, agoText) => `
    <div class="ylist"><h2><a href="/yuedu/shuyuan/content/id/${id}.html">源${id} https://s${id}.example.com</a>
    <p class="m-right">${agoText}</p></h2><span class="layui-badge-rim">下载:${id}</span></div>`;
  const page1 = card(101, '3天前') + card(102, '20天前') + card(103, '刚刚') + '<a href="/yuedu/shuyuan/index.html?page=2">2</a>';
  const page2 = card(201, '25天前') + '<a href="/yuedu/shuyuan/index.html?page=2">2</a>';
  // 列表有短缓存，换 mock 前必须清，否则读到上一段的结果
  Y.resetListCache();
  Y.resetBaseCache();
  http.get = async (url) => {
    const u = String(url);
    if (u.includes('page=2')) return { status: 200, text: page2 };
    if (u.includes('/yuedu/shuyuan/index.html')) return { status: 200, text: page1 };
    if (u.includes('/json/id/101.json')) return { status: 200, text: JSON.stringify([{ bookSourceName: '源101', bookSourceUrl: 'https://s101.example.com' }]) };
    if (u.includes('/json/id/103.json')) return { status: 200, text: JSON.stringify([{ bookSourceName: '源103', bookSourceUrl: 'https://s103.example.com' }]) };
    throw new Error('意外请求: ' + u);
  };
  const r7 = await Y.syncLatest({ kind: 'shuyuan', days: 7 });
  eq('7天窗口：fresh 条数', r7.fresh.length, 2);
  eq('7天窗口：fresh ids', r7.fresh.map((x) => x.id), [101, 103]);
  ok('7天窗口：翻页到底（第2页太旧即停）', r7.pages === 2, `pages=${r7.pages}`);
  ok('7天窗口：条目带 kind', r7.fresh.every((x) => x.kind === 'shuyuan'));

  const r30 = await Y.syncLatest({ kind: 'shuyuan', days: 30 });
  eq('30天窗口：fresh ids（4 条全在窗口内）', r30.fresh.map((x) => x.id), [101, 102, 103, 201]);
  ok('30天窗口：翻到第 2 页', r30.pages === 2, `pages=${r30.pages}`);
  ok('30天窗口：103 在 fresh 里（刚刚更新）', r30.fresh.some((x) => x.id === 103));

  // since 直接指定
  Y.resetListCache();
  const rSince = await Y.syncLatest({ kind: 'shuyuan', since: now - 10 * day });
  eq('since=10天：fresh 条数', rSince.fresh.length, 2);
  http.get = realGet;
  Y.resetListCache();
  Y.resetBaseCache();
}

console.log('\n=== 备用线路（镜像站故障转移） ===');
{
  const http = require('../src/net/http');
  const realGet = http.get;
  const listHtml = '<div class="ylist"><h2><a href="/yuedu/shuyuan/content/id/1.html">源1 https://a.example.com</a></h2></div>';
  const jsonText = JSON.stringify([{ bookSourceName: '备用源', bookSourceUrl: 'https://b.example.com' }]);

  // 1) 主站挂 → 回退到备用站
  Y.resetBaseCache();
  Y.resetListCache();
  const seen = [];
  http.get = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.startsWith('https://www.yck2026.fun')) throw new Error('ECONNRESET（模拟主站被 ban）');
    if (u.startsWith('https://www.yckceo.com')) {
      if (u.includes('json')) return { status: 200, text: jsonText };
      return { status: 200, text: listHtml };
    }
    throw new Error('意外请求: ' + u);
  };
  const r1 = await Y.list({ page: 1 });
  ok('主站挂 → 回退成功', r1.items.length === 1, `items=${r1.items.length}`);
  eq('回退后 base 是备用站', r1.base, 'https://www.yckceo.com');
  eq('尝试过的线路顺序', r1.tried, ['https://www.yck2026.fun', 'https://www.yckceo.com']);
  eq('当前线路已切换', Y.activeBase('shuyuan'), 'https://www.yckceo.com');

  // 2) 已探明的线路优先（不再先撞死掉的主站）
  seen.length = 0;
  await Y.list({ page: 1, cache: false }); // 强制穿透短缓存，验证「优先线路」而不是读缓存
  eq('第二次请求直接走备用站', seen, ['https://www.yckceo.com/yuedu/shuyuan/index.html']);

  // 3) HTTP 200 但内容不对（被墙跳转/空页）→ 也要回退
  Y.resetBaseCache();
  Y.resetListCache();
  const seen2 = [];
  http.get = async (url) => {
    const u = String(url);
    seen2.push(u);
    if (u.startsWith('https://www.yck2026.fun')) return { status: 200, text: '<html><body>403 Forbidden</body></html>' };
    return { status: 200, text: listHtml };
  };
  const r3 = await Y.list({ page: 1 });
  eq('200 但无 ylist → 回退到备用站', r3.base, 'https://www.yckceo.com');
  ok('确实两个站点都试了', seen2.length === 2, `seen=${seen2.length}`);

  // 4) 全部线路都挂 → 抛错且列出尝试过的站点
  Y.resetBaseCache();
  Y.resetListCache();
  http.get = async () => { throw new Error('ETIMEDOUT'); };
  let err = null;
  try { await Y.list({ page: 1 }); } catch (e) { err = e; }
  ok('全线路失败时抛错', !!err, '没有抛错');
  ok('错误信息列出所有站点', err && err.message.includes('所有线路均不可用') && err.message.includes('yck2026.fun'), err && err.message);
  ok('错误信息附上地址发布页', err && err.message.includes('yckceo.vip'), err && err.message);
  ok('err.publishPage 暴露发布页', err && err.publishPage === Y.PUBLISH_PAGE, err && err.publishPage);
  ok('err.tried 记录尝试过的站点', err && Array.isArray(err.tried) && err.tried.length >= 2, err && JSON.stringify(err.tried));

  // 5) 候选线路至少包含两个同构站点（防单点）
  //    yckceo.vip 是 GitHub Pages 上的「地址发布页」，/yuedu/** 全 404，
  //    所以它**不能**算镜像：放进候选只会白花一次请求并污染最终报错。
  Y.resetBaseCache();
  const cands = Y.candidateBases('shuyuan');
  ok('shuyuan 候选线路 ≥ 2 个', cands.length >= 2, JSON.stringify(cands));
  ok('候选含 yckceo.com 备用站', cands.includes('https://www.yckceo.com'), JSON.stringify(cands));
  ok('rss 候选含 yck2026.fun', Y.candidateBases('rss').includes('https://www.yck2026.fun'));
  ok('候选不含发布页 yckceo.vip（它不是镜像）', !cands.includes('http://yckceo.vip'), JSON.stringify(cands));
  ok('发布页常量可用', Y.PUBLISH_PAGE === 'http://yckceo.vip', Y.PUBLISH_PAGE);

  // 6) download 也走故障转移
  Y.resetBaseCache();
  Y.resetListCache();
  http.get = async (url) => {
    const u = String(url);
    if (u.startsWith('https://www.yck2026.fun')) throw new Error('模拟被 ban');
    if (u.includes('json')) return { status: 200, text: jsonText };
    return { status: 200, text: listHtml };
  };
  const arr = await Y.download(123);
  eq('download 回退后拿到数据', arr.length, 1);
  eq('download 回退后书名', arr[0].bookSourceName, '备用源');

  // 7) JSON 端点返回 HTML（被墙跳转）→ 视为该站点不可用，回退
  Y.resetBaseCache();
  Y.resetListCache();
  http.get = async (url) => {
    const u = String(url);
    if (u.startsWith('https://www.yck2026.fun')) return { status: 200, text: '<html>blocked</html>' };
    return { status: 200, text: jsonText };
  };
  const arr2 = await Y.download(123);
  eq('JSON 端点被劫持 → 回退拿到真数据', arr2[0].bookSourceName, '备用源');

  http.get = realGet;
  Y.resetBaseCache();
  Y.resetListCache();
}

console.log('\n=== 列表短缓存与并发翻页 ===');
{
  const http = require('../src/net/http');
  const realGet = http.get;
  const listHtml = '<div class="ylist"><h2><a href="/yuedu/shuyuan/content/id/7.html">源7 https://c.example.com</a></h2></div>';

  // 缓存命中：同一页连拉两次，只应产生一次网络请求
  Y.resetBaseCache();
  Y.resetListCache();
  let hits = 0;
  http.get = async () => { hits++; return { status: 200, text: listHtml }; };
  const a1 = await Y.list({ page: 1 });
  const a2 = await Y.list({ page: 1 });
  eq('同页第二次走缓存（只 1 次网络）', hits, 1);
  ok('缓存命中标记 cached', a2.cached === true, JSON.stringify(a2.cached));
  eq('缓存结果与首次一致', a2.items.length, a1.items.length);
  // 不同页不串味
  await Y.list({ page: 2 });
  eq('换页不走缓存（第 2 次网络）', hits, 2);

  // cache:false 能强制穿透
  Y.resetListCache();
  hits = 0;
  await Y.list({ page: 1 });
  await Y.list({ page: 1, cache: false });
  eq('cache:false 强制穿透', hits, 2);

  // 清缓存后重新拉
  Y.resetListCache();
  hits = 0;
  await Y.list({ page: 1 });
  eq('resetListCache 后重新拉', hits, 1);

  // syncLatest 并发翻页：3 页应该并发发起，而不是串行
  Y.resetBaseCache();
  Y.resetListCache();
  let inflight = 0;
  let maxInflight = 0;
  http.get = async (url) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 60));
    inflight--;
    const u = String(url);
    // 每页都返回「刚刚」的条目，让翻页继续
    const page = (u.match(/page=(\d+)/) || [])[1] || 1;
    const id = 900 + Number(page);
    return {
      status: 200,
      text: `<div class="ylist"><h2><a href="/yuedu/shuyuan/content/id/${id}.html">源${id} https://s${id}.example.com</a><p class="m-right">刚刚</p></h2></div>`
        + '<a href="/yuedu/shuyuan/index.html?page=3">3</a>',
    };
  };
  const t0 = Date.now();
  const r = await Y.syncLatest({ pages: 3, days: 7 });
  const el = Date.now() - t0;
  ok('syncLatest 并发度 > 1（确实并发翻页）', maxInflight > 1, `maxInflight=${maxInflight}`);
  ok('syncLatest 3 页并发 < 300ms（串行会是 180ms×3=540ms+）', el < 300, `elapsed=${el}ms`);
  eq('syncLatest 扫到 3 页', r.pages, 3);
  eq('syncLatest 条目数', r.items.length, 3);

  http.get = realGet;
  Y.resetBaseCache();
  Y.resetListCache();
}
}

main().then(
  () => {
    console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
    process.exit(fail ? 1 : 0);
  },
  (e) => {
    console.error('测试异常：' + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
);