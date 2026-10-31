// 通过 GitHub REST API 推送（fetch 版，不依赖 gh CLI）。
// 背景：github.com:443 被阻断，api.github.com 可用；gh auth 校验强制要求 read:org，
// 只有 repo scope 的 token 过不了 gh，但 REST 本身够用。
//
// 用法: GH_TOKEN=ghp_xxx node tools/push-rest.js aiaten/shuyuan-reader main <父提交sha> "<message>" [manifest.json]
//   manifest 为 JSON：{"远端路径":"本地路径", ...}，省略则读 tools/.push-files.json
//
// 校验：打印的 new tree 若等于 `git rev-parse HEAD^{tree}`，说明远端与本地逐字节一致。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 优先读 git 仓库中的规范 blob（autocrlf 下与 `git rev-parse HEAD^{tree}` 精确一致），
// 不在 git 仓库内时回退工作区文件
function readContent(abs, relPath) {
  try {
    return execFileSync('git', ['cat-file', 'blob', `HEAD:${relPath.replace(/\\/g, '/')}`], { maxBuffer: 512 * 1024 * 1024 });
  } catch (_) {
    return fs.readFileSync(abs);
  }
}

const [repo, branch, parentSha, message, manifestPath] = process.argv.slice(2);
if (!repo || !branch || !parentSha || !message) {
  console.error('用法: GH_TOKEN=<token> node tools/push-rest.js <owner/repo> <branch> <父sha> "<msg>" [manifest.json]');
  process.exit(2);
}
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  || (fs.existsSync(path.join(__dirname, '.gh-token')) ? fs.readFileSync(path.join(__dirname, '.gh-token'), 'utf8').trim() : '');
if (!TOKEN) { console.error('缺少 token（GH_TOKEN 环境变量或 tools/.gh-token 文件）'); process.exit(2); }

const API = 'https://api.github.com';
async function api(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'shuyuan-reader-push',
      'Content-Type': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (_) {}
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

(async () => {
  const manifestFile = manifestPath || path.join(__dirname, '.push-files.json');
  const mapping = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const pairs = Object.entries(mapping);
  console.log(`准备推送 ${pairs.length} 个文件到 ${repo}:${branch}`);
  if (!pairs.length) { console.error('文件清单为空'); process.exit(2); }

  // 1. 父提交与基树
  const parent = await api('GET', `/repos/${repo}/git/commits/${parentSha}`);
  const baseTree = parent.tree.sha;
  const fullTree = await api('GET', `/repos/${repo}/git/trees/${baseTree}?recursive=1`);
  console.log('base tree =', baseTree, 'entries =', fullTree.tree.length, 'truncated =', !!fullTree.truncated);
  if (fullTree.truncated) { console.error('tree 被截断，需要分页处理'); process.exit(1); }
  const known = new Set(fullTree.tree.map((e) => e.path));

  // 2. 逐个上传 blob
  const treeEntries = [];
  for (const [remotePath, localPath] of pairs) {
    const abs = path.isAbsolute(localPath) ? localPath : path.resolve(__dirname, '..', localPath);
    if (!fs.existsSync(abs)) { console.error(`本地文件不存在: ${abs}`); process.exit(1); }
    const content = readContent(abs, localPath).toString('base64');
    const blob = await api('POST', `/repos/${repo}/git/blobs`, { encoding: 'base64', content });
    treeEntries.push({ path: remotePath, mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`  ${known.has(remotePath) ? '[覆盖]' : '[新增]'} ${remotePath}  ${content.length}B  blob=${blob.sha.slice(0, 8)}`);
  }

  // 3. 建新树
  const newTree = await api('POST', `/repos/${repo}/git/trees`, { base_tree: baseTree, tree: treeEntries });
  console.log('new tree =', newTree.sha);

  // 4. 建提交
  const commit = await api('POST', `/repos/${repo}/git/commits`, { message, tree: newTree.sha, parents: [parentSha] });
  console.log('commit   =', commit.sha);

  // 5. 移动 ref
  const updated = await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
  console.log('ref updated =', updated.object && updated.object.sha);
  console.log('完成。远端 main 现在指向', commit.sha, '，下次推送请用它当 parentSha');
})().catch((e) => { console.error('推送失败：', e.message); process.exit(1); });
