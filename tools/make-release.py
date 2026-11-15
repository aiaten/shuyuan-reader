#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""创建/更新 GitHub Release 并上传分发包。

用于「发版」这一步：打完 zip 后跑一次，把包挂到 Release 附件上（仓库里不放二进制）。
访问 api.github.com / uploads.github.com；若环境只放行 API 而拦 github.com，
用 tools/push-via-api.py 推代码，本脚本负责挂附件。

用法:
    GITHUB_TOKEN=ghp_xxx python tools/make-release.py <owner/repo> <tag> <zip> [release note 文件]

    # 例：
    GITHUB_TOKEN_FILE=D:/AI/.ghtoken python tools/make-release.py \
        aiaten/shuyuan-reader v0.3.2 "dist/书源阅读器-0.3.2-win64.zip" notes.md
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.github.com'


def token():
    t = os.environ.get('GITHUB_TOKEN')
    if not t:
        f = os.environ.get('GITHUB_TOKEN_FILE')
        if f and os.path.exists(f):
            t = open(f, encoding='utf8').read().strip()
    if not t:
        raise SystemExit('缺少 GITHUB_TOKEN（或 GITHUB_TOKEN_FILE）')
    return t


TOKEN = token()


def req(method, url, data=None, ctype='application/json', timeout=1800):
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header('Authorization', 'token ' + TOKEN)
    r.add_header('Accept', 'application/vnd.github+json')
    r.add_header('Content-Type', ctype)
    r.add_header('User-Agent', 'shuyuan-reader-release')
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            body = resp.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf8', 'replace')
        raise SystemExit('%s %s -> %s %s' % (method, url, e.code, detail[:500]))


def main():
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    slug, tag, zip_path = sys.argv[1], sys.argv[2], sys.argv[3]
    body = ''
    if len(sys.argv) > 4 and os.path.exists(sys.argv[4]):
        body = open(sys.argv[4], encoding='utf8').read()

    rel = None
    try:
        rel = req('GET', '%s/repos/%s/releases/tags/%s' % (API, slug, tag))
    except SystemExit:
        rel = None
    if not rel or not rel.get('id'):
        rel = req('POST', '%s/repos/%s/releases' % (API, slug), {
            'tag_name': tag,
            'name': tag,
            'body': body,
            'target_commitish': 'main',
            'draft': False,
            'prerelease': False,
        })
        print('已创建 Release %s' % rel['html_url'])
    else:
        print('复用已有 Release %s' % rel['html_url'])

    # 附件名用 ASCII：GitHub 会丢弃非 ASCII 字符，中文文件名会变成残名
    name = os.path.basename(zip_path)
    if not name.isascii():
        name = name.encode('ascii', 'ignore').decode().lstrip('-') or 'release-asset.zip'
        print('附件名非 ASCII，改用 %s' % name)

    for a in rel.get('assets', []):
        if a['name'] == name:
            print('附件已存在，跳过：%s (%.1f MB)' % (name, a['size'] / 1048576))
            print('下载地址: %s' % a['browser_download_url'])
            return

    size = os.path.getsize(zip_path)
    print('上传 %s (%.1f MB) …' % (name, size / 1048576))
    data = open(zip_path, 'rb').read()
    asset = req('POST', 'https://uploads.github.com/repos/%s/releases/%s/assets?name=%s'
                % (slug, rel['id'], urllib.parse.quote(name)), data, 'application/zip')
    print('上传完成: %s (%.1f MB)' % (asset['name'], asset['size'] / 1048576))
    print('下载地址: %s' % asset['browser_download_url'])


if __name__ == '__main__':
    main()
