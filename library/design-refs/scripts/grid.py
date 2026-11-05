#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright>=1.40"]
# ///
"""Put 2-6 reference screenshots side by side in one PNG, each with a caption.

    uv run scripts/grid.py --out refs.png \\
        "shots/linear.app-phone.png=linear.app: dense list, quiet borders" \\
        "shots/claude.ai-phone.png=claude.ai: composer docked at the bottom"

Each argument is IMAGE or IMAGE=CAPTION. Images keep their aspect ratio and are
scaled to one row height (--height, default 640 px); --cols wraps into rows.
Also writes the HTML next to the PNG (same name, .html) so it can be opened or
shared as a page.
"""

from __future__ import annotations

import argparse
import base64
import html
import mimetypes
import sys
from pathlib import Path


def page(items: list[tuple[Path, str]], height: int, cols: int, title: str) -> str:
    cells = []
    for path, caption in items:
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        data = base64.b64encode(path.read_bytes()).decode()
        cells.append(
            f'<figure><img src="data:{mime};base64,{data}" style="height:{height}px">'
            f"<figcaption>{html.escape(caption or path.stem)}</figcaption></figure>"
        )
    head = f"<h1>{html.escape(title)}</h1>" if title else ""
    return f"""<!doctype html><meta charset="utf-8"><title>{html.escape(title or 'design references')}</title>
<style>
body{{margin:0;padding:24px;background:#f4f4f5;font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#18181b}}
h1{{font-size:16px;font-weight:600;margin:0 0 16px}}
.grid{{display:grid;grid-template-columns:repeat({cols},max-content);gap:20px;align-items:start}}
figure{{margin:0;max-width:max-content}}
img{{display:block;width:auto;border-radius:10px;box-shadow:0 0 0 1px rgb(0 0 0/.08),0 4px 16px rgb(0 0 0/.08);background:#fff}}
figcaption{{margin-top:8px;max-width:100%;font-size:13px;color:#3f3f46;width:0;min-width:100%}}
</style>{head}<div class="grid">{''.join(cells)}</div>"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="+", help="IMAGE or IMAGE=CAPTION")
    ap.add_argument("--out", default="design-refs-grid.png")
    ap.add_argument("--height", type=int, default=640, help="row height in px (default 640)")
    ap.add_argument("--cols", type=int, default=0, help="images per row (default: all in one row)")
    ap.add_argument("--title", default="", help="optional heading, e.g. the pattern being built")
    args = ap.parse_args()

    items: list[tuple[Path, str]] = []
    for arg in args.images:
        path_s, _, caption = arg.partition("=")
        path = Path(path_s).expanduser()
        if not path.is_file():
            print(f"no such image: {path}", file=sys.stderr)
            return 2
        items.append((path, caption.strip()))

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright isn't installed: run with `uv run scripts/grid.py ...` or `pip install playwright`",
              file=sys.stderr)
        return 2

    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = page(items, args.height, args.cols or len(items), args.title)
    out.with_suffix(".html").write_text(doc, encoding="utf-8")
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as exc:
            if "Executable doesn't exist" not in str(exc):
                raise
            print("Chromium for this playwright version isn't downloaded yet: run "
                  "`uv run --with playwright playwright install --only-shell chromium`, then retry.", file=sys.stderr)
            return 2
        pg = browser.new_page(viewport={"width": 800, "height": 600})
        pg.set_content(doc, wait_until="load")
        # Size the viewport to the grid so the PNG has no empty margin on the right.
        w = pg.evaluate("() => document.querySelector('.grid').scrollWidth + 48")
        pg.set_viewport_size({"width": max(400, int(w)), "height": 600})
        pg.screenshot(path=str(out), full_page=True)
        browser.close()
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
