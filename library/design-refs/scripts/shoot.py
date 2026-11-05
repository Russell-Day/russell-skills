#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright>=1.40"]
# ///
"""Screenshot public pages at phone (393x852) and desktop (1440x900) size.

    uv run scripts/shoot.py https://linear.app https://claude.ai --out /tmp/refs
    python3 scripts/shoot.py https://linear.app          # if playwright is installed

Each URL gives two PNGs in --out: <host-path>-phone.png and <host-path>-desktop.png,
above the fold (--full for the whole page). Fresh browser context per shot: no
cookies, no logins, nothing from your own browser. Prints one JSON line per URL.

First run on a new machine: `uv run --with playwright playwright install chromium`
(or `python3 -m playwright install chromium`).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

PHONE = {"width": 393, "height": 852}
DESKTOP = {"width": 1440, "height": 900}
#: Consent-banner buttons clicked before the shot (best effort; --keep-banners skips it).
CONSENT = re.compile(r"^\s*(accept( all)?( cookies)?|allow all|agree|i agree|got it|ok(ay)?|reject all|decline optional)\s*$", re.I)
PHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
)


def slug(url: str) -> str:
    p = urlparse(url)
    s = re.sub(r"^www\.", "", p.netloc) + p.path.rstrip("/")
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-")[:80] or "page"


def dismiss_banners(page) -> None:
    for frame in page.frames[:4]:
        try:
            btn = frame.get_by_role("button", name=CONSENT).first
            if btn.is_visible(timeout=300):
                btn.click(timeout=1_000)
                page.wait_for_timeout(400)
                return
        except Exception:
            continue


def shoot(browser, url: str, out: Path, *, phone: bool, full: bool, wait_ms: int, dpr: float,
          scheme: str = "light", banners: bool = False) -> Path:
    opts = (
        {"viewport": PHONE, "device_scale_factor": dpr, "is_mobile": True, "has_touch": True, "user_agent": PHONE_UA}
        if phone
        else {"viewport": DESKTOP, "device_scale_factor": 1}
    )
    ctx = browser.new_context(**opts, service_workers="block", color_scheme=scheme)
    try:
        page = ctx.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        try:
            page.wait_for_load_state("networkidle", timeout=6_000)
        except Exception:
            pass  # busy pages (analytics, streams) never go idle; shoot what's there
        page.wait_for_timeout(wait_ms)  # entry animations, fonts
        if not banners:
            dismiss_banners(page)
        path = out / f"{slug(url)}-{'phone' if phone else 'desktop'}.png"
        page.screenshot(path=str(path), full_page=full)
        return path
    finally:
        ctx.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("urls", nargs="+")
    ap.add_argument("--out", default="design-refs-shots", help="folder for the PNGs (made if missing)")
    ap.add_argument("--full", action="store_true", help="whole page instead of the first screen")
    ap.add_argument("--only", choices=["phone", "desktop"], help="just one size")
    ap.add_argument("--wait", type=int, default=1500, help="ms to wait after load (default 1500)")
    ap.add_argument("--dpr", type=float, default=1, help="phone pixel ratio (1 = 393x852 PNG, 2 = 786x1704)")
    ap.add_argument("--keep-banners", action="store_true", help="don't click cookie/consent banners away")
    ap.add_argument("--dark", action="store_true", help="prefers-color-scheme: dark")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright isn't installed: run with `uv run scripts/shoot.py ...` or `pip install playwright`",
              file=sys.stderr)
        return 2

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    sizes = [s for s in ("phone", "desktop") if args.only in (None, s)]
    failed = 0
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as exc:
            if "Executable doesn't exist" not in str(exc):
                raise
            print("Chromium for this playwright version isn't downloaded yet: run "
                  "`uv run --with playwright playwright install --only-shell chromium`, then retry.", file=sys.stderr)
            return 2
        for raw in args.urls:
            url = raw if "://" in raw else f"https://{raw}"
            row: dict = {"url": url}
            for size in sizes:
                try:
                    row[size] = str(shoot(browser, url, out, phone=size == "phone", full=args.full,
                                          wait_ms=args.wait, dpr=args.dpr,
                                          scheme="dark" if args.dark else "light", banners=args.keep_banners))
                except Exception as exc:  # one bad site shouldn't stop the rest
                    row[f"{size}_error"] = f"{type(exc).__name__}: {exc}".splitlines()[0][:200]
                    failed += 1
            print(json.dumps(row), flush=True)
        browser.close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
