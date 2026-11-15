#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""通过 GitHub Git Data API 推送本地提交。

为什么需要它：某些受限网络/代理环境只放行 `api.github.com`，`github.com`
的 443 直连与 CONNECT 隧道都被挡，`git push` 必然失败。本脚本用 REST API
重建提交（blob → tree → commit → 更新 ref），提交对象的 message / author /
committer / 时间戳逐字节复制，因此生成的 commit sha 与本地完全一致，
远端和本地不会产生「内容相同但历史分叉」的问题。

用法:
    GITHUB_TOKEN=ghp_xxx python tools/push-via-api.py <repo_dir> <owner/repo> <branch> <start_commit>

    start_commit = 远端已经存在的最后一个本地提交，其后的提交会被依次推送；
                   传 "-" 表示用 origin/<branch>。

    # 远端被推歪了（例如中途失败），先强制回退到 start 再重放：
    RESET_REMOTE=1 GITHUB_TOKEN=... python tools/push-via-api.py ... 

token 也可以放到文件里，用环境变量 GITHUB_TOKEN_FILE 指向它。
"""
import base64
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

TOKEN = os.environ.get('GITHUB_TOKEN')
if not TOKEN:
    token_file = os.environ.get('GITHUB_TOKEN_FILE')
    if token_file and os.path.exists(token_file):
        TOKEN = open(token_file, encoding='utf8').read().strip()

API = 'https://api.github.com'
IDENT = re.compile(r'^(.*) <(.*)> (\d+) ([+-]\d{4})$')


def git(repo, *args, binary=False):
    r = subprocess.run(['git'] + list(args), cwd=repo, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError('git %s 失败: %s' % (args, r.stderr.decode('utf8', 'replace')))
    return r.stdout if binary else r.stdout.decode('utf8').strip()


def api(method, path, payload=None):
    data = json.dumps(payload).encode('utf8') if payload is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header('Authorization', 'token ' + TOKEN)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('Content-Type', 'application/json')
    req.add_header('User-Agent', 'shuyuan-reader-push')
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            body = resp.read().decode('utf8')
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf8', 'replace')
        raise RuntimeError('%s %s -> %s %s' % (method, path, e.code, detail[:600]))


def parse_ident(raw):
    """'Name <mail> 1763... +0800' -> API 需要的 name/email/date（等价的同一时刻）。"""
    m = IDENT.match(raw)
    if not m:
        raise RuntimeError('无法解析身份: ' + raw)
    name, email, epoch, offset = m.group(1), m.group(2), int(m.group(3)), m.group(4)
    sign = 1 if offset[0] == '+' else -1
    tz = datetime.timezone(sign * datetime.timedelta(hours=int(offset[1:3]), minutes=int(offset[3:5])))
    return {'name': name, 'email': email, 'date': datetime.datetime.fromtimestamp(epoch, tz).isoformat()}


def main():
    if len(sys.argv) < 5:
        raise SystemExit(__doc__)
    repo, fullname, branch, start = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    if not TOKEN:
        raise SystemExit('缺少 GITHUB_TOKEN（或 GITHUB_TOKEN_FILE）')

    remote_head = api('GET', '/repos/%s/git/ref/heads/%s' % (fullname, branch))['object']['sha']

    if os.environ.get('RESET_REMOTE') == '1':
        api('PATCH', '/repos/%s/git/refs/heads/%s' % (fullname, branch),
            {'sha': git(repo, 'rev-parse', start), 'force': True})
        remote_head = git(repo, 'rev-parse', start)
        print('已强制回退远端 %s -> %s' % (branch, remote_head[:7]))

    prev_tree = api('GET', '/repos/%s/git/commits/%s' % (fullname, remote_head))['tree']['sha']
    print('远端 HEAD = %s (tree %s)' % (remote_head[:7], prev_tree[:7]))

    rng = 'origin/%s..HEAD' % branch if start in ('-', '') else '%s..HEAD' % start
    commits = git(repo, 'rev-list', '--reverse', rng).split()
    if not commits:
        print('没有需要推送的提交')
        return
    print('待推提交 %d 个: %s\n' % (len(commits), ' '.join(c[:7] for c in commits)))

    prev_commit = remote_head
    for sha in commits:
        # 从原始 commit 对象精确取字段（含 message 尾换行），保证 sha 与本地一致
        raw = git(repo, 'cat-file', 'commit', sha, binary=True)
        head_part, body = raw.split(b'\n\n', 1)
        local_tree = author_raw = committer_raw = None
        for line in head_part.decode('utf8').split('\n'):
            if line.startswith('tree '):
                local_tree = line[5:]
            elif line.startswith('author '):
                author_raw = line[7:]
            elif line.startswith('committer '):
                committer_raw = line[10:]
        message = body.decode('utf8')

        # 变更集 = 本地父提交 -> 该提交（diff-tree 的参数顺序就是 A -> B，
        # 写反了新增文件会被看成删除，API 创建 tree 时直接 422 BadObjectState）
        local_parent = git(repo, 'rev-parse', sha + '^')
        changed = git(repo, 'diff-tree', '-r', '--no-commit-id', '--name-status',
                      '--no-renames', '--diff-filter=ACDMT', local_parent, sha)
        entries = []
        for line in [l for l in changed.split('\n') if l.strip()]:
            status, path = line.split('\t', 1)
            if status.startswith('D'):
                entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': None})
                continue
            ls = git(repo, 'ls-tree', sha, '--', path)
            if not ls:
                continue
            left, p = ls.split('\t', 1)
            mode, otype, blob_sha = left.split()
            content = git(repo, 'cat-file', 'blob', blob_sha, binary=True)
            blob = api('POST', '/repos/%s/git/blobs' % fullname,
                       {'content': base64.b64encode(content).decode('ascii'), 'encoding': 'base64'})
            entries.append({'path': p, 'mode': mode, 'type': otype, 'sha': blob['sha']})

        if not entries:
            print('  %s 无文件变更，跳过' % sha[:7])
            continue

        tree = api('POST', '/repos/%s/git/trees' % fullname, {'base_tree': prev_tree, 'tree': entries})
        if tree['sha'] != local_tree:
            print('   ! 警告：远端 tree %s 与本地 %s 不同' % (tree['sha'][:10], local_tree[:10]))
        commit = api('POST', '/repos/%s/git/commits' % fullname, {
            'message': message,
            'tree': tree['sha'],
            'parents': [prev_commit],
            'author': parse_ident(author_raw),
            'committer': parse_ident(committer_raw),
        })
        same = 'sha 一致' if commit['sha'] == sha else 'sha 不同(%s)' % commit['sha'][:7]
        print('  %s -> %s (%d 文件, %s) %s' % (sha[:7], commit['sha'][:7], len(entries), same,
                                               message.split('\n')[0][:50]))
        prev_commit = commit['sha']
        prev_tree = tree['sha']

    if prev_commit != remote_head:
        api('PATCH', '/repos/%s/git/refs/heads/%s' % (fullname, branch), {'sha': prev_commit, 'force': False})
        print('\n已更新 %s -> %s' % (branch, prev_commit))
        local_head = git(repo, 'rev-parse', 'HEAD')
        if prev_commit == local_head:
            subprocess.run(['git', 'update-ref', 'refs/remotes/origin/%s' % branch, prev_commit], cwd=repo, check=True)
            print('远端与本地 HEAD 完全一致，origin/%s 引用已同步' % branch)
        else:
            print('注意：远端 %s 与本地 HEAD %s 不同' % (prev_commit[:7], local_head[:7]))
    else:
        print('\n远端无需变更')


if __name__ == '__main__':
    main()
