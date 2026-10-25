#!/usr/bin/env python3
"""Regenerate build/icon.png, build/icon.ico, and the Store tiles in build/appx/.

Runtime and electron-builder use the committed files, not this script.
Square tiles are resized from the 512px icon.png this script writes.
Requires Pillow: python3 -m pip install pillow && python3 scripts/make-icon.py
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build"

NAVY = (18, 52, 84, 255)
AMBER = (232, 176, 48, 255)
CREAM = (247, 244, 236, 255)
EDGE = (120, 168, 204, 255)

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def _stroke(size):
    if size <= 16:
        return 1
    if size <= 24:
        return 2
    return max(2, round(size * 0.045))


def _in_round_rect(x, y, x0, y0, x1, y1, radius):
    if x < x0 or y < y0 or x > x1 or y > y1:
        return False
    if x >= x0 + radius and x <= x1 - radius:
        return True
    if y >= y0 + radius and y <= y1 - radius:
        return True
    cx = x0 + radius if x < x0 + radius else x1 - radius
    cy = y0 + radius if y < y0 + radius else y1 - radius
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def draw_16():
    """Crisp tray size. Procedural strokes turn into a blob at 16px."""
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    px = img.load()
    for y in range(16):
        for x in range(16):
            if _in_round_rect(x, y, 1, 1, 14, 14, 3):
                px[x, y] = NAVY
    for y in range(16):
        for x in range(16):
            if px[x, y][3] == 0:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if nx < 0 or ny < 0 or nx > 15 or ny > 15 or px[nx, ny][3] == 0:
                    px[x, y] = EDGE
                    break
    cx = cy = 7.5
    for y in range(16):
        for x in range(16):
            if px[x, y][3] == 0:
                continue
            dist = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            if 4.15 <= dist <= 5.35:
                px[x, y] = AMBER
    for x, y in ((6, 6), (5, 5), (8, 6), (9, 5), (10, 4)):
        px[x, y] = CREAM
    px[7, 7] = AMBER
    px[8, 7] = AMBER
    px[7, 8] = AMBER
    return img


def draw(size):
    if size == 16:
        return draw_16()
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    margin = max(1, round(size * 0.06))
    radius = max(2, round(size * 0.23))
    box = [margin, margin, size - 1 - margin, size - 1 - margin]
    d.rounded_rectangle(box, radius=radius, fill=NAVY, outline=EDGE, width=max(1, round(size * 0.015)))

    cx = cy = (size - 1) / 2.0
    radius_face = size * (0.30 if size <= 24 else 0.275)
    ring = _stroke(size)
    d.ellipse(
        [cx - radius_face, cy - radius_face, cx + radius_face, cy + radius_face],
        outline=AMBER,
        width=ring,
    )

    def hand(deg, length, width):
        angle = math.radians(deg - 90)
        x2 = cx + math.cos(angle) * length
        y2 = cy + math.sin(angle) * length
        d.line([(cx, cy), (x2, y2)], fill=CREAM, width=width)
        cap = max(1, width // 2)
        d.ellipse([x2 - cap, y2 - cap, x2 + cap, y2 + cap], fill=CREAM)

    if size <= 16:
        hour_w, minute_w = 1, 1
    elif size <= 32:
        hour_w, minute_w = 2, 1
    else:
        hour_w = max(2, round(size * 0.04))
        minute_w = max(2, round(size * 0.028))

    # 10:10, the usual "clock icon" time, so the hands stay out of the hub.
    hand(300, radius_face * 0.50, hour_w)
    hand(55, radius_face * 0.74, minute_w)

    hub = max(1, round(size * 0.045))
    d.ellipse([cx - hub, cy - hub, cx + hub, cy + hub], fill=AMBER)
    return img


def square_logo(icon, size):
    return icon.resize((size, size), Image.LANCZOS)


def wide_logo(icon, width, height):
    """Navy field, icon at the left, room on the right for the tile name."""
    canvas = Image.new("RGBA", (width, height), NAVY)
    side = max(1, int(height * 0.72))
    glyph = icon.resize((side, side), Image.LANCZOS)
    x = max(0, int(height * 0.14))
    y = max(0, (height - side) // 2)
    canvas.paste(glyph, (x, y), glyph)
    return canvas


def write_appx_tiles(icon):
    appx = OUT / "appx"
    appx.mkdir(parents=True, exist_ok=True)
    tiles = {
        "StoreLogo.png": square_logo(icon, 50),
        "Square44x44Logo.png": square_logo(icon, 44),
        "Square150x150Logo.png": square_logo(icon, 150),
        "Wide310x150Logo.png": wide_logo(icon, 310, 150),
        "LargeTile.png": square_logo(icon, 310),
        "SmallTile.png": square_logo(icon, 71),
        "BadgeLogo.png": square_logo(icon, 24),
        "SplashScreen.png": wide_logo(icon, 620, 300),
    }
    for name, image in tiles.items():
        dest = appx / name
        image.save(dest, format="PNG")
        print(f"wrote {dest} {image.size[0]}x{image.size[1]} ({dest.stat().st_size} bytes)")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    images = [draw(size) for size in ICO_SIZES]
    png = draw(512)
    png_path = OUT / "icon.png"
    ico_path = OUT / "icon.ico"
    png.save(png_path, format="PNG")
    images[-1].save(
        ico_path,
        format="ICO",
        sizes=[(image.width, image.height) for image in images],
        append_images=images[:-1],
    )
    print(f"wrote {png_path} ({png_path.stat().st_size} bytes)")
    print(f"wrote {ico_path} ({ico_path.stat().st_size} bytes)")
    write_appx_tiles(png)


if __name__ == "__main__":
    main()
