// 通过 GitHub REST API 推送改动（多文件版）。
//
// 用途：本机 `github.com:443` 会被间歇性阻断（`api.github.com` / `codeload` 一直正常），
// 此时 `git push` 报 `Recv failure: Connection was reset` 或
// `Failed to connect to github.com:443`，重试也无效。本脚本改走 REST API：
// 上传 blob → 基于父树建新树 → 建提交 → 移动 ref。只需要 token 有 `repo` scope。
//
// 用法: node tools/api-push.js aiaten/shuyuan-reader main <父提交sha> "<commit message>" [文件清单文件]
//   文件清单文件为 JSON：{"src/engine/source.js":"src/engine/source.js", ...}
//   （远端路径 -> 本地路径）。省略则读取 tools/.push-files.json。
//
// 单次推送全部提交差异的做法：
//   node tools/api-push.js aiaten/shuyuan-reader main <parentSha> "msg" tools/.push-files.json
//
// 校验法：脚本打印的 `new tree` 若与 `git rev-parse HEAD^{tree}` 完全一致，
// 说明远端内容与本地逐字节相同（树 SHA 内容寻址），可据此确认推送正确。
// 推完记得 `git fetch origin main` + `git reset --soft origin/main` 对齐本地 ref。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const [repo, branch, parentSha, message, manifestPath] = process.argv.slice(2);
if (!repo || !branch || !parentSha || !message) {
  console.error('用法: node tools/api-push.js <owner/repo> <branch> <parentSha> "<message>" [manifest.json]');
  process.exit(2);
}

function apiGet(url) {
  const out = execFileSync(GH, ['api', url], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return JSON.parse(out);
}

// POST/PATCH，body 走临时文件保证 JSON 完整传递（长 base64 不能当命令行参数）
function send(method, url, body) {
  const tmp = path.join(os.tmpdir(), 'gh-api-body-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
  // 注意：--input 必须紧跟在 URL 之后
  const out = execFileSync(GH, ['api', '--method', method, url, '--input', tmp],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return JSON.parse(out);
}

const manifestFile = manifestPath || path.join(__dirname, '.push-files.json');
const mapping = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const pairs = Object.entries(mapping);
console.log(`准备推送 ${pairs.length} 个文件到 ${repo}:${branch}`);
if (!pairs.length) { console.error('文件清单为空'); process.exit(2); }

// 1. 取父提交与父树
const parent = apiGet(`repos/${repo}/git/commits/${parentSha}`);
const baseTree = parent.tree.sha;
const fullTree = apiGet(`repos/${repo}/git/trees/${baseTree}?recursive=1`);
console.log('base tree =', baseTree, 'entries =', fullTree.tree.length, 'truncated =', !!fullTree.truncated);
if (fullTree.truncated) { console.error('tree 被截断，需要分页处理'); process.exit(1); }
const known = new Set(fullTree.tree.map((e) => e.path));

// 2. 逐个上传 blob
const treeEntries = [];
for (const [remotePath, localPath] of pairs) {
  const abs = path.isAbsolute(localPath) ? localPath : path.resolve(__dirname, '..', localPath);
  if (!fs.existsSync(abs)) { console.error(`本地文件不存在: ${abs}`); process.exit(1); }
  const content = fs.readFileSync(abs).toString('base64');
  const blob = send('POST', `repos/${repo}/git/blobs`, { encoding: 'base64', content });
  if (!blob.sha) { console.error('blob 上传失败', blob); process.exit(1); }
  const isNew = !known.has(remotePath);
  treeEntries.push({ path: remotePath, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  ${isNew ? '[新增]' : '[覆盖]'} ${remotePath}  ${fs.statSync(abs).size}B  blob=${blob.sha.slice(0, 8)}`);
}

// 3. 建新 tree（base_tree + 覆盖/新增，其余条目由服务端原样继承）
const newTree = send('POST', `repos/${repo}/git/trees`, { base_tree: baseTree, tree: treeEntries });
if (!newTree.sha) { console.error('建树失败', newTree); process.exit(1); }
console.log('new tree =', newTree.sha);

// 4. 建提交
const commit = send('POST', `repos/${repo}/git/commits`, { message, tree: newTree.sha, parents: [parentSha] });
if (!commit.sha) { console.error('建提交失败', commit); process.exit(1); }
console.log('commit   =', commit.sha);

// 5. 移动 ref（ref 必须写全 refs/heads/<branch>）
const updated = send('PATCH', `repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
console.log('ref updated =', updated.object && updated.object.sha);
console.log('\n提示：本地对齐请执行 git fetch origin ' + branch + ' && git reset --soft origin/' + branch);
