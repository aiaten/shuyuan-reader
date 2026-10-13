// 通过 GitHub REST API 推送单个文件改动。
//
// 用途：本机 `github.com:443` 会被间歇性阻断（`api.github.com` / `codeload` 一直正常），
// 此时 `git push` 报 `Recv failure: Connection was reset` 或
// `Failed to connect to github.com:443`，重试也无效。本脚本改走 REST API：
// 上传 blob → 基于父树建新树 → 建提交 → 移动 ref。只需要 token 有 `repo` scope。
//
// 用法: node tools/api-push.js <owner/repo> <ref> <父提交sha> <文件相对路径> <本地文件路径> "<commit message>"
// 例:   node tools/api-push.js aiaten/shuyuan-reader heads/main <sha> README.md ./README.md "docs: ..."
//
// 单文件校验法：脚本打印的 `new tree` 若与 `git rev-parse HEAD^{tree}` 完全一致，
// 说明远端内容与本地逐字节相同（树 SHA 是内容寻址的），可据此确认推送正确。
// 推完记得 `git fetch origin <branch>` + `git reset --soft origin/<branch>` 对齐本地 ref。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const [repo, ref, parentSha, relPath, localPath, message] = process.argv.slice(2);

function api(args, input) {
  const opts = { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 };
  let all = args.slice();
  if (input !== undefined) {
    const tmp = path.join(os.tmpdir(), 'gh-api-in-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(tmp, input, 'utf8');
    all = all.concat(['--input', tmp]);
  }
  const out = execFileSync(GH, ['api'].concat(all), opts);
  try { return JSON.parse(out); } catch (e) { return out; }
}

// 简单 GET（把 URL 直接当参数传）
function get(url) {
  const out = execFileSync(GH, ['api', url], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return JSON.parse(out);
}

// POST/PATCH，body 走临时文件保证 JSON 完整传递
function send(method, url, body) {
  const tmp = path.join(os.tmpdir(), 'gh-api-body-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
  const out = execFileSync(GH, ['api', '--method', method, url, '--input', tmp],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return JSON.parse(out);
}

// 1. 上传 blob
const content = fs.readFileSync(localPath, 'base64');
const blob = send('POST', `repos/${repo}/git/blobs`, { encoding: 'base64', content });
console.log('blob =', blob.sha);
if (!blob.sha) { console.error(blob); process.exit(1); }

// 2. 取父提交的 tree，递归列出全部条目
const parent = get(`repos/${repo}/git/commits/${parentSha}`);
const baseTree = parent.tree.sha;
const tree = get(`repos/${repo}/git/trees/${baseTree}?recursive=1`);
console.log('base tree =', baseTree, 'entries =', tree.tree.length, 'truncated =', tree.truncated);
if (tree.truncated) { console.error('tree 被截断，需要分页处理'); process.exit(1); }

// 3. 确认目标文件确实存在于父树中（防止路径写错成新增文件）
const hit = tree.tree.filter((e) => e.path === relPath);
if (hit.length !== 1) { console.error(`父树中 ${relPath} 命中 ${hit.length} 次，预期 1`); process.exit(1); }
console.log('replacing', relPath, hit[0].sha.slice(0, 8), '->', blob.sha.slice(0, 8));

// 4. 建新 tree（base_tree + 一行覆盖，其余 138 个条目由服务端原样继承）
const newTree = send('POST', `repos/${repo}/git/trees`, {
  base_tree: baseTree,
  tree: [{ path: relPath, mode: '100644', type: 'blob', sha: blob.sha }],
});
console.log('new tree =', newTree.sha);
if (!newTree.sha) { console.error(newTree); process.exit(1); }

// 5. 建提交
const commit = send('POST', `repos/${repo}/git/commits`, { message, tree: newTree.sha, parents: [parentSha] });
console.log('commit =', commit.sha);
if (!commit.sha) { console.error(commit); process.exit(1); }

// 6. 移动 ref
const updated = send('PATCH', `repos/${repo}/git/refs/${ref}`, { sha: commit.sha, force: false });
console.log('ref updated =', updated.object && updated.object.sha);
