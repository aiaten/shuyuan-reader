'use strict';
/** CookieJar 单元测试（离线） */
const path = require('path');
const { CookieJar, domainMatch, splitSetCookie } = require(path.join(__dirname, '..', 'src', 'net', 'cookiejar'));

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got  = ${JSON.stringify(got)}\n       want = ${JSON.stringify(want)}`); }
}

console.log('domainMatch');
eq('.example.com vs a.example.com', domainMatch('.example.com', 'a.example.com'), true);
eq('.example.com vs example.com', domainMatch('.example.com', 'example.com'), true);
eq('.example.com vs notexample.com', domainMatch('.example.com', 'notexample.com'), false);
eq('empty domain', domainMatch('', 'anything'), true);

console.log('splitSetCookie');
eq(
  '两枚 cookie 合并',
  splitSetCookie('a=1; Path=/, b=2; Path=/'),
  ['a=1; Path=/', 'b=2; Path=/']
);
eq(
  '带 Expires 的逗号不切',
  splitSetCookie('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2'),
  ['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'b=2']
);

console.log('CookieJar');
const jar = new CookieJar();
jar.setFromResponse('https://www.zuizhong.net/a/b', ['SID=abc123; Path=/; HttpOnly', 'lang=zh; Path=/a']);
eq('path 匹配', jar.getCookieHeader('https://www.zuizhong.net/a/b/c'), 'SID=abc123; lang=zh');
eq('path 不匹配只留根', jar.getCookieHeader('https://www.zuizhong.net/x'), 'SID=abc123');
eq('get(name)', jar.get('SID', 'https://www.zuizhong.net/'), 'abc123');
eq('getCookieString 同 header', jar.getCookieString('https://www.zuizhong.net/x'), 'SID=abc123');

// 子域注入能否被父域读到
jar.setFromResponse('https://sub.zuizhong.net/', ['sub=1']); // 无 domain 属性 → host-only
eq('host-only 不外泄', jar.getCookieHeader('https://www.zuizhong.net/'), 'SID=abc123');
jar.setFromResponse('https://sub.zuizhong.net/', ['root=1; Domain=.zuizhong.net']);
eq('Domain 属性可共享', jar.getCookieHeader('https://www.zuizhong.net/'), 'SID=abc123; root=1');

eq('remove(name)', (jar.remove('SID', 'https://www.zuizhong.net/'), jar.getCookieHeader('https://www.zuizhong.net/')), 'root=1');

const jar2 = new CookieJar();
jar2.setCookieString('https://www.zuizhong.net/', 'a=1; b=2');
eq('setCookieString', jar2.getCookieHeader('https://www.zuizhong.net/'), 'a=1; b=2');
eq('toJSON 长度', jar2.toJSON().length, 2);
const jar3 = new CookieJar();
jar3.loadJSON(jar2.toJSON());
eq('toJSON/loadJSON 往返', jar3.getCookieHeader('https://www.zuizhong.net/'), 'a=1; b=2');
eq('clone', jar2.clone().getCookieHeader('https://www.zuizhong.net/'), 'a=1; b=2');

jar2.removeCookie('https://www.zuizhong.net/');
eq('removeCookie 清域', jar2.getCookieHeader('https://www.zuizhong.net/'), '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
