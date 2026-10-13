// 提取真实书源里 %% 与 $. 的上下文
const fs = require('fs');

for (const id of ['7897', '7931', '7036']) {
  const raw = JSON.parse(fs.readFileSync(`D:/AI/工作区/_recon/src_${id}.json`, 'utf8'));
  const src = Array.isArray(raw) ? raw[0] : raw;
  const s = JSON.stringify(src, null, 1);
  console.log(`\n${'='.repeat(70)}\n${id}  ${src.bookSourceName}\n${'='.repeat(70)}`);

  // 找 %% 所在字段
  const lines = s.split('\n');
  lines.forEach((ln, i) => {
    if (ln.includes('%%')) {
      console.log(`\n[%% 上下文 @行${i + 1}]`);
      console.log(lines.slice(Math.max(0, i - 2), i + 3).join('\n').slice(0, 700));
    }
  });

  // 找 $. 所在的规则值（截取简短片段）
  const found = [];
  (function walk(o, path) {
    if (typeof o === 'string') {
      if (/\$\.|\$\[/.test(o)) found.push(`${path} = ${o.slice(0, 200)}`);
      return;
    }
    if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  })(src, '');
  if (found.length) {
    console.log(`\n[$. 出现的字段 ${found.length} 处，列前 6]`);
    found.slice(0, 6).forEach((f) => console.log('  ' + f));
  }
}
