'use strict';
/**
 * 内置浏览器单元测试（sites 站点表 + BrowserStore 书签/历史/会话）。
 *
 * 全部纯本地：不联网、不起 Electron，只用临时目录里的 JSON 文件。
 * 跑法：node test/unit-browser.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SITES, POLICY, listSites, getSite } = require('../src/browser/sites');
const {
  BrowserStore,
  normUrl,
  urlKey,
  normalizeInput,
  isHttpUrl,
  cleanTitle,
  fallbackTitle,
} = require('../src/browser/store');

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

/** 新建一个临时数据目录（每个用例独立，互不干扰） */
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `shuyuan-browser-${tag}-`));
}

const cleanups = [];
process.on('exit', () => {
  for (const d of cleanups) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {
      /* 临时目录，清不掉也无所谓 */
    }
  }
});

function main() {
  /* ==================== 站点表 ==================== */
  console.log('=== sites：预置站点表 ===');
  {
    ok('站点表非空', Array.isArray(SITES) && SITES.length > 0);
    ok('至少 5 个站点', SITES.length >= 5, `实际 ${SITES.length}`);

    // 用户点名的 5 家必须在
    const names = SITES.map((s) => s.name);
    for (const need of ['起点中文网', '飞卢小说网', '刺猬猫', '菠萝包', '晋江文学城']) {
      ok(`含「${need}」`, names.some((n) => n.includes(need)), `现有：${names.join(' / ')}`);
    }

    // 字段齐全 + URL 合法
    const keys = new Set();
    for (const s of SITES) {
      const tag = s.key || '(无 key)';
      ok(`${tag} 有 key/name/url/home/desc`, !!(s.key && s.name && s.url && s.home && s.desc), JSON.stringify(s));
      ok(`${tag} key 非空且唯一`, !!s.key && !keys.has(s.key), `重复 key：${s.key}`);
      keys.add(s.key);
      ok(`${tag} url 是 http(s)`, /^https:\/\/[^\s]+$/i.test(String(s.url)), s.url);
      ok(`${tag} home 是 http(s)`, /^https:\/\/[^\s]+$/i.test(String(s.home)), s.home);
      ok(`${tag} url 可被 URL 解析`, (() => { try { new URL(s.url); return true; } catch (_) { return false; } })());
    }

    // home 应是 url 的同域（用户点「回首页」不会跳到别家）
    for (const s of SITES) {
      const hUrl = new URL(s.url).hostname.replace(/^www\./, '');
      const hHome = new URL(s.home).hostname.replace(/^www\./, '');
      ok(`${s.key} url 与 home 同域`, hUrl === hHome, `${hUrl} vs ${hHome}`);
    }

    // 合规文案
    ok('POLICY 提到「不抓取」', /不抓取/.test(POLICY), POLICY);
    ok('POLICY 提到「正版」', /正版/.test(POLICY), POLICY);
    ok('POLICY 非空字符串', typeof POLICY === 'string' && POLICY.length > 5);

    // listSites 返回深拷贝，调用方改不动共享常量
    const copy = listSites();
    eq('listSites 数量一致', copy.length, SITES.length);
    copy[0].name = '被改坏了';
    ok('listSites 是深拷贝（不动常量）', SITES[0].name !== '被改坏了', SITES[0].name);

    // getSite
    eq('getSite(qidian).name', getSite('qidian').name, '起点中文网');
    eq('getSite 大写也认', getSite('QIDIAN').key, 'qidian');
    eq('getSite 找不到 → null', getSite('nope'), null);
    eq('getSite 空 → null', getSite(''), null);
    eq('getSite null → null', getSite(null), null);
  }

  /* ==================== 地址工具 ==================== */
  console.log('\n=== store：地址归一化 ===');
  {
    eq('normUrl 正常', normUrl('https://a.com/x'), 'https://a.com/x');
    eq('normUrl 去首尾空白', normUrl('  https://a.com  '), 'https://a.com');
    eq('normUrl 拒绝 javascript:', normUrl('javascript:alert(1)'), '');
    eq('normUrl 拒绝 file:', normUrl('file:///C:/x'), '');
    eq('normUrl 拒绝空', normUrl(''), '');
    eq('normUrl 拒绝 null', normUrl(null), '');
    eq('normUrl 接受 http', normUrl('http://a.com'), 'http://a.com');

    eq('urlKey 去尾斜杠', urlKey('https://a.com/'), 'https://a.com');
    eq('urlKey 小写', urlKey('https://A.com'), 'https://a.com');
    eq('urlKey 两种写法相等', urlKey('https://a.com/'), urlKey('https://a.com'));
    eq('urlKey 非法 → 空', urlKey('ftp://a.com'), '');

    eq('normalizeInput 补 https', normalizeInput('www.qidian.com'), 'https://www.qidian.com');
    eq('normalizeInput 已有协议不动', normalizeInput('http://a.com'), 'http://a.com');
    eq('normalizeInput about:blank 原样', normalizeInput('about:blank'), 'about:blank');
    eq('normalizeInput 空 → 空', normalizeInput('   '), '');
    eq('normalizeInput 中文原样返回', normalizeInput('起点中文网'), '起点中文网');
    // 回归：以前 normalizeInput 把 javascript: 原样放行（或被补成 https://javascript:...），
    // 地址栏就可能把脚本协议喂给 webview。带协议时必须只放行 http/https/about。
    eq('normalizeInput 拒绝 javascript:', normalizeInput('javascript:alert(1)'), '');
    eq('normalizeInput 拒绝 file:', normalizeInput('file:///C:/Windows'), '');
    eq('normalizeInput 拒绝 data:', normalizeInput('data:text/html,<b>x</b>'), '');
    eq('normalizeInput 拒绝 chrome:', normalizeInput('chrome://settings'), '');
    eq('normalizeInput 拒绝 devtools:', normalizeInput('devtools://x'), '');
    eq('normalizeInput 保留 https', normalizeInput('https://a.com'), 'https://a.com');

    ok('isHttpUrl 真', isHttpUrl('https://a.com'));
    ok('isHttpUrl 假', !isHttpUrl('起点中文网'));

    eq('cleanTitle 压平空白', cleanTitle('  a \n b  '), 'a b');
    eq('cleanTitle 截断 200', cleanTitle('x'.repeat(300)).length, 200);
    eq('fallbackTitle 用主机名', fallbackTitle('https://www.qidian.com/book/1'), 'qidian.com');
    eq('fallbackTitle 空地址', fallbackTitle(''), '新标签页');
  }

  /* ==================== 书签 ==================== */
  console.log('\n=== store：书签增删与持久化 ===');
  {
    const dir = tmpDir('bm');
    cleanups.push(dir);
    const s = new BrowserStore(dir);

    eq('初始无书签', s.bookmarks(), []);

    const r1 = s.addBookmark({ url: 'https://www.qidian.com/', title: '起点中文网', site: 'qidian' });
    ok('加书签成功', r1.added === true, JSON.stringify(r1));
    eq('书签数 1', s.bookmarks().length, 1);
    eq('书签标题', s.bookmarks()[0].title, '起点中文网');
    eq('书签 title 保留', s.bookmarks()[0].url, 'https://www.qidian.com/');
    ok('addedAt 有值', s.bookmarks()[0].addedAt > 0);

    // 重复加（尾斜杠不同）应被判重
    const r2 = s.addBookmark({ url: 'https://www.qidian.com', title: '起点' });
    eq('重复书签不added', r2.added, false);
    eq('重复后数量仍 1', s.bookmarks().length, 1);

    eq('hasBookmark 命中', s.hasBookmark('https://www.qidian.com/'), true);
    eq('hasBookmark 未命中', s.hasBookmark('https://b.faloo.com/'), false);

    s.addBookmark({ url: 'https://b.faloo.com/', title: '飞卢小说网' });
    eq('书签数 2', s.bookmarks().length, 2);

    // 无标题时用主机名兜底
    s.addBookmark({ url: 'https://www.ciweimao.com/', title: '' });
    const cw = s.bookmarks().find((b) => b.url.includes('ciweimao'));
    eq('无标题兜底为主机名', cw.title, 'ciweimao.com');

    // 非法地址不许进
    const bad = s.addBookmark({ url: 'javascript:alert(1)', title: 'x' });
    eq('非法地址被拒', bad.added, false);
    s.addBookmark({ url: '', title: 'x' });
    eq('空地址后数量仍 3', s.bookmarks().length, 3);

    // 重命名
    eq('重命名成功', s.renameBookmark('https://b.faloo.com', '飞卢（改）'), true);
    eq('重命名生效', s.bookmarks().find((b) => b.url.includes('faloo')).title, '飞卢（改）');
    eq('重命名空标题被拒', s.renameBookmark('https://b.faloo.com', '  '), false);
    eq('重命名不存在的返回 false', s.renameBookmark('https://nope.com', 'x'), false);

    // 持久化：换一个实例读同一个目录
    const s2 = new BrowserStore(dir);
    eq('换实例仍读到 3 条', s2.bookmarks().length, 3);
    eq('持久化标题正确', s2.bookmarks().find((b) => b.url.includes('faloo')).title, '飞卢（改）');

    // 删除
    eq('删书签成功', s.removeBookmark('https://www.ciweimao.com/'), true);
    eq('删后 2 条', s.bookmarks().length, 2);
    eq('重复删返回 false', s.removeBookmark('https://www.ciweimao.com/'), false);
    eq('删空地址返回 false', s.removeBookmark(''), false);

    // 排序：新加的在前
    const s3 = new BrowserStore(tmpDir('order'));
    cleanups.push(s3.dir.replace(/\\browser$/, ''));
    s3.addBookmark({ url: 'https://a.com', title: 'A' });
    s3.addBookmark({ url: 'https://b.com', title: 'B' });
    eq('最近加的排最前', s3.bookmarks()[0].title, 'B');

    // 同毫秒连加多条（Date.now() 相同）也必须严格「后加的在前」。
    // 之前只按 addedAt 排序，同一毫秒内顺序会乱，这是个真实回归点。
    const sTick = new BrowserStore(tmpDir('tick'));
    cleanups.push(sTick.dir.replace(/\\browser$/, ''));
    const tickNames = [];
    for (let i = 0; i < 12; i++) {
      sTick.addBookmark({ url: `https://tick${i}.com/`, title: 'T' + i });
      tickNames.push('T' + i);
    }
    eq(
      '同毫秒 12 条严格倒序',
      sTick.bookmarks().map((b) => b.title),
      tickNames.slice().reverse()
    );
    eq('同毫秒书签总数 12', sTick.bookmarks().length, 12);

    // 清空
    eq('清空返回条数', s3.clearBookmarks(), 2);
    eq('清空后为 0', s3.bookmarks().length, 0);
  }

  /* ==================== 历史 ==================== */
  console.log('\n=== store：浏览历史 ===');
  {
    const dir = tmpDir('his');
    cleanups.push(dir);
    const s = new BrowserStore(dir);

    eq('初始无历史', s.history(), []);
    s.pushHistory({ url: 'https://www.qidian.com/', title: '起点' });
    s.pushHistory({ url: 'https://b.faloo.com/', title: '飞卢' });
    eq('历史 2 条', s.history().length, 2);
    eq('最近在前', s.history()[0].title, '飞卢');

    // 同地址只留一条（把时间顶上去）
    s.pushHistory({ url: 'https://www.qidian.com', title: '起点（再看）' });
    eq('同地址去重后仍 2 条', s.history().length, 2);
    eq('同地址标题被更新', s.history()[0].title, '起点（再看）');

    // 同毫秒连记多条也要严格倒序
    const sTick = new BrowserStore(tmpDir('histick'));
    cleanups.push(sTick.dir.replace(/\\browser$/, ''));
    for (let i = 0; i < 10; i++) sTick.pushHistory({ url: `https://h${i}.tick/`, title: 'H' + i });
    eq(
      '历史同毫秒严格倒序',
      sTick.history().map((h) => h.title),
      ['H9', 'H8', 'H7', 'H6', 'H5', 'H4', 'H3', 'H2', 'H1', 'H0']
    );

    // 非法地址不记
    s.pushHistory({ url: 'javascript:1', title: 'x' });
    s.pushHistory(null);
    eq('非法/空历史不记', s.history().length, 2);

    // limit
    eq('limit=1', s.history(1).length, 1);
    eq('limit 非法 → 全量', s.history('abc').length, 2);
    // 回归：seq 只是落盘时用来打破同毫秒平局的排序号，不该透给渲染进程
    // （对外字段与 bookmarks 保持一致：url/title/site/visitedAt）
    eq('历史对外只有 4 个字段', Object.keys(s.history()[0]).sort(), ['site', 'title', 'url', 'visitedAt']);

    // 持久化
    const s2 = new BrowserStore(dir);
    eq('历史换实例仍 2 条', s2.history().length, 2);

    // 上限裁剪
    const s3 = new BrowserStore(tmpDir('cap'));
    cleanups.push(s3.dir.replace(/\\browser$/, ''));
    for (let i = 0; i < 320; i++) s3.pushHistory({ url: `https://h${i}.com/`, title: 't' + i });
    ok('历史上限 300 生效', s3.history().length === 300, `实际 ${s3.history().length}`);
    eq('砍掉的是最旧的', s3.history().find((h) => h.url.includes('h0.com')), undefined);

    eq('清空历史返回条数', s3.clearHistory(), 300);
    eq('清空后 0', s3.history().length, 0);
  }

  /* ==================== 会话 ==================== */
  console.log('\n=== store：标签会话 ===');
  {
    const dir = tmpDir('sess');
    cleanups.push(dir);
    const s = new BrowserStore(dir);

    eq('初始会话为空', s.session(), []);
    const saved = s.saveSession([
      { id: 't1', url: 'https://www.qidian.com/', title: '起点' },
      { id: 't2', url: 'javascript:1', title: '坏的' },
      { id: 't3', url: 'https://www.jjwxc.net/', title: '晋江' },
    ]);
    eq('非法地址被过滤', saved.length, 2);
    eq('会话读回 2 条', s.session().length, 2);
    eq('会话带 id', s.session()[0].id, 't1');

    const s2 = new BrowserStore(dir);
    eq('会话持久化', s2.session().length, 2);
    s2.clearSession();
    eq('清空会话', s2.session(), []);

    // 空/脏入参不炸
    eq('saveSession(undefined)', s.saveSession(undefined).length, 0);
    eq('saveSession(字符串)', s.saveSession('坏数据').length, 0);
  }

  /* ==================== 脏数据容错 ==================== */
  console.log('\n=== store：脏数据容错（手改坏文件不能崩） ===');
  {
    // 1) 非法 JSON
    const d1 = tmpDir('dirty1');
    cleanups.push(d1);
    fs.mkdirSync(path.join(d1, 'browser'), { recursive: true });
    fs.writeFileSync(path.join(d1, 'browser', 'bookmarks.json'), '{ 这不是 JSON', 'utf8');
    const s1 = new BrowserStore(d1);
    eq('非法 JSON → 空书签', s1.bookmarks(), []);
    const a1 = s1.addBookmark({ url: 'https://a.com/', title: 'A' });
    eq('坏文件后仍能写入', a1.added, true);
    eq('写入后读到 1 条', s1.bookmarks().length, 1);

    // 2) 顶层不是数组
    const d2 = tmpDir('dirty2');
    cleanups.push(d2);
    fs.mkdirSync(path.join(d2, 'browser'), { recursive: true });
    fs.writeFileSync(path.join(d2, 'browser', 'bookmarks.json'), '{"a":1}', 'utf8');
    eq('顶层非数组 → 空', new BrowserStore(d2).bookmarks(), []);

    // 3) 数组里混着 null / 字符串 / 缺 url 的项
    const d3 = tmpDir('dirty3');
    cleanups.push(d3);
    fs.mkdirSync(path.join(d3, 'browser'), { recursive: true });
    fs.writeFileSync(
      path.join(d3, 'browser', 'bookmarks.json'),
      JSON.stringify([
        null,
        '字符串',
        42,
        { title: '没有 url' },
        { url: 'javascript:void(0)', title: '伪协议' },
        { url: 'https://ok.com/', title: '好的' },
      ]),
      'utf8'
    );
    const s3 = new BrowserStore(d3);
    eq('脏项被过滤只剩 1', s3.bookmarks().length, 1);
    eq('留下的是合法项', s3.bookmarks()[0].title, '好的');
    ok('脏项不会污染 addedAt', s3.bookmarks()[0].addedAt >= 0);

    // 4) 历史脏数据
    const d4 = tmpDir('dirty4');
    cleanups.push(d4);
    fs.mkdirSync(path.join(d4, 'browser'), { recursive: true });
    fs.writeFileSync(path.join(d4, 'browser', 'history.json'), 'null', 'utf8');
    eq('history 为 null → 空', new BrowserStore(d4).history(), []);

    // 5) 会话脏数据
    const d5 = tmpDir('dirty5');
    cleanups.push(d5);
    fs.mkdirSync(path.join(d5, 'browser'), { recursive: true });
    fs.writeFileSync(path.join(d5, 'browser', 'session.json'), '[]]', 'utf8');
    eq('session 坏 JSON → 空', new BrowserStore(d5).session(), []);

    // 6) 数据目录尚不存在也要能自建
    const d6 = path.join(tmpDir('dirty6'), '还没有', '这层');
    cleanups.push(d6.split(path.sep + '还没有')[0]);
    const s6 = new BrowserStore(d6);
    eq('自动建目录后可写', s6.addBookmark({ url: 'https://new.com/', title: 'N' }).added, true);
    eq('自动建目录后可读', s6.bookmarks().length, 1);

    // 7) 缺字段的条目（旧版本迁移）
    const d7 = tmpDir('dirty7');
    cleanups.push(d7);
    fs.mkdirSync(path.join(d7, 'browser'), { recursive: true });
    fs.writeFileSync(
      path.join(d7, 'browser', 'bookmarks.json'),
      JSON.stringify([{ url: 'https://old.com/' }]),
      'utf8'
    );
    const s7 = new BrowserStore(d7);
    eq('缺 title 补主机名', s7.bookmarks()[0].title, 'old.com');
    eq('缺 addedAt 为 0', s7.bookmarks()[0].addedAt, 0);
    eq('缺 site 为空串', s7.bookmarks()[0].site, '');
  }

  /* ==================== 统计 ==================== */
  console.log('\n=== store：统计与不抓正文的边界 ===');
  {
    const dir = tmpDir('stat');
    cleanups.push(dir);
    const s = new BrowserStore(dir);
    s.addBookmark({ url: 'https://a.com/', title: 'A' });
    s.addBookmark({ url: 'https://b.com/', title: 'B' });
    s.pushHistory({ url: 'https://c.com/', title: 'C' });
    eq('stats.bookmarks', s.stats().bookmarks, 2);
    eq('stats.history', s.stats().history, 1);

    // 落盘的必须是纯元数据：没有正文字段、没有页面 HTML
    s.addBookmark({ url: 'https://d.com/', title: 'D', content: '不该被写进去的正文', html: '<p>x</p>' });
    const raw = fs.readFileSync(path.join(dir, 'browser', 'bookmarks.json'), 'utf8');
    ok('不把 content 字段写盘', !raw.includes('不该被写进去的正文'), raw.slice(0, 200));
    ok('不把 html 字段写盘', !raw.includes('<p>x</p>'));
    const bm = s.bookmarks().find((b) => b.url.includes('d.com'));
    eq('书签只有 4 个字段', Object.keys(bm).sort(), ['addedAt', 'site', 'title', 'url']);
  }

  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  if (fail) process.exitCode = 1;
}

main();
