'use strict';
/**
 * unit-rss —— RssStore / validateRssShape / rssKeyOf / parseImport 单元测试（离线，临时目录）
 * 运行：node test/unit-rss.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { RssStore, validateRssShape, rssKeyOf } = require('../src/source/store');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : (detail !== undefined ? `\n      ${detail}` : '')}`);
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(name, g === w, `got=${g} want=${w}`);
}

function main() {
  console.log('=== rssKeyOf / validateRssShape ===');
  eq('rssKeyOf：sourceUrl 归一（去尾斜杠+小写）', rssKeyOf({ sourceUrl: 'https://Example.COM/path/' }), 'https://example.com/path');
  eq('rssKeyOf：无 url 兜底 name:', rssKeyOf({ sourceName: 'Foo' }), 'name:foo');
  eq('rssKeyOf：空对象', rssKeyOf({}), 'name:');

  ok('合法订阅源通过校验', validateRssShape({ sourceName: '源仓库', sourceUrl: 'http://yckceo.vip' }).length === 0);
  ok('data: url 允许', validateRssShape({ sourceName: 'x', sourceUrl: 'data:...' }).length === 0);
  ok('缺 sourceName 拒绝', validateRssShape({ sourceUrl: 'https://a.com' }).join().includes('sourceName'));
  ok('缺 sourceUrl 拒绝', validateRssShape({ sourceName: 'x' }).join().includes('sourceUrl'));
  ok('ftp url 拒绝', validateRssShape({ sourceName: 'x', sourceUrl: 'ftp://a.com' }).length > 0);
  ok('数组输入拒绝', validateRssShape([]).length > 0);
  ok('null 拒绝', validateRssShape(null).length > 0);

  console.log('=== RssStore（临时目录） ===');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-rss-'));
  try {
    const st = new RssStore(dir);
    eq('初始为空', st.all(), []);
    ok('rss.json 路径在 sources 下', st.file.endsWith(path.join('sources', 'rss.json')));

    const r1 = st.addMany([
      { sourceName: '源仓库', sourceUrl: 'http://yckceo.vip', sourceGroup: '官方' },
      { sourceName: 'LOFTER', sourceUrl: 'https://www.lofter.com' },
      { sourceName: '坏的', sourceUrl: 'ftp://x' },
      { sourceName: '缺url' },
    ]);
    eq('第一轮 added=2', r1.added, 2);
    eq('第一轮 skipped=2', r1.skipped, 2);
    ok('文件落盘', JSON.parse(fs.readFileSync(st.file, 'utf8')).length === 2);

    const r2 = st.addMany([{ sourceName: '源仓库', sourceUrl: 'http://yckceo.vip' }]);
    eq('重复 skip', r2.added, 0);
    ok('重复原因=已存在', r2.items[0].reason === '已存在');

    const r3 = st.addMany([{ sourceName: '源仓库', sourceUrl: 'http://yckceo.vip', sourceIcon: 'x.png' }], { force: true });
    eq('force 更新', r3.updated, 1);
    eq('更新后保留新字段', st.get('http://yckceo.vip').sourceIcon, 'x.png');

    ok('get 按 url 命中', st.get('HTTP://YCKCEO.VIP/').sourceName === '源仓库');
    ok('get 按 name 兜底', st.get('lofter') !== null);
    eq('get 未命中', st.get('nope'), null);

    ok('remove 命中', st.remove('https://www.lofter.com') === true);
    eq('remove 后数量', st.all().length, 1);
    ok('remove 未命中返回 false', st.remove('https://www.lofter.com') === false);

    console.log('=== RssStore.parseImport ===');
    eq('parseImport：数组', RssStore.parseImport('[{"sourceName":"a","sourceUrl":"https://a.com"}]').length, 1);
    eq('parseImport：单对象', RssStore.parseImport('{"sourceName":"a","sourceUrl":"https://a.com"}').length, 1);
    eq('parseImport：剥 BOM', RssStore.parseImport('\uFEFF[{"sourceName":"a","sourceUrl":"https://a.com"}]').length, 1);
    eq('parseImport：过滤书源形对象', RssStore.parseImport('[{"bookSourceName":"b","bookSourceUrl":"https://b.com"},{"sourceName":"a","sourceUrl":"https://a.com"}]').length, 1);
    ok('parseImport：空串抛错', throws(() => RssStore.parseImport('')));
    ok('parseImport：坏 JSON 抛错', throws(() => RssStore.parseImport('{oops}')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
  if (fail) process.exitCode = 1;
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch (_) {
    return true;
  }
}

main();
