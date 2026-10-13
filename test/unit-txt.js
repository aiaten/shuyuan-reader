'use strict';
/**
 * TXT 导出单元测试（用假数据，不联网）。
 * 覆盖：选项校验/归一化、文件名净化、模板填充、换行与编码、标题去重、
 *       three layouts（single / chapter / volume）、目录与头部拼装。
 * 跑法：node test/unit-txt.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');

const T = require('../src/export/txt.js');

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shuyuan-txt-'));
console.log('临时目录：' + tmpRoot);

// 假书：3 章，第 2 章正文首行重复章名（模拟下载器落盘格式）
const book = {
  id: 'b1',
  name: '测试之书',
  author: '某作者',
  kind: '玄幻\n连载中',
  sourceName: '测试源',
  bookUrl: 'https://e.com/book/1',
  intro: '这是一段简介。\n第二行。',
};
const toc = [
  { index: 0, name: '第1章 开端', url: 'https://e.com/1' },
  { index: 1, name: '第2章 发展', url: 'https://e.com/2' },
  { index: 2, name: '第3章 结局', url: 'https://e.com/3' },
];
const bodies = {
  0: '第1章 开端\n\n正文一。\n\n\n\n正文一续。\n',
  1: '第2章 发展\n\n正文二。',
  2: '正文三（首行不带章名）。',
};
const getChapter = (i) => (bodies[i] === undefined ? null : bodies[i]);

console.log('\n=== normalizeOptions：默认值与容错 ===');
{
  const d = T.normalizeOptions();
  eq('默认 layout', d.layout, 'single');
  eq('默认 encoding', d.encoding, 'utf-8');
  eq('eol 已映射为真实换行符', d.eol, '\r\n');
  eq('默认 chapterTitle 模板', d.chapterTitle, '{name}');
  eq('默认 includeToc', d.includeToc, true);
  eq('默认 onlyDownloaded', d.onlyDownloaded, true);
  eq('默认 pad', d.pad, 4);

  eq('合法 layout 通过', T.normalizeOptions({ layout: 'chapter' }).layout, 'chapter');
  eq('layout 大写归一', T.normalizeOptions({ layout: 'CHAPTER' }).layout, 'chapter');
  eq('非法 layout 回退 single（不抛错）', T.normalizeOptions({ layout: 'bad' }).layout, 'single');
  eq('非法 encoding 回退 utf-8', T.normalizeOptions({ encoding: 'not-a-charset' }).encoding, 'utf-8');
  eq('合法 gbk 保留', T.normalizeOptions({ encoding: 'gbk' }).encoding, 'gbk');
  eq('非法 eol 回退 CRLF', T.normalizeOptions({ eol: 'zzz' }).eol, '\r\n');
  eq('eol=lf 映射', T.normalizeOptions({ eol: 'lf' }).eol, '\n');
  eq('pad 越界钳到 8', T.normalizeOptions({ pad: 99 }).pad, 8);
  eq('pad 负数钳到 0', T.normalizeOptions({ pad: -5 }).pad, 0);
  eq('pad 非数字 → 0', T.normalizeOptions({ pad: 'x' }).pad, 0);

  eq('EOL_MAP crlf', T.EOL_MAP.crlf, '\r\n');
  eq('EOL_MAP lf', T.EOL_MAP.lf, '\n');
}

console.log('\n=== sanitize：文件名净化（非法字符 → _） ===');
{
  eq('非法字符换成 _', T.sanitize('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  eq('保留中文与空格', T.sanitize('诡秘 之主'), '诡秘 之主');
  eq('压空白', T.sanitize('a   b'), 'a b');
  eq('控制字符换 _', T.sanitize('a\u0000b\u001fc'), 'a_b_c');
  eq('首尾去空白', T.sanitize('  a  '), 'a');
  eq('去前导点（防隐藏文件）', T.sanitize('...a'), 'a');
  const long = T.sanitize('x'.repeat(200));
  ok('截断到 80 字', long.length <= 80, `实际 ${long.length}`);
  eq('空串 → fallback', T.sanitize(''), 'untitled');
  eq('自定义 fallback', T.sanitize('///', '未命名'), '___');
  eq('空串自定义 fallback', T.sanitize('', '未命名'), '未命名');
}

console.log('\n=== normalizeText：换行归一（第二参数不影响，EOL 在写盘时转换） ===');
{
  const out = T.normalizeText('a\r\nb\rc\n\n\n\nd');
  eq('CRLF/CR 归一为 LF', out, 'a\nb\nc\n\nd');
  eq('行尾空白去除', T.normalizeText('a   \nb\t\n'), 'a\nb');
  eq('连续 ≥3 换行压到 2', T.normalizeText('a\n\n\n\n\nb'), 'a\n\nb');
  eq('两端去空白', T.normalizeText('\n\n  a  \n\n'), 'a');
  eq('空串', T.normalizeText(''), '');
  eq('null 安全', T.normalizeText(null), '');
}

console.log('\n=== stripLeadingTitle：通过 exportTxt 间接验证（未导出该函数） ===');
{
  // 章名重复剔除走 assemble → stripLeadingTitle，用导出结果观察
  const outDir = path.join(tmpRoot, 'strip');
  const r = T.exportTxt({
    book: { name: 'X' },
    toc: [{ index: 0, name: '第1章 开端' }],
    getChapter: () => '第1章 开端\n\n正文内容在这里。',
    outDir,
    options: { layout: 'single', includeHeader: false, includeToc: false },
  });
  const txt = fs.readFileSync(r.files[0].path, 'utf8');
  const occurrences = (txt.match(/第1章 开端/g) || []).length;
  eq('章名只出现 1 次', occurrences, 1);
  ok('正文保留', txt.includes('正文内容在这里。'));
}
{
  // 首行不是章名 → 不剔除
  const outDir = path.join(tmpRoot, 'strip2');
  const r = T.exportTxt({
    book: { name: 'X' },
    toc: [{ index: 0, name: '第1章 开端' }],
    getChapter: () => '正文首行\n\n其余内容。',
    outDir,
    options: { layout: 'single', includeHeader: false, includeToc: false },
  });
  const txt = fs.readFileSync(r.files[0].path, 'utf8');
  ok('首行不匹配时保留', txt.includes('正文首行'));
  ok('章名来自模板', txt.includes('第1章 开端'));
}

console.log('\n=== exportTxt：single 布局（utf-8 / CRLF） ===');
{
  const outDir = path.join(tmpRoot, 'single');
  const r = T.exportTxt({ book, toc, getChapter, outDir, options: { layout: 'single', encoding: 'utf-8' } });
  eq('1 个文件', r.files.length, 1);
  eq('3 章', r.chapters, 3);
  eq('0 缺失', r.missing, 0);
  eq('layout', r.layout, 'single');
  const txt = fs.readFileSync(r.files[0].path, 'utf8');
  ok('含书名', txt.includes('测试之书'), txt.slice(0, 120));
  ok('含作者', txt.includes('作者：某作者'));
  ok('含来源', txt.includes('测试源'));
  ok('含原书地址', txt.includes('https://e.com/book/1'));
  ok('多行 kind 用 / 连接', txt.includes('玄幻 / 连载中'), txt.split('\n').slice(0, 8).join(' | '));
  ok('含简介', txt.includes('这是一段简介。'));
  ok('含目录', txt.includes('【目录】'));
  ok('目录含章名', txt.includes('第1章 开端') && txt.includes('第3章 结局'));
  ok('正文一存在', txt.includes('正文一。'));
  ok('正文二存在', txt.includes('正文二。'));
  ok('正文三存在', txt.includes('正文三（首行不带章名）。'));
  ok('无重复章名「第1章 开端 开端」', !/第1章 开端\s*\n+\s*第1章 开端/.test(txt));
  ok('无「第1章 第1章」', !/第1章 第1章/.test(txt));
  ok('CRLF 换行', txt.includes('\r\n'));
  ok('不含裸 LF（已全部 CRLF）', !/[^\r]\n/.test(txt), JSON.stringify(txt.slice(0, 200)));
  ok('连续空行已压到 ≤2', !/\n\n\n\n/.test(txt));
}

console.log('\n=== exportTxt：chapter 布局 ===');
{
  const outDir = path.join(tmpRoot, 'chapter');
  const r = T.exportTxt({
    book,
    toc,
    getChapter,
    outDir,
    options: { layout: 'chapter', encoding: 'utf-8', includeHeader: true, fileNameTemplate: '{index}-{name}' },
  });
  // 3 章 + 1 个 __书籍信息.txt
  eq('4 个文件', r.files.length, 4);
  const names = r.files.map((f) => path.basename(f.path)).sort();
  ok('章节文件名含序号', names.some((n) => /^0001-第1章 开端\.txt$/.test(n)), names.join(' | '));
  ok('有书籍信息文件', names.some((n) => /^__/.test(n)), names.join(' | '));
  const ch1 = r.files.find((f) => /0001-/.test(path.basename(f.path)));
  const t1 = fs.readFileSync(ch1.path, 'utf8');
  ok('第1章正文正确', t1.includes('正文一。'), t1.slice(0, 120));
  ok('第1章无重复标题', !/第1章 开端[\s\S]*第1章 开端/.test(t1), t1.slice(0, 200));
}

console.log('\n=== exportTxt：chapter 布局 + 无头部但有目录（仍会写信息文件） ===');
{
  const outDir = path.join(tmpRoot, 'chapter-nohdr');
  const r = T.exportTxt({
    book,
    toc,
    getChapter,
    outDir,
    options: { layout: 'chapter', includeHeader: false, fileNameTemplate: '{index}-{name}' },
  });
  // includeToc 仍为默认 true → 信息文件里只剩目录
  eq('4 个文件（3 章 + 目录信息文件）', r.files.length, 4);
  const infoFile = r.files.find((f) => /__/.test(path.basename(f.path)));
  const infoTxt = fs.readFileSync(infoFile.path, 'utf8');
  ok('信息文件无作者头', !infoTxt.includes('作者：'));
  ok('信息文件有目录', infoTxt.includes('【目录】'));
}
{
  const outDir = path.join(tmpRoot, 'chapter-minimal');
  const r = T.exportTxt({
    book,
    toc,
    getChapter,
    outDir,
    options: { layout: 'chapter', includeHeader: false, includeToc: false, fileNameTemplate: '{index}-{name}' },
  });
  eq('3 个文件（头与目录都关掉）', r.files.length, 3);
}

console.log('\n=== exportTxt：volume 布局（无卷标 → 退化为单文件） ===');
{
  const outDir = path.join(tmpRoot, 'volume-flat');
  const r = T.exportTxt({ book, toc, getChapter, outDir, options: { layout: 'volume' } });
  // 信息文件 + 退化后的单文件
  eq('2 个文件（信息 + 单文件）', r.files.length, 2);
  const body = r.files.find((f) => !/__/.test(path.basename(f.path)));
  ok('单文件在书名目录下', body.path.includes('测试之书'), body.path);
  const txt = fs.readFileSync(body.path, 'utf8');
  ok('含正文一', txt.includes('正文一。'));
  ok('含正文三', txt.includes('正文三'));
}

console.log('\n=== exportTxt：volume 布局（有卷标） ===');
{
  const tocV = [
    { index: 0, name: '第一卷 启程', isVolume: true },
    { index: 1, name: '第1章 开端' },
    { index: 2, name: '第2章 发展' },
    { index: 3, name: '第二卷 终局', isVolume: true },
    { index: 4, name: '第3章 结局' },
  ];
  const bodiesV = { 1: '正文一。', 2: '正文二。', 4: '正文三。' };
  const outDir = path.join(tmpRoot, 'volume');
  const r = T.exportTxt({
    book,
    toc: tocV,
    getChapter: (i) => bodiesV[i] || null,
    outDir,
    options: { layout: 'volume', dirName: '测试之书' },
  });
  eq('3 个文件（信息 + 2 卷）', r.files.length, 3);
  const volFiles = r.files.filter((f) => !/__/.test(path.basename(f.path)));
  eq('2 个卷文件', volFiles.length, 2);
  const names = volFiles.map((f) => path.basename(f.path)).sort();
  ok('卷文件名取自卷标', names.some((n) => n.includes('第一卷')), names.join(' | '));
  ok('卷文件名取自卷标(2)', names.some((n) => n.includes('第二卷')), names.join(' | '));
  // 每卷只含自己的章节
  const vol1 = volFiles.find((f) => f.path.includes('第一卷'));
  const v1 = fs.readFileSync(vol1.path, 'utf8');
  ok('第一卷含正文一', v1.includes('正文一。'));
  ok('第一卷不含正文三', !v1.includes('正文三。'));
  // 卷标条目本身没有正文，不应导致 0 字节文件
  ok('卷文件非空', v1.trim().length > 10, JSON.stringify(v1.slice(0, 80)));
}

console.log('\n=== 编码：gbk ===');
{
  const outDir = path.join(tmpRoot, 'gbk');
  const r = T.exportTxt({ book, toc, getChapter, outDir, options: { layout: 'single', encoding: 'gbk' } });
  const buf = fs.readFileSync(r.files[0].path);
  const decoded = iconv.decode(buf, 'gbk');
  eq('gbk 往返正确', decoded.includes('测试之书'), true);
  ok('gbk 字节不是 utf-8 中文', !buf.includes(Buffer.from('测试之书', 'utf8')), buf.slice(0, 40).toString('hex'));
  ok('无 BOM', !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf));
}

console.log('\n=== BOM 选项 ===');
{
  const outDir = path.join(tmpRoot, 'bom');
  const r = T.exportTxt({
    book,
    toc,
    getChapter,
    outDir,
    options: { layout: 'single', encoding: 'utf-8', bom: true },
  });
  const buf = fs.readFileSync(r.files[0].path);
  ok('有 UTF-8 BOM', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, buf.slice(0, 3).toString('hex'));
}

console.log('\n=== LF 换行选项 ===');
{
  const outDir = path.join(tmpRoot, 'lf');
  const r = T.exportTxt({ book, toc, getChapter, outDir, options: { layout: 'single', eol: 'lf' } });
  const txt = fs.readFileSync(r.files[0].path, 'utf8');
  ok('无 CR', !txt.includes('\r'));
}

console.log('\n=== includeToc: false ===');
{
  const outDir = path.join(tmpRoot, 'notoc');
  const r = T.exportTxt({
    book,
    toc,
    getChapter,
    outDir,
    options: { layout: 'single', includeToc: false, includeHeader: false, includeIntro: false },
  });
  const txt = fs.readFileSync(r.files[0].path, 'utf8');
  ok('无【目录】', !txt.includes('【目录】'));
  ok('无书名头', !txt.includes('作者：'));
  ok('正文仍在', txt.includes('正文一。'));
}

console.log('\n=== 未下载章节：onlyDownloaded ===');
{
  const outDir = path.join(tmpRoot, 'partial');
  const r = T.exportTxt({
    book,
    toc,
    getChapter: (i) => (i === 1 ? '第2章 发展\n\n只有第二章。' : null),
    outDir,
    options: { layout: 'single' },
  });
  eq('只导出 1 章', r.chapters, 1);
  eq('missing 记 2 章', r.missing, 2);
  const txt = fs.readFileSync(r.files[0].path, 'utf8');
  ok('含第二章', txt.includes('只有第二章。'));
  ok('不含第一章正文', !txt.includes('正文一。'));
}

console.log('\n=== 字节数统计 ===');
{
  const outDir = path.join(tmpRoot, 'bytes');
  const r = T.exportTxt({ book, toc, getChapter, outDir, options: { layout: 'single' } });
  const actual = fs.statSync(r.files[0].path).size;
  eq('bytes 与实际文件大小一致', r.bytes, actual);
}

console.log('\n=== 原子写：临时文件不残留 ===');
{
  const outDir = path.join(tmpRoot, 'atomic');
  T.exportTxt({ book, toc, getChapter, outDir, options: { layout: 'single' } });
  const leftovers = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tmp$/.test(e.name)) leftovers.push(p);
    }
  };
  walk(outDir);
  eq('无 .tmp 残留', leftovers, []);
}

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch (_) {
  /* ignore */
}

console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
