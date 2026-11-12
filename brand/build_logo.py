"""Build every FLOW logo asset from one set of geometry.

Run from the repo root:  python3 brand/build_logo.py
Needs `rsvg-convert` (librsvg) for the PNG / ICO output.

Writes:
  brand/svg/   master SVGs (symbol, small-size symbol, wordmark, horizontal + stacked lockups, colour variants)
  brand/png/   PNG renders of the masters
  public/      favicon.svg, favicon.ico, apple-touch-icon.png, icons/*.png, manifest.webmanifest
"""

import json
import shutil
import struct
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand"
SVG_DIR = BRAND / "svg"
PNG_DIR = BRAND / "png"
PUBLIC = ROOT / "public"
ICONS = PUBLIC / "icons"

# ---------------------------------------------------------------- colour
VOID = "#05030c"  # game background
VOID_LIFT = "#1a1040"  # centre of the app-icon backdrop
GRID = "#3a3366"  # COLORS.panelEdge, the warp-grid line colour
INK = "#e8f6ff"  # COLORS.text, wordmark on dark
CYAN = "#00f0ff"  # palette 'cyan': the cells
MAGENTA = "#ff2bd6"  # palette 'magenta': the pods
CYAN_DEEP = "#008aa6"  # cells on light backgrounds (4.0:1 on white)
MAGENTA_DEEP = "#c4009c"  # pods on light backgrounds (5.5:1 on white)

SCHEMES = {
    # name: (cells, pods, wordmark)
    "color": (CYAN, MAGENTA, INK),
    "color-light": (CYAN_DEEP, MAGENTA_DEEP, VOID),
    "black": ("#000000", "#000000", "#000000"),
    "white": ("#ffffff", "#ffffff", "#ffffff"),
    "cyan": (CYAN, CYAN, CYAN),
}


def num(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


# ---------------------------------------------------------------- symbol geometry
# Grid: cell 48, gap 12 (pitch 60), corner radius 10. Four cells form the stem; the arms are pods
# (capsules) with a cell-radius left end and a fully round right end. Arm lengths 124 / 84.
CELL, GAP, RAD = 48, 12, 10
PITCH = CELL + GAP


def rounded_rect(x, y, w, h, r):
    return (
        f"M{num(x + r)} {num(y)}H{num(x + w - r)}A{r} {r} 0 0 1 {num(x + w)} {num(y + r)}"
        f"V{num(y + h - r)}A{r} {r} 0 0 1 {num(x + w - r)} {num(y + h)}H{num(x + r)}"
        f"A{r} {r} 0 0 1 {num(x)} {num(y + h - r)}V{num(y + r)}A{r} {r} 0 0 1 {num(x + r)} {num(y)}Z"
    )


def pod(x, y, w, h, r):
    """Capsule: left corners radius r, right end a full semicircle."""
    R = h / 2
    return (
        f"M{num(x + r)} {num(y)}H{num(x + w - R)}A{num(R)} {num(R)} 0 0 1 {num(x + w - R)} {num(y + h)}"
        f"H{num(x + r)}A{r} {r} 0 0 1 {num(x)} {num(y + h - r)}V{num(y + r)}A{r} {r} 0 0 1 {num(x + r)} {num(y)}Z"
    )


def symbol_parts(cell=CELL, gap=GAP, rad=RAD, rows=4, arms=(124, 84)):
    """Returns (cells_d, pods_d, width, height) at the origin."""
    pitch = cell + gap
    cells = "".join(rounded_rect(0, i * pitch, cell, cell, rad) for i in range(rows))
    ax = cell + gap
    pods = "".join(pod(ax, i * pitch, w, cell, rad) for i, w in enumerate(arms))
    width = ax + max(arms)
    height = rows * cell + (rows - 1) * gap
    return cells, pods, width, height


SYM_CELLS, SYM_PODS, SYM_W, SYM_H = symbol_parts()  # 184 × 228
# Small-size cut: three rows on a 16-unit grid so it lands on whole pixels at 16 / 32 / 48 px.
# 16 px plan: cells 3×3 px at x=3, rows y=2/6/10, arms 6 px and 4 px wide starting at x=7.
SMALL_CELLS, SMALL_PODS, SMALL_W, SMALL_H = symbol_parts(cell=48, gap=16, rad=8, rows=3, arms=(96, 64))


def group(cells, pods, cell_fill, pod_fill, transform=""):
    t = f' transform="{transform}"' if transform else ""
    return f'<g{t}><path fill="{cell_fill}" d="{cells}"/><path fill="{pod_fill}" d="{pods}"/></g>'


# ---------------------------------------------------------------- wordmark geometry
# Squared geometric caps that echo Orbitron (the in-game font). Cap height 64, stroke 14, outlined (no live text).
WM_S, WM_H = 14, 64
WM_SPACING = (14, 12, 16)  # F-L, L-O, O-W: tightened where the letter has an open side


def wordmark_d():
    S, H = WM_S, WM_H
    parts = []
    x = 0
    parts.append(f"M{x} 0H{x + 52}V{S}H{x + S}V25H{x + 44}V{25 + S}H{x + S}V{H}H{x}Z")  # F
    x += 52 + WM_SPACING[0]
    parts.append(f"M{x} 0H{x + S}V{H - S}H{x + 52}V{H}H{x}Z")  # L
    x += 52 + WM_SPACING[1]
    parts.append(rounded_rect(x, 0, 64, H, 16) + rounded_rect(x + S, S, 64 - 2 * S, H - 2 * S, 4))  # O
    x += 64 + WM_SPACING[2]
    w, r = 80, 16
    parts.append(  # W
        f"M{x} 0H{x + S}V{H - S - 4}A4 4 0 0 0 {x + S + 4} {H - S}H{x + 33}V0H{x + 47}V{H - S}"
        f"H{x + w - S - 4}A4 4 0 0 0 {x + w - S} {H - S - 4}V0H{x + w}V{H - r}A{r} {r} 0 0 1 {x + w - r} {H}"
        f"H{x + r}A{r} {r} 0 0 1 {x} {H - r}Z"
    )
    x += w
    return "".join(parts), x


WM_D, WM_W = wordmark_d()


def wordmark(fill, transform=""):
    t = f' transform="{transform}"' if transform else ""
    return f'<path{t} fill="{fill}" fill-rule="evenodd" d="{WM_D}"/>'


# ---------------------------------------------------------------- documents
def svg_doc(body, w, h, title, defs=""):
    d = f"<defs>{defs}</defs>" if defs else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {num(w)} {num(h)}" width="{num(w)}" height="{num(h)}" '
        f'role="img" aria-labelledby="title"><title id="title">{title}</title>{d}{body}</svg>\n'
    )


def symbol_svg(scheme):
    cf, pf, _ = SCHEMES[scheme]
    # 256 canvas; the F is left-heavy, so it sits 6 units right of geometric centre.
    tx = (256 - SYM_W) / 2 + 6
    ty = (256 - SYM_H) / 2
    return svg_doc(group(SYM_CELLS, SYM_PODS, cf, pf, f"translate({num(tx)} {num(ty)})"), 256, 256, "FLOW symbol")


def small_symbol_svg(scheme):
    cf, pf, _ = SCHEMES[scheme]
    return svg_doc(group(SMALL_CELLS, SMALL_PODS, cf, pf, "translate(48 32)"), 256, 256, "FLOW symbol (small sizes)")


def wordmark_svg(scheme):
    fill = SCHEMES[scheme][2]
    return svg_doc(wordmark(fill), WM_W, WM_H, "FLOW wordmark")


# Lockups: wordmark cap height = two cells + a gap (108), so it lines up with the F's arms in height.
# Clear space unit = one cell (48).
WM_SCALE = (2 * CELL + GAP) / WM_H


def horizontal_svg(scheme):
    cf, pf, wf = SCHEMES[scheme]
    gap = CELL
    wm_y = (SYM_H - WM_H * WM_SCALE) / 2
    w = SYM_W + gap + WM_W * WM_SCALE
    body = group(SYM_CELLS, SYM_PODS, cf, pf) + wordmark(
        wf, f"translate({num(SYM_W + gap)} {num(wm_y)}) scale({num(WM_SCALE)})"
    )
    return svg_doc(body, w, SYM_H, "FLOW logo")


def stacked_svg(scheme):
    cf, pf, wf = SCHEMES[scheme]
    scale = WM_SCALE * 0.8
    wm_w = WM_W * scale
    w = max(wm_w, SYM_W)
    gap = CELL
    body = group(SYM_CELLS, SYM_PODS, cf, pf, f"translate({num((w - SYM_W) / 2 + 4)} 0)") + wordmark(
        wf, f"translate({num((w - wm_w) / 2)} {num(SYM_H + gap)}) scale({num(scale)})"
    )
    return svg_doc(body, w, SYM_H + gap + WM_H * scale, "FLOW logo (stacked)")


# ---------------------------------------------------------------- icons (neon treatment)
def backdrop_defs(size):
    grid = size / 8
    return (
        f'<radialGradient id="bg" cx="50%" cy="42%" r="70%"><stop offset="0" stop-color="{VOID_LIFT}"/>'
        f'<stop offset="1" stop-color="{VOID}"/></radialGradient>'
        f'<pattern id="grid" width="{num(grid)}" height="{num(grid)}" patternUnits="userSpaceOnUse">'
        f'<path d="M{num(grid)} 0H0V{num(grid)}" fill="none" stroke="{GRID}" stroke-width="{num(max(1, size / 256))}"/></pattern>'
        f'<filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="{num(size * 0.03)}"/></filter>'
        f'<filter id="halo" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="{num(size * 0.09)}"/></filter>'
    )


def neon_icon_svg(size, mark_frac, small=False, glow=True, radius=0.0, grid=True):
    """Mark in neon colours on the dark backdrop. mark_frac = mark height / icon size."""
    cells, pods, mw, mh = (SMALL_CELLS, SMALL_PODS, SMALL_W, SMALL_H) if small else (SYM_CELLS, SYM_PODS, SYM_W, SYM_H)
    s = size * mark_frac / mh
    # optical centring: nudge right (left-heavy F) and up 2 %
    tx = (size - mw * s) / 2 + size * 0.02
    ty = (size - mh * s) / 2 - size * 0.02
    t = f"translate({num(tx)} {num(ty)}) scale({num(s)})"
    rx = num(size * radius)
    body = f'<rect width="{size}" height="{size}" rx="{rx}" fill="url(#bg)"/>'
    if grid:
        body += f'<rect width="{size}" height="{size}" rx="{rx}" fill="url(#grid)" opacity=".35"/>'
    if glow:
        body += f'<g filter="url(#halo)" opacity=".55">{group(cells, pods, CYAN, MAGENTA, t)}</g>'
        body += f'<g filter="url(#glow)" opacity=".9">{group(cells, pods, CYAN, MAGENTA, t)}</g>'
    body += group(cells, pods, CYAN, MAGENTA, t)
    return svg_doc(body, size, size, "FLOW", backdrop_defs(size))


def favicon_svg():
    """Flat (no glow) small cut on a dark rounded tile: crisp at 16 px, readable on light and dark tabs."""
    body = f'<rect width="256" height="256" rx="56" fill="{VOID}"/>' + group(SMALL_CELLS, SMALL_PODS, CYAN, MAGENTA, "translate(48 32)")
    return svg_doc(body, 256, 256, "FLOW")


# ---------------------------------------------------------------- rendering
def render(svg_path: Path, png_path: Path, width: int, height: int | None = None):
    png_path.parent.mkdir(parents=True, exist_ok=True)
    args = ["rsvg-convert", "-w", str(width)]
    if height:
        args += ["-h", str(height)]
    subprocess.run(args + [str(svg_path), "-o", str(png_path)], check=True)


def write_ico(pngs: list[Path], out: Path):
    """ICO with embedded PNG images (supported by every current browser)."""
    data = [p.read_bytes() for p in pngs]
    header = struct.pack("<HHH", 0, 1, len(data))
    offset = 6 + 16 * len(data)
    entries = b""
    for blob in data:
        w, h = struct.unpack(">II", blob[16:24])
        entries += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    out.write_bytes(header + entries + b"".join(data))


def main():
    for d in (SVG_DIR, PNG_DIR, ICONS):
        d.mkdir(parents=True, exist_ok=True)

    masters = {}
    for scheme in SCHEMES:
        masters[f"flow-symbol-{scheme}.svg"] = symbol_svg(scheme)
        masters[f"flow-symbol-small-{scheme}.svg"] = small_symbol_svg(scheme)
        masters[f"flow-wordmark-{scheme}.svg"] = wordmark_svg(scheme)
        masters[f"flow-horizontal-{scheme}.svg"] = horizontal_svg(scheme)
        masters[f"flow-stacked-{scheme}.svg"] = stacked_svg(scheme)
    masters["flow-app-icon.svg"] = neon_icon_svg(1024, 0.56, radius=0.225)
    for name, text in masters.items():
        (SVG_DIR / name).write_text(text)

    # PNG renders of the main masters (transparent)
    for name in ("flow-symbol-color", "flow-symbol-color-light", "flow-symbol-white", "flow-symbol-black"):
        render(SVG_DIR / f"{name}.svg", PNG_DIR / f"{name}-512.png", 512)
    for name in ("flow-horizontal-color", "flow-horizontal-color-light", "flow-horizontal-white", "flow-horizontal-black"):
        render(SVG_DIR / f"{name}.svg", PNG_DIR / f"{name}-1200.png", 1200)
    for name in ("flow-stacked-color", "flow-stacked-color-light"):
        render(SVG_DIR / f"{name}.svg", PNG_DIR / f"{name}-800.png", 800)
    render(SVG_DIR / "flow-app-icon.svg", PNG_DIR / "flow-app-icon-1024.png", 1024)

    # Web icons
    (PUBLIC / "favicon.svg").write_text(favicon_svg())
    tmp = BRAND / ".ico-tmp"
    tmp.mkdir(exist_ok=True)
    ico_pngs = []
    for s in (16, 32, 48):
        p = tmp / f"favicon-{s}.png"
        render(PUBLIC / "favicon.svg", p, s)
        ico_pngs.append(p)
    write_ico(ico_pngs, PUBLIC / "favicon.ico")
    shutil.rmtree(tmp)

    icon_jobs = {
        # iOS rounds the corners itself, so the touch icon is full-bleed.
        PUBLIC / "apple-touch-icon.png": (180, neon_icon_svg(180, 0.56)),
        ICONS / "icon-192.png": (192, neon_icon_svg(192, 0.56, radius=0.225)),
        ICONS / "icon-512.png": (512, neon_icon_svg(512, 0.56, radius=0.225)),
        # Maskable: full-bleed, mark kept inside the 80 % safe circle.
        ICONS / "icon-maskable-512.png": (512, neon_icon_svg(512, 0.46)),
    }
    for out, (size, text) in icon_jobs.items():
        src = BRAND / ".icon.svg"
        src.write_text(text)
        render(src, out, size)
        src.unlink()

    manifest = {
        "name": "FLOW",
        "short_name": "FLOW",
        "description": "A neon plasma puzzle: drain the glowing image into pods without jamming the lanes.",
        "start_url": "./",
        "scope": "./",
        "display": "fullscreen",
        "orientation": "portrait",
        "background_color": VOID,
        "theme_color": VOID,
        "icons": [
            {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    (PUBLIC / "manifest.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n")
    print("built", len(masters), "SVG masters + web icons")


if __name__ == "__main__":
    main()
