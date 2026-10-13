/**
 * 检查导出产物内容：node test/check-export.js <导出目录> [预览字数]
 * 打印书籍信息头 + 目录 + 首章正文片段，并做标题重复/正文缺失检测。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const dir = process.argv[2];
const preview = parseInt(process.argv[3] || '800', 10);
if (!dir) {
  console.error('用法: node test/check-export.js <导出目录> [预览字数]');
  process.exit(1);
}

function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const files = walk(dir).filter((f) => f.toLowerCase().endsWith('.txt'));
console.log(`导出目录: ${dir}`);
console.log(`共 ${files.length} 个 txt 文件\n`);

let problems = 0;
for (const f of files) {
  const raw = fs.readFileSync(f);
  // utf-8 优先；解出替换字符则疑似 GBK
  let txt = raw.toString('utf8');
  let enc = 'utf-8';
  if (txt.includes('\ufffd')) {
    txt = iconv.decode(raw, 'gbk');
    enc = 'gbk';
  }
  const rel = path.relative(dir, f);
  console.log('─'.repeat(72));
  console.log(`${rel}  [${enc}]  ${raw.length} B / ${txt.length} 字`);

  const issues = [];
  if (/第\d+章 第\d+章/.test(txt)) issues.push('章标题重复（第N章 第N章）');
  if (/^(第\d+章)\s*\n+\1$/m.test(txt)) issues.push('章标题与正文首行重复');
  if (txt.includes('\ufffd')) issues.push('存在无法解码的替换字符');
  if (txt.trim().length < 50) issues.push('内容过短');
  const bodyStart = txt.indexOf('\n\n\n');
  if (bodyStart > 0 && txt.length - bodyStart < 200) issues.push('疑似只有头部无正文');

  if (issues.length) {
    problems += issues.length;
    console.log(`  ⚠ ${issues.join(' / ')}`);
  } else {
    console.log('  ✓ 结构正常');
  }

  console.log('  --- 预览 ---');
  console.log(
    txt
      .slice(0, preview)
      .split('\n')
      .map((l) => '  | ' + l)
      .join('\n')
  );
  if (txt.length > preview) console.log(`  | …（余 ${txt.length - preview} 字）`);
  console.log('');
}

console.log('═'.repeat(72));
console.log(problems ? `发现 ${problems} 个问题` : '✓ 全部文件结构正常');
process.exit(problems ? 1 : 0);
