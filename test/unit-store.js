'use strict';
/**
 * 书源库（SourceStore）本地语义单元测试：不联网。
 * 覆盖 3 个已修的真实缺陷的回归：
 *   1) key 归一化不一致 —— `source list` 打印的 URL（末尾带 `/`）无法回喂 `--source`
 *   2) `remove` 用未归一化的 key 匹配失败
 *   3) `parseImport` 不认 UTF-8 BOM（记事本/PowerShell/Legado 导出常见）
 * 跑法：node test/unit-store.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SourceStore, validateShape, keyOf } = require('../src/source/store');

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

function throws(name, fn, match) {
  let msg = null;
  try {
    fn();
  } catch (e) {
    msg = e.message;
  }
  const hit = msg !== null && (!match || msg.includes(match));
  if (hit) pass++;
  else fail++;
  console.log(`  ${hit ? '✓' : '✗'} ${name}${hit ? '' : `  got=${msg}`}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shuyuan-store-'));
console.log('临时目录: ' + root + '\n');

const SRC = {
  bookSourceName: '我的手写书源',
  bookSourceUrl: 'https://www.zuizhong.net/',
  searchUrl: 'https://www.zuizhong.net/search.html,{"method":"POST","body":"s={{key}}"}',
  ruleToc: { chapterList: '.info_dv3.1@ul@a', chapterName: 'text', chapterUrl: 'href' },
  ruleContent: { content: '.info_dv1@p[1:-2]@text' },
};

console.log('=== keyOf / get 归一化一致性 ===');
{
  eq('keyOf 去尾斜杠 + 小写', keyOf(SRC), 'https://www.zuizhong.net');

  // SourceStore(dataDir) 内部再拼 'sources'，故这里传 dataDir 本身
  const dataDir = path.join(root, 'st1');
  const store = new SourceStore(dataDir);
  // 直接落盘，跳过探测
  fs.writeFileSync(path.join(dataDir, 'sources', 'sources.json'), JSON.stringify([SRC], null, 2), 'utf8');

  eq('get 用无尾斜杠 URL', !!store.get('https://www.zuizhong.net'), true);
  eq('get 用带尾斜杠 URL（source list 打印的形态）', !!store.get('https://www.zuizhong.net/'), true);
  eq('get 用大写 URL', !!store.get('HTTPS://WWW.ZUIZHONG.NET/'), true);
  eq('get 用中文名', !!store.get('我的手写书源'), true);
  eq('get 用两侧带空格的 URL', !!store.get('  https://www.zuizhong.net/  '), true);
  eq('get 不存在的 key', store.get('https://nope.example'), null);

  const found = store.get('https://www.zuizhong.net/');
  eq('取回的确实是该书源', found && found.bookSourceName, '我的手写书源');

  // 3.X 书源里 bookSourceUrl 常带路径，末尾斜杠差异同样要归一
  fs.writeFileSync(
    path.join(dataDir, 'sources', 'sources.json'),
    JSON.stringify([{ bookSourceName: '带路径', bookSourceUrl: 'https://a.com/legado/' }], null, 2),
    'utf8'
  );
  eq('带路径源：无尾斜杠可命中', !!store.get('https://a.com/legado'), true);
  eq('带路径源：带尾斜杠可命中', !!store.get('https://a.com/legado/'), true);
}

console.log('\n=== remove 归一化 ===');
{
  const dataDir = path.join(root, 'rm');
  const store = new SourceStore(dataDir);
  const file = path.join(dataDir, 'sources', 'sources.json');
  const write = (arr) => fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');

  write([SRC, { bookSourceName: '另一个', bookSourceUrl: 'https://b.com' }]);
  eq('删除前 2 个', store.all().length, 2);
  eq('用带尾斜杠 URL 删除', store.remove('https://www.zuizhong.net/'), true);
  eq('删除后 1 个', store.all().length, 1);
  eq('剩下的是另一个', store.all()[0].bookSourceName, '另一个');

  write([SRC]);
  eq('用中文名删除', store.remove('我的手写书源'), true);
  eq('删除后为空', store.all().length, 0);

  write([SRC]);
  eq('删除不存在的 key 返回 false', store.remove('https://nope.example'), false);
  eq('失败时数据未被破坏', store.all().length, 1);
}

console.log('\n=== parseImport：BOM / 空文件 / 非法输入 ===');
{
  const one = JSON.stringify(SRC);
  eq('裸对象', SourceStore.parseImport(one).length, 1);
  eq('数组', SourceStore.parseImport('[' + one + ']').length, 1);
  eq('UTF-8 BOM 前缀', SourceStore.parseImport('\uFEFF' + one).length, 1);
  eq('BOM + 前导空白', SourceStore.parseImport('\uFEFF\n\t' + one).length, 1);
  eq('BOM 包着的数组', SourceStore.parseImport('\uFEFF[' + one + ',' + one + ']').length, 2);
  eq('过滤掉非书源对象', SourceStore.parseImport('[{"foo":1},' + one + ']').length, 1);

  throws('纯空白报错', () => SourceStore.parseImport('   \n '), '文件是空的');
  throws('空串报错', () => SourceStore.parseImport(''), '文件是空的');
  throws('只读 BOM 报错', () => SourceStore.parseImport('\uFEFF'), '文件是空的');
  throws('非 JSON 报错', () => SourceStore.parseImport('这不是 JSON'), '不是合法 JSON');
  throws('JSON 顶层是标量时报错', () => SourceStore.parseImport('123'), '不是合法书源');

  // 真文件（带 BOM）走一遍，模拟 Windows 记事本另存
  const f = path.join(root, 'bom.json');
  fs.writeFileSync(f, '\uFEFF' + one, 'utf8');
  const loaded = SourceStore.parseImport(fs.readFileSync(f, 'utf8'));
  eq('读带 BOM 的真实文件', loaded.length, 1);
  eq('内容正确', loaded[0].bookSourceName, '我的手写书源');
}

console.log('\n=== validateShape 必填与可用性 ===');
{
  eq('合法书源无错', validateShape(SRC).length, 0);
  ok('缺 bookSourceName', validateShape({ bookSourceUrl: 'https://a.com' }).some((e) => e.includes('bookSourceName')));
  ok('缺 bookSourceUrl', validateShape({ bookSourceName: 'x' }).some((e) => e.includes('bookSourceUrl')));
  ok(
    '非 http URL',
    validateShape({ bookSourceName: 'x', bookSourceUrl: 'ftp://a.com' }).some((e) => e.includes('http'))
  );
  ok(
    '既无 searchUrl 也无 ruleExplore',
    validateShape({ bookSourceName: 'x', bookSourceUrl: 'https://a.com' }).some((e) => e.includes('searchUrl'))
  );
  eq(
    '只有 ruleExplore 也算可探',
    validateShape({
      bookSourceName: 'x',
      bookSourceUrl: 'https://a.com',
      ruleExplore: [{ name: '最新', url: '/new' }],
      ruleToc: { chapterList: '.a' },
      ruleContent: { content: '#c@text' },
    }).length,
    0
  );
  ok(
    '缺 ruleToc.chapterList',
    validateShape({
      bookSourceName: 'x',
      bookSourceUrl: 'https://a.com',
      searchUrl: 'https://a.com/s?q={{key}}',
      ruleContent: { content: '#c@text' },
    }).some((e) => e.includes('chapterList'))
  );
  ok(
    '缺 ruleContent.content',
    validateShape({
      bookSourceName: 'x',
      bookSourceUrl: 'https://a.com',
      searchUrl: 'https://a.com/s?q={{key}}',
      ruleToc: { chapterList: '.a' },
    }).some((e) => e.includes('ruleContent'))
  );
  ok('数组不是合法书源', validateShape([]).length > 0);
  ok('null 不是合法书源', validateShape(null).length > 0);
}

console.log('\n=== export 往返 ===');
{
  const text = SourceStore.export([SRC], true);
  eq('导出可被 parseImport 读回', SourceStore.parseImport(text).length, 1);
  eq('往返后名称一致', SourceStore.parseImport(text)[0].bookSourceName, '我的手写书源');
  const oneLine = SourceStore.export([SRC], false);
  ok('pretty=false 无换行', oneLine.indexOf('\n') < 0, oneLine.slice(0, 60));
}

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch (_) {
  /* ignore */
}

console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
