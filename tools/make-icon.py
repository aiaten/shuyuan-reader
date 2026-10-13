#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成应用图标 app.ico。

设计：圆角矩形深蓝底（#2f6fed，与 GUI 主题色一致）+ 白色「书」字轮廓。
不依赖中文字体渲染（不同机器字体缺失会画成方框），改用几何图形画一本翻开的书：
  左页 / 右页 / 中缝，外加一条书签飘带。
输出多尺寸 ico（16/24/32/48/64/128/256），Windows 资源管理器与任务栏各取所需。
"""
import os
import sys

from PIL import Image, ImageDraw

# 与 electron/renderer/style.css 的 --primary / --primary-dark 一致
BG_TOP = (47, 111, 237, 255)    # #2f6fed
BG_BOT = (37, 89, 196, 255)     # #2559c4
PAGE = (255, 255, 255, 255)
PAGE_SHADE = (222, 232, 252, 255)
SPINE = (180, 200, 240, 255)
RIBBON = (255, 122, 89, 255)    # 书签飘带，暖色点缀

SIZES = [16, 24, 32, 48, 64, 128, 256]


def rounded_mask(size, radius_ratio=0.22):
    """圆角矩形遮罩。"""
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    r = max(1, int(size * radius_ratio))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m


def vertical_gradient(size, top, bottom):
    """竖直渐变底。"""
    img = Image.new('RGBA', (size, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(4))
        d.line([(0, y), (size, y)], fill=c)
    return img


def draw_book(size):
    """在透明画布上画一本翻开的书。坐标全部按比例，保证任意尺寸下形状一致。"""
    # 超采样 4 倍再缩小，避免小尺寸锯齿
    S = size * 4
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    u = S / 100.0                      # 1 单位 = 1%
    cx = S / 2.0

    # 书的外框（左右两页合起来的梯形，略带透视）
    left_top, left_bot = 22 * u, 78 * u
    right_top, right_bot = 78 * u, 78 * u
    top_y, mid_y, bot_y = 26 * u, 30 * u, 78 * u

    # 左页：左上(22,28) 中缝(50,32) 中缝下(50,80) 左下(22,76)
    d.polygon([(left_top, 28 * u), (cx, mid_y), (cx, 80 * u), (left_top, 76 * u)], fill=PAGE)
    # 右页
    d.polygon([(right_top, 28 * u), (cx, mid_y), (cx, 80 * u), (right_top, 76 * u)], fill=PAGE_SHADE)
    # 中缝阴影
    d.polygon([(cx - 1.6 * u, mid_y), (cx + 1.6 * u, mid_y), (cx + 1.6 * u, 80 * u), (cx - 1.6 * u, 80 * u)], fill=SPINE)

    # 书页横线（文字示意）：左页 3 条、右页 3 条
    lw = max(1, int(2.0 * u))
    for i, yy in enumerate([40, 51, 62]):
        inset = 3.0 * u
        d.line([(left_top + 5 * u, yy * u + inset * 0), (cx - 4 * u, (yy + 1.5) * u - (1.5 * u) * (i == 2))], fill=(200, 214, 244, 255), width=lw)
        d.line([(cx + 4 * u, (yy + 1.5) * u - (1.5 * u) * (i == 2)), (right_top - 5 * u, yy * u)], fill=(200, 214, 244, 255), width=lw)

    # 书签飘带：从右侧书页顶部垂下
    rx = 63 * u
    d.polygon([(rx, 26 * u), (rx + 7 * u, 26 * u), (rx + 7 * u, 44 * u), (rx + 3.5 * u, 39 * u), (rx, 44 * u)], fill=RIBBON)

    return img.resize((size, size), Image.LANCZOS)


def make_frame(size):
    """合成单尺寸图标：渐变圆角底 + 书。"""
    base = vertical_gradient(size, BG_TOP, BG_BOT)
    base.putalpha(rounded_mask(size))
    book = draw_book(size)
    return Image.alpha_composite(base, book)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'build', 'app.ico')
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    frames = [make_frame(s) for s in SIZES]
    frames[-1].save(out, format='ICO', sizes=[(s, s) for s in SIZES], append_images=frames[:-1])

    # 同时导出 PNG 便于预览
    preview = os.path.join(os.path.dirname(out), 'icon-preview.png')
    make_frame(256).save(preview)

    print('OK  %s  (%d bytes)' % (out, os.path.getsize(out)))
    print('    %s' % preview)


if __name__ == '__main__':
    main()
