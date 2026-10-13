// 从 gui-smoke-main.js 提取 PROBE 模板字符串并做语法检查
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'test', 'gui-smoke-main.js'), 'utf8');
const start = src.indexOf('const PROBE = `');
if (start < 0) { console.log('marker not found'); process.exit(1); }
const bodyStart = start + 'const PROBE = `'.length;
// 找到结尾反引号：模板字符串里不能再出现裸反引号（本文件约定），直接找下一个 '`;'
const end = src.indexOf('`;', bodyStart);
if (end < 0) { console.log('end not found'); process.exit(1); }
const body = src.slice(bodyStart, end);
const out = path.join(process.env.TEMP || os.tmpdir(), 'probe-extract.js');
fs.writeFileSync(out, body, 'utf8');
console.log('extracted', body.length, '->', out);
