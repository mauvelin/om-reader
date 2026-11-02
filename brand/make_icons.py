#!/usr/bin/env python3
"""OM Reader 圖示產生器：宣紙底＋墨線＋一塊草木染（與數獨站、旅遊站同一套材質語彙）。

用法：python brand/make_icons.py [A|B|C]   不帶參數＝三款都畫＋總覽圖
輸出：brand/out/<款>/icon-180.png（apple-touch，滿版不透明）、icon-192.png、icon-512.png、favicon-32.png
      brand/preview.png（三款並排＋主畫面尺寸模擬）
紙紋與染色的作法照 OM repo sudoku/brand/make_brand.py（固定 seed，重跑結果相同）。需要 Pillow、numpy。
"""
import math
import os
import random
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

PAPER = "#fbf8f1"
INK = "#26262b"
DYES = {  # 草木染六色（亮）
    "madder": "#A8463A", "persimmon": "#C4763A", "apricot": "#B8933A",
    "moss": "#6B8A4F", "indigo": "#3F6A94", "mulberry": "#6E5A94",
}


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _smooth_noise(rng, w, h, cell):
    gw, gh = max(2, w // cell + 2), max(2, h // cell + 2)
    small = Image.fromarray(((rng.random((gh, gw)) * 255).astype(np.uint8)), "L")
    return np.asarray(small.resize((w, h), Image.BICUBIC), dtype=np.float32) / 127.5 - 1.0


def paper(w, h, seed=11, strength=0.55, base=PAPER):
    rng = np.random.default_rng(seed)
    r = random.Random(seed)
    img = np.ones((h, w, 3), dtype=np.float32) * np.array(rgb(base), dtype=np.float32)
    cloud = (0.55 * _smooth_noise(rng, w, h, max(8, w // 6)) + 0.30 * _smooth_noise(rng, w, h, max(6, w // 18))
             + 0.15 * _smooth_noise(rng, w, h, max(4, w // 48)))
    img -= (np.clip(-cloud, 0, None)[..., None] * 7.0 * strength) * np.array([0.9, 1.0, 1.35], dtype=np.float32)
    img += np.clip(cloud, 0, None)[..., None] * 1.5 * strength
    grain = Image.fromarray((rng.random((h, w)) * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.6))
    img += (np.asarray(grain, dtype=np.float32) / 127.5 - 1.0)[..., None] * 4.0 * strength
    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    scale = max(0.35, min(w, h) / 630)
    for _ in range(int(w * h / 900 * strength)):
        x, y, ang = r.uniform(0, w), r.uniform(0, h), r.uniform(0, math.pi)
        length, bend = r.uniform(6, 34) * scale, r.uniform(-0.6, 0.6)
        pts = [(x + math.cos(ang + bend * (k / 6 - 0.5)) * length * k / 6,
                y + math.sin(ang + bend * (k / 6 - 0.5)) * length * k / 6) for k in range(7)]
        col = (150, 128, 92, r.randint(14, 38)) if r.random() < 0.55 else (255, 255, 250, r.randint(60, 130))
        d.line(pts, fill=col, width=1)
    layer = layer.filter(ImageFilter.GaussianBlur(0.35 * scale + 0.2))
    return Image.alpha_composite(out.convert("RGBA"), layer).convert("RGB")


def dye_layer(size, color, seed=3):
    w, h = size
    rng = np.random.default_rng(seed)
    c = np.array(rgb(color), dtype=np.float32)
    m = 0.7 * _smooth_noise(rng, w, h, max(4, w // 3)) + 0.3 * _smooth_noise(rng, w, h, max(3, w // 9))
    a = c[None, None, :] * (1.0 + 0.05 * m[..., None]) + (255 - c[None, None, :]) * np.clip(m, 0, None)[..., None] * 0.06
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")


def put_dye_mask(canvas, mask, color, seed=3):
    """以 multiply 把染色疊在 mask（L，白＝染）範圍內，保留紙紋。"""
    tinted = ImageChops.multiply(Image.eval(canvas, lambda v: min(255, int(v * 1.012 + 2))), dye_layer(canvas.size, color, seed))
    canvas.paste(tinted, (0, 0), mask)


def brush_stroke(S, pts, widths, seed=1, color=INK):
    """沿點列以變寬圓點疊出毛筆筆觸，邊緣帶一點乾筆飛白。回傳 RGBA 圖層。"""
    layer = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(layer)
    for (x, y), w in zip(pts, widths):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=255)
    rng = np.random.default_rng(seed)
    noise = _smooth_noise(rng, S, S, max(3, S // 140))
    a = np.asarray(layer, dtype=np.float32) / 255.0
    edge = np.asarray(layer.filter(ImageFilter.GaussianBlur(S * 0.004)), dtype=np.float32) / 255.0
    a = np.clip(edge * (0.92 + 0.08 * noise) - np.clip(noise - 0.55, 0, None) * 0.9 * (a < 1.01), 0, 1)
    out = Image.new("RGBA", (S, S), rgb(color) + (0,))
    out.putalpha(Image.fromarray((a * 255).astype(np.uint8), "L"))
    return out


# ── 三款 ─────────────────────────────────────────────────
def draw_A(S, bg):
    """A 書頁與書籤：攤開的一本書（墨線），中縫垂下一條桑葚紫書籤。"""
    d = ImageDraw.Draw(bg)
    ink, lw = rgb(INK), max(3, round(S * 0.026))
    cx, top, bot = S * 0.5, S * 0.30, S * 0.70
    left, right = S * 0.20, S * 0.80
    sag = S * 0.035
    # 書籤（先染）：從中縫頂端垂到書下方，末端剪成燕尾
    bw = S * 0.075
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    by0, by1 = top - S * 0.02, bot + S * 0.14
    md.polygon([(cx - bw / 2, by0), (cx + bw / 2, by0), (cx + bw / 2, by1), (cx, by1 - bw * 0.7), (cx - bw / 2, by1)], fill=255)
    put_dye_mask(bg, mask, DYES["mulberry"], seed=7)
    # 兩頁外框：上緣微微下凹的弧
    for side in (-1, 1):
        x_out = left if side < 0 else right
        pts_top = [(cx + (x_out - cx) * t, top + sag * math.sin(math.pi * t) * 0.6) for t in np.linspace(0, 1, 40)]
        pts_bot = [(cx + (x_out - cx) * t, bot + sag * math.sin(math.pi * t)) for t in np.linspace(0, 1, 40)]
        d.line(pts_top, fill=ink, width=lw, joint="curve")
        d.line(pts_bot, fill=ink, width=lw, joint="curve")
        d.line([pts_top[-1], pts_bot[-1]], fill=ink, width=lw)
        # 文字行：三條細線
        for k in range(3):
            y = top + (bot - top) * (0.28 + 0.2 * k)
            x0, x1 = cx + side * S * 0.07, cx + side * (S * 0.07 + (abs(x_out - cx) - S * 0.12) * (1 - 0.18 * (k == 2)))
            d.line([(min(x0, x1), y + sag * 0.3), (max(x0, x1), y + sag * 0.3)], fill=ink, width=max(2, lw // 2))
    d.line([(cx, top), (cx, bot + sag * 0.2)], fill=ink, width=lw)
    return bg


def draw_B(S, bg):
    """B 圓相落款：一筆毛筆圓相（不封口，尾端飛白），右下一枚茜草紅方印。
    筆觸用數十根「筆毛」細線並排畫：每根的橫向位置、墨量、在哪裡斷墨各自不同，尾段自然散開成飛白。"""
    cx, cy, R = S * 0.485, S * 0.475, S * 0.265
    a0 = math.radians(-58)
    sweep = math.radians(326)
    rnd = random.Random(17)
    n = 700

    def width(t):  # 起筆略頓、中段飽滿、收筆漸細
        rise = min(1.0, t / 0.06)
        return S * (0.035 + 0.055 * rise * (1 - t) ** 0.7)

    def center(t):
        a = a0 + sweep * t
        r = R * (1 + 0.03 * math.sin(2 * a + 0.4)) + S * 0.006 * math.sin(9 * t)
        return cx + r * math.cos(a), cy + r * math.sin(a), a

    layer = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(layer)
    bristles = 46
    for k in range(bristles):
        off = (k / (bristles - 1) - 0.5) * 0.96
        dry_from = 0.42 + 0.5 * rnd.random() ** 0.8      # 這根毛從哪裡開始乾
        end = min(1.0, dry_from + 0.05 + 0.35 * rnd.random())
        ink = 205 + rnd.randint(0, 50)
        bw = max(2, round(S * 0.0055 * (0.7 + 0.6 * rnd.random())))
        pts = []
        for i in range(n):
            t = i / (n - 1)
            if t > end:
                break
            x, y, a = center(t)
            w = width(t)
            nx, ny = math.cos(a), math.sin(a)
            o = off * w + S * 0.0015 * math.sin(t * 40 + k)
            pts.append((x + nx * o, y + ny * o))
            # 乾筆段：隨機斷開
            if t > dry_from and rnd.random() < 0.09:
                if len(pts) > 1:
                    d.line(pts, fill=ink, width=bw)
                pts = []
        if len(pts) > 1:
            d.line(pts, fill=ink, width=bw)
    # 中段墨飽滿：再疊一條實心芯，只到 dry 之前
    core = []
    for i in range(n):
        t = i / (n - 1)
        if t > 0.45:
            break
        x, y, _ = center(t)
        w = width(t) * 0.6
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=235)
    layer = layer.filter(ImageFilter.GaussianBlur(S * 0.0012))
    stroke = Image.new("RGBA", (S, S), rgb(INK) + (0,))
    stroke.putalpha(layer)
    # 方印：先染色，再在印裡留紙色細框與一道直線（陰刻感）
    s0 = S * 0.11
    x0, y0 = S * 0.72, S * 0.72
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rectangle([x0, y0, x0 + s0, y0 + s0], fill=255)
    put_dye_mask(bg, mask, DYES["madder"], seed=4)
    dd = ImageDraw.Draw(bg)
    inset, lw = s0 * 0.17, max(2, round(S * 0.008))
    dd.rectangle([x0 + inset, y0 + inset, x0 + s0 - inset, y0 + s0 - inset], outline=rgb(PAPER), width=lw)
    dd.line([(x0 + s0 / 2, y0 + inset), (x0 + s0 / 2, y0 + s0 - inset)], fill=rgb(PAPER), width=lw)
    return Image.alpha_composite(bg.convert("RGBA"), stroke).convert("RGB")


def draw_C(S, bg):
    """C 索引卡疊：三張錯開的方角紙卡（墨線），最上一張頂邊染一條靛青。"""
    d = ImageDraw.Draw(bg)
    ink, lw = rgb(INK), max(3, round(S * 0.024))
    w, h = S * 0.46, S * 0.34
    base_x, base_y = S * 0.20, S * 0.22
    cards = [(base_x + S * 0.12, base_y), (base_x + S * 0.06, base_y + S * 0.09), (base_x, base_y + S * 0.18)]
    for i, (x, y) in enumerate(cards):
        d.rectangle([x, y, x + w, y + h], fill=rgb(PAPER) if i == 2 else None, outline=ink, width=lw)
        if i < 2:
            continue
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rectangle([x + lw / 2, y + lw / 2, x + w - lw / 2, y + h * 0.24], fill=255)
        put_dye_mask(bg, mask, DYES["indigo"], seed=6)
        d = ImageDraw.Draw(bg)
        d.rectangle([x, y, x + w, y + h], outline=ink, width=lw)
        for k in range(3):
            yy = y + h * (0.45 + 0.17 * k)
            d.line([(x + w * 0.12, yy), (x + w * (0.88 - 0.25 * (k == 2)), yy)], fill=ink, width=max(2, lw // 2))
    return bg


def _mandala(S, bg, line_color, center_dye=None):
    """本人 Notion 頁面用的符號：圓環內一個 {8/3} 八角星（頂點在圓環上），每個頂點再往內一根短輻
    （和兩條邊合成「\\|/」三叉）；星的邊在中央圍出一個八邊形。"""
    cx = cy = S / 2
    R = S * 0.335
    lw = max(3, round(S * 0.022))
    ang = lambda k, off: math.radians(-90 + off + 45 * k)
    vs = [(cx + R * math.cos(ang(k, 22.5)), cy + R * math.sin(ang(k, 22.5))) for k in range(8)]
    if center_dye:
        r_oct = R * math.cos(3 * math.pi / 8) / math.cos(math.pi / 8)   # 中央八邊形的頂點半徑（0.414R）
        octo = [(cx + r_oct * math.cos(ang(k, 0)), cy + r_oct * math.sin(ang(k, 0))) for k in range(8)]
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).polygon(octo, fill=255)
        put_dye_mask(bg, mask, DYES[center_dye], seed=8)
    d = ImageDraw.Draw(bg)
    col = rgb(line_color)
    for k in range(8):
        d.line([vs[k], vs[(k + 3) % 8]], fill=col, width=lw)
    for k in range(8):
        a = ang(k, 22.5)
        d.line([(cx + R * math.cos(a), cy + R * math.sin(a)),
                (cx + R * 0.64 * math.cos(a), cy + R * 0.64 * math.sin(a))], fill=col, width=lw)
    ring = max(4, round(S * 0.034))
    d.ellipse([cx - R - ring * 0.35, cy - R - ring * 0.35, cx + R + ring * 0.35, cy + R + ring * 0.35], outline=col, width=ring)
    return bg


def draw_D(S, bg):
    """D 本人的符號（墨線）＋中央八邊形染桑葚紫。"""
    return _mandala(S, bg, INK, center_dye="mulberry")


def draw_E(S, bg):
    """E 本人的符號，整個用桑葚紫一色（像 Notion 上的單色圖示），不另加染色塊。"""
    return _mandala(S, bg, DYES["mulberry"])


DRAW = {"A": draw_A, "B": draw_B, "C": draw_C, "D": draw_D, "E": draw_E}


def icon(kind, size, tile="square"):
    S = size * 4
    bg = draw_kind(kind, S)
    img = bg.convert("RGBA")
    if tile == "rounded":
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.22, fill=255)
        img.putalpha(mask)
    return img.resize((size, size), Image.LANCZOS)


_CACHE = {}


def draw_kind(kind, S):
    key = (kind, S)
    if key not in _CACHE:
        _CACHE[key] = DRAW[kind](S, paper(S, S, seed=23))
    return _CACHE[key].copy()


def main():
    kinds = [a for a in sys.argv[1:] if a in DRAW] or list(DRAW)
    tiles = []
    for k in kinds:
        od = os.path.join(OUT, k)
        os.makedirs(od, exist_ok=True)
        big = icon(k, 512)
        big.convert("RGB").save(os.path.join(od, "icon-512.png"), optimize=True)
        big.resize((192, 192), Image.LANCZOS).convert("RGB").save(os.path.join(od, "icon-192.png"), optimize=True)
        big.resize((180, 180), Image.LANCZOS).convert("RGB").save(os.path.join(od, "icon-180.png"), optimize=True)
        big.resize((32, 32), Image.LANCZOS).convert("RGB").save(os.path.join(od, "favicon-32.png"), optimize=True)
        tiles.append((k, big))
    # 總覽：大圖＋ iPhone 主畫面尺寸（60pt≈180px，切 iOS 圓角）放在亮／暗桌布上
    W = 40 + len(tiles) * 300
    pv = Image.new("RGB", (W, 640), (236, 232, 224))
    dark = Image.new("RGB", (W, 150), (28, 30, 36))
    pv.paste(dark, (0, 490))
    dd = ImageDraw.Draw(pv)
    for i, (k, big) in enumerate(tiles):
        x = 40 + i * 300
        r = big.resize((256, 256), Image.LANCZOS)
        m = Image.new("L", (256, 256), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, 255, 255], radius=58, fill=255)
        pv.paste(r, (x, 30), m)
        dd.text((x, 300), k, fill=(40, 40, 40))
        for j, (sz, y) in enumerate(((120, 330), (60, 515))):
            s = big.resize((sz, sz), Image.LANCZOS)
            mm = Image.new("L", (sz, sz), 0)
            ImageDraw.Draw(mm).rounded_rectangle([0, 0, sz - 1, sz - 1], radius=sz * 0.225, fill=255)
            pv.paste(s, (x + (j * 140), y), mm)
        pv.paste(big.resize((32, 32), Image.LANCZOS), (x + 220, 530))
    pv.save(os.path.join(HERE, "preview.png"))
    print("ok", [k for k, _ in tiles])


if __name__ == "__main__":
    main()
