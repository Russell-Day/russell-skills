#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright>=1.40"]
# ///
"""Before/after image for a UI change: each screen's before and after side by side,
numbered boxes on what changed, and a legend saying what each number is.

    uv run scripts/before_after.py spec.json --out compare.png
    uv run scripts/before_after.py --grid shot.png --out shot-grid.png   # find box coordinates

spec.json (image paths are relative to the spec file):

    {
      "title": "Agents page: before / after",
      "pairs": [
        {
          "label": "New thread (desktop, dark)",
          "before": "before-desktop-new.png",
          "after": "after-desktop-new.png",
          "changes": [
            {"after": [560, 180, 900, 260], "before": [160, 90, 900, 120],
             "note": "Project, model and effort move from three selects into chips in the composer",
             "zoom": true}
          ]
        }
      ]
    }

A box is [x, y, width, height] in the image's own pixels, or as fractions of its size
when all four numbers are at most 1. "after" marks the spot in the after shot, "before"
the same spot in the before shot (either may be left out). "zoom": true adds cropped
close-ups of the boxes, before and after, next to the legend line, for changes too small to see at
full size. Numbers restart at 1 for each pair. A pair with no "changes" is a plain side
by side.

--grid draws a labelled 100 px grid over one screenshot so you can read box coordinates
off it. Better still, take boxes from the DOM while you capture: Playwright's
locator.bounding_box() times the device scale factor.

Writes the PNG plus the same page as HTML next to it (.html).
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import mimetypes
import struct
import sys
from pathlib import Path

ACCENT = "#f43f5e"  # rose: readable on dark and light screenshots alike


def png_size(path: Path) -> tuple[int, int]:
    head = path.read_bytes()[:24]
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path}: only PNG screenshots are supported")
    return struct.unpack(">II", head[16:24])


def data_uri(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def to_px(box: list[float] | None, w: int, h: int) -> list[float] | None:
    if not box:
        return None
    if len(box) != 4:
        raise SystemExit(f"a box needs 4 numbers [x, y, width, height], got {box}")
    if all(0 <= v <= 1 for v in box):
        return [box[0] * w, box[1] * h, box[2] * w, box[3] * h]
    return [float(v) for v in box]


def shot(uri: str, w: int, h: int, boxes: list[tuple[int, list[float]]], dashed: bool, caption: str) -> str:
    marks = []
    stroke = max(3, round(w / 400))
    r = max(16, round(w / 70))
    placed: list[tuple[float, float]] = []
    for n, (x, y, bw, bh) in boxes:
        dash = f' stroke-dasharray="{stroke * 3} {stroke * 2}"' if dashed else ""
        cx, cy = max(r, x), max(r, y)
        while any(abs(cx - px) < 2.2 * r and abs(cy - py) < 2.2 * r for px, py in placed):
            cx += 2.4 * r  # nested or touching boxes: slide the badge right so numbers never stack
        placed.append((cx, cy))
        marks.append(
            f'<rect x="{x}" y="{y}" width="{bw}" height="{bh}" rx="{r / 3}" fill="none" '
            f'stroke="{ACCENT}" stroke-width="{stroke}"{dash}/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{ACCENT}" stroke="#fff" stroke-width="{stroke / 1.5}"/>'
            f'<text x="{cx}" y="{cy}" fill="#fff" font-size="{r * 1.15}" font-weight="700" '
            f'text-anchor="middle" dominant-baseline="central">{n}</text>'
        )
    svg = (f'<svg viewBox="0 0 {w} {h}" preserveAspectRatio="none">{"".join(marks)}</svg>' if marks else "")
    return (f'<figure><figcaption>{html.escape(caption)}</figcaption>'
            f'<div class="shot"><img src="{uri}">{svg}</div></figure>')


def crop(uri: str, w: int, h: int, box: list[float], max_w: int, max_h: int = 240) -> str:
    x, y, bw, bh = box
    pad = 0.12
    x0, y0 = max(0.0, x - bw * pad), max(0.0, y - bh * pad)
    x1, y1 = min(float(w), x + bw * (1 + pad)), min(float(h), y + bh * (1 + pad))
    x, y, bw, bh = x0, y0, max(1.0, x1 - x0), max(1.0, y1 - y0)
    scale = min(max_w / bw, max_h / bh, 2.0)
    return (f'<div class="crop" style="width:{bw * scale:.0f}px;height:{bh * scale:.0f}px;'
            f'background-image:url({uri});background-size:{w * scale:.0f}px {h * scale:.0f}px;'
            f'background-position:{-x * scale:.0f}px {-y * scale:.0f}px"></div>')


def pair_html(pair: dict, base: Path, width: int) -> str:
    imgs = {}
    for side in ("before", "after"):
        p = (base / pair[side]).expanduser()
        if not p.is_file():
            raise SystemExit(f"no such image: {p}")
        w, h = png_size(p)
        imgs[side] = (data_uri(p), w, h)
    boxes = {"before": [], "after": []}
    legend = []
    for n, ch in enumerate(pair.get("changes", []), 1):
        px = {s: to_px(ch.get(s), imgs[s][1], imgs[s][2]) for s in ("before", "after")}
        for s in ("before", "after"):
            if px[s]:
                boxes[s].append((n, px[s]))
        zoom = ""
        if ch.get("zoom"):
            parts = []
            for s, label in (("before", "before"), ("after", "after")):
                if px[s]:
                    uri, w, h = imgs[s]
                    parts.append(f'<div class="zc"><span>{label}</span>{crop(uri, w, h, px[s], width - 40)}</div>')
            zoom = f'<div class="zoom">{"".join(parts)}</div>'
        legend.append(f'<li><b>{n}</b><div><p>{html.escape(ch.get("note", ""))}</p>{zoom}</div></li>')
    figs = "".join(shot(imgs[s][0], imgs[s][1], imgs[s][2], boxes[s], s == "before", s.capitalize())
                   for s in ("before", "after"))
    label = f"<h2>{html.escape(pair.get('label', ''))}</h2>" if pair.get("label") else ""
    leg = f'<ol class="legend">{"".join(legend)}</ol>' if legend else ""
    return f'<section style="--w:{width}px">{label}<div class="row">{figs}</div>{leg}</section>'


STYLE = """
body{margin:0;padding:28px;background:#f4f4f5;color:#18181b;font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
h1{font-size:20px;margin:0 0 20px} h2{font-size:16px;margin:0 0 10px}
section{margin:0 0 36px;width:calc(var(--w)*2 + 20px)}
.row{display:flex;gap:20px;align-items:flex-start}
figure{margin:0;width:var(--w)} figcaption{font-weight:600;font-size:13px;color:#52525b;margin:0 0 6px;text-transform:uppercase;letter-spacing:.04em}
.shot{position:relative;line-height:0;border-radius:10px;overflow:hidden;box-shadow:0 0 0 1px rgb(0 0 0/.1),0 4px 16px rgb(0 0 0/.1)}
.shot img{width:100%;height:auto} .shot svg{position:absolute;inset:0;width:100%;height:100%}
.legend{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:10px}
.legend li{display:flex;gap:10px;align-items:flex-start}
.legend b{flex:none;width:24px;height:24px;border-radius:50%;background:ACCENT;color:#fff;font-size:13px;display:grid;place-items:center}
.legend p{margin:2px 0 0}
.zoom{display:flex;gap:20px;margin-top:8px;align-items:flex-start}
.zc span{display:block;font-size:12px;color:#71717a;margin-bottom:4px}
.crop{background-repeat:no-repeat;border-radius:6px;box-shadow:0 0 0 1px rgb(0 0 0/.15)}
""".replace("ACCENT", ACCENT)


def grid_html(path: Path) -> str:
    w, h = png_size(path)
    lines = []
    for x in range(0, w, 100):
        lines.append(f'<line x1="{x}" y1="0" x2="{x}" y2="{h}"/><text x="{x + 3}" y="14">{x}</text>')
    for y in range(100, h, 100):
        lines.append(f'<line x1="0" y1="{y}" x2="{w}" y2="{y}"/><text x="3" y="{y - 3}">{y}</text>')
    return (f'<!doctype html><meta charset="utf-8"><style>body{{margin:0}}div{{position:relative;line-height:0}}'
            f'svg{{position:absolute;inset:0}}line{{stroke:{ACCENT};stroke-opacity:.55;stroke-width:1}}'
            f'text{{fill:{ACCENT};font:bold 13px monospace;paint-order:stroke;stroke:#fff;stroke-width:3px}}</style>'
            f'<div><img src="{data_uri(path)}" width="{w}" height="{h}">'
            f'<svg width="{w}" height="{h}">{"".join(lines)}</svg></div>'), w


def render(doc: str, out: Path, width: int) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit("playwright isn't installed: run with `uv run scripts/before_after.py ...`")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.with_suffix(".html").write_text(doc, encoding="utf-8")
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as exc:
            if "Executable doesn't exist" not in str(exc):
                raise
            raise SystemExit("Chromium for this playwright isn't downloaded: run "
                             "`uv run --with playwright playwright install --only-shell chromium`, then retry.")
        pg = browser.new_page(viewport={"width": width, "height": 800})
        pg.set_content(doc, wait_until="load")
        pg.screenshot(path=str(out), full_page=True)
        browser.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec", nargs="?", help="spec JSON (see above)")
    ap.add_argument("--out", required=True, help="output PNG")
    ap.add_argument("--width", type=int, default=0,
                    help="display width of each screenshot in px (default 760; 400 when every shot is phone-sized)")
    ap.add_argument("--grid", metavar="IMAGE", help="draw a coordinate grid over IMAGE instead")
    args = ap.parse_args()
    out = Path(args.out).expanduser()

    if args.grid:
        doc, w = grid_html(Path(args.grid).expanduser())
        render(doc, out, w)
        print(out)
        return 0
    if not args.spec:
        ap.error("give a spec JSON or --grid IMAGE")
    spec_path = Path(args.spec).expanduser()
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    pairs = spec.get("pairs") or []
    if not pairs:
        raise SystemExit("spec has no pairs")
    base = spec_path.parent
    width = args.width
    if not width:
        phone = all(png_size((base / p["after"]).expanduser())[0] / max(1, png_size((base / p["after"]).expanduser())[1]) < 0.7
                    for p in pairs)
        width = 400 if phone else 760
    title = spec.get("title", "")
    body = "".join(pair_html(p, base, width) for p in pairs)
    doc = (f'<!doctype html><meta charset="utf-8"><title>{html.escape(title or "before / after")}</title>'
           f'<style>{STYLE}</style>{f"<h1>{html.escape(title)}</h1>" if title else ""}{body}')
    render(doc, out, width * 2 + 20 + 56)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
