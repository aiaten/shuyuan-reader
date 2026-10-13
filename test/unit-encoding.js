'use strict';
/**
 * 编码识别与解码单元测试。
 * 重点覆盖中文站常见的「假 utf-8 声明」回退，以及 BOM / meta / Content-Type 的优先级。
 * 跑法：node test/unit-encoding.js
 */

const iconv = require('iconv-lite');
const E = require('../src/util/encoding');

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  const ok = got === want;
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  = ${JSON.stringify(got)}\n      want = ${JSON.stringify(want)}`}`);
}

function ok(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail || ''}`}`);
}

const CN = '第一章 诡秘之主：序列、途径与灵界';
const gbk = iconv.encode(CN, 'gbk');
const utf8 = Buffer.from(CN, 'utf8');

console.log('=== 纯 utf-8 ===');
{
  const r = E.decode(utf8);
  eq('内容正确', r.text, CN);
  eq('识别为 utf-8', r.charset, 'utf-8');
}

console.log('\n=== GBK 编码 + 无任何声明 ===');
{
  const r = E.decode(gbk, { defaultCharset: 'gbk' });
  eq('按 defaultCharset 解出', r.text, CN);
  eq('charset=gbk', r.charset, 'gbk');
}

console.log('\n=== 假 utf-8：GBK 字节 + Content-Type 声明 utf-8（中文站常见） ===');
{
  const r = E.decode(gbk, { contentType: 'text/html; charset=utf-8' });
  eq('启发式回退到 gb18030，内容正确', r.text, CN);
  ok('charset 变成 gb 系', /gb/i.test(r.charset), `实际 ${r.charset}`);
}

console.log('\n=== 真 utf-8 + Content-Type 声明 utf-8（不应误回退） ===');
{
  const r = E.decode(utf8, { contentType: 'text/html; charset=utf-8' });
  eq('保持 utf-8', r.charset, 'utf-8');
  eq('内容正确', r.text, CN);
}

console.log('\n=== GBK 字节 + HTML meta 声明 gb2312 ===');
{
  const html = Buffer.concat([
    Buffer.from('<html><head><meta charset="gb2312"><title>t</title></head><body>', 'latin1'),
    gbk,
  ]);
  const r = E.decode(html);
  eq('按 meta 解出', r.text.includes(CN), true);
  eq('gb2312 归一化为 gbk', r.charset, 'gbk');
}

console.log('\n=== meta 在 http-equiv 形式 ===');
{
  const html = Buffer.concat([
    Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gbk">', 'latin1'),
    gbk,
  ]);
  const r = E.decode(html);
  eq('按 http-equiv meta 解出', r.text.includes(CN), true);
}

console.log('\n=== BOM 优先于 Content-Type ===');
{
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
  const r = E.decode(bom, { contentType: 'text/html; charset=gbk' });
  eq('BOM 胜出，内容正确', r.text, CN);
  ok('charset 含 utf-8', /utf-8/i.test(r.charset), `实际 ${r.charset}`);
}

console.log('\n=== 显式 charset 参数优先级最高 ===');
{
  const r = E.decode(gbk, { charset: 'gbk', contentType: 'text/html; charset=utf-8' });
  eq('显式参数胜出', r.text, CN);
}

console.log('\n=== ALIAS 归一化 ===');
{
  eq('gb2312 → gbk', E.normalize('gb2312'), 'gbk');
  eq('GBK 大写 → gbk', E.normalize('GBK'), 'gbk');
  eq('GB18030 → gb18030', E.normalize('gb18030'), 'gb18030');
  eq('utf8 → utf-8', E.normalize('utf8'), 'utf-8');
  eq('UTF-8 大小写', E.normalize('UTF-8'), 'utf-8');
}

console.log('\n=== fromContentType ===');
{
  eq('带引号', E.fromContentType('text/html; charset="gbk"'), 'gbk');
  eq('无空格', E.fromContentType('text/html;charset=gb2312'), 'gbk');
  eq('无 charset', E.fromContentType('text/html'), null);
  eq('空串', E.fromContentType(''), null);
}

console.log('\n=== fromHtmlMeta 只扫前 4KB ===');
{
  const far = Buffer.concat([Buffer.alloc(8192, 0x20), Buffer.from('<meta charset="gbk">', 'latin1')]);
  eq('超出 4KB 不识别', E.fromHtmlMeta(far), null);
  const near = Buffer.from('<html><meta charset="gbk">', 'latin1');
  eq('4KB 内识别', E.fromHtmlMeta(near), 'gbk');
}

console.log('\n=== looksLikeUtf8：严格校验 ===');
{
  ok('合法 utf-8 通过', E.looksLikeUtf8(utf8) === true);
  ok('GBK 字节被判否', E.looksLikeUtf8(gbk) === false, `gbk 字节=${gbk.toString('hex')}`);
  // 孤立续字节
  ok('孤立续字节 0x80 被判否', E.looksLikeUtf8(Buffer.from([0x41, 0x80, 0x42])) === false);
  // 合法两字节序列
  ok('合法 2 字节序列通过', E.looksLikeUtf8(Buffer.from([0xc3, 0xa9])) === true);
  // 截断的三字节序列
  ok('截断 3 字节序列被判否', E.looksLikeUtf8(Buffer.from([0xe4, 0xb8])) === false);
}

console.log('\n=== encode（POST body 用） ===');
{
  const back = E.encode(CN, 'gbk');
  eq('gbk 往返', E.decode(back, { charset: 'gbk' }).text, CN);
  const backU = E.encode(CN, 'utf-8');
  eq('utf-8 往返', backU.toString('utf8'), CN);
}

console.log('\n=== 空输入 ===');
{
  const r = E.decode(Buffer.alloc(0));
  eq('空 buffer 得到空串', r.text, '');
}

console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
