#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SnapCrop 图标生成脚本（开发期工具，非运行时依赖）

用途：由一张方形源图生成各平台所需的全部图标尺寸与 favicon.ico。
     - 自动去除纯色（白）背景，输出带 alpha 的 PNG
     - maskable 图标按 80% 安全区缩放，避免被系统裁掉圆角内容

依赖：Pillow（仅本脚本需要；SnapCrop 运行时仍然零依赖）
用法：python scripts/generate-icons.py [源图路径]
"""
import os
import sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BRAND = os.path.join(ROOT, "assets", "brand")

DEFAULT_SRC = r"C:\Users\Felix\Downloads\蓝色渐变图片裁剪图标.png"

# 需要生成的尺寸（文件名 -> 边长）
SIZES = {
    "icon-16.png": 16,
    "icon-32.png": 32,
    "icon-48.png": 48,
    "icon-64.png": 64,
    "icon-128.png": 128,
    "icon-180.png": 180,   # apple-touch-icon
    "icon-192.png": 192,   # android-chrome / PWA
    "icon-256.png": 256,
    "icon-512.png": 512,   # PWA
    "icon-1024.png": 1024,
}
ICO_SIZES = [(16, 16), (32, 32), (48, 48)]
MASKABLE_SIZE = 512
MASKABLE_SAFE = 0.80      # 安全区占比


def strip_bg(img, thresh=40):
    """洪水填充去除外部纯色背景。

    关键：填充必须作用在源图副本上（否则阈值无从比较），
    再把被染成标记色的区域 alpha 置 0。图标内部的白色元素
    （如太阳、山峰）与外部不连通，因此不会被误伤。
    """
    img = img.convert("RGBA")
    w, h = img.size
    work = img.copy()
    MARK = (255, 0, 255, 255)   # 品红标记色，图标本身不含此色
    for seed in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        ImageDraw.floodfill(work, seed, MARK, thresh=thresh)

    src = img.load()
    wk = work.load()
    cleared = 0
    for y in range(h):
        for x in range(w):
            r, g, b, _a = wk[x, y]
            if r == 255 and g == 0 and b == 255:
                src[x, y] = (r, g, b, 0)
                cleared += 1
    return img, cleared


def trim_and_square(img):
    """按 alpha 边界裁掉空白，再补为正方形（保证各尺寸构图一致）。"""
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    w, h = img.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2))
    return canvas


def main():
    src_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.exists(src_path):
        print("源图不存在：%s" % src_path)
        return 1

    os.makedirs(BRAND, exist_ok=True)
    src = Image.open(src_path)
    img, cleared = strip_bg(src)
    img = trim_and_square(img)
    print("源图 %dx%d，清除背景像素 %d 个，裁剪后 %dx%d"
          % (src.size[0], src.size[1], cleared, img.size[0], img.size[1]))

    for name, side in SIZES.items():
        out = img.resize((side, side), Image.LANCZOS)
        path = os.path.join(BRAND, name)
        out.save(path, "PNG", optimize=True)
        print("  ✓ %-16s %4dpx  %6.1f KB" % (name, side, os.path.getsize(path) / 1024))

    # favicon.ico（多尺寸合一）
    ico_path = os.path.join(BRAND, "favicon.ico")
    img.save(ico_path, "ICO", sizes=ICO_SIZES)
    print("  ✓ %-16s %s  %6.1f KB"
          % ("favicon.ico", "16/32/48", os.path.getsize(ico_path) / 1024))

    # maskable：缩到 80% 安全区，四周留白，避免系统遮罩裁掉内容
    m = Image.new("RGBA", (MASKABLE_SIZE, MASKABLE_SIZE), (0, 0, 0, 0))
    inner = int(MASKABLE_SIZE * MASKABLE_SAFE)
    pad = (MASKABLE_SIZE - inner) // 2
    m.paste(img.resize((inner, inner), Image.LANCZOS), (pad, pad))
    mp = os.path.join(BRAND, "icon-maskable-512.png")
    m.save(mp, "PNG", optimize=True)
    print("  ✓ %-16s %4dpx  %6.1f KB"
          % ("icon-maskable-512.png", MASKABLE_SIZE, os.path.getsize(mp) / 1024))

    print("完成：%d 个 PNG + favicon.ico + maskable" % (len(SIZES) + 0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
