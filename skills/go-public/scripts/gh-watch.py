#!/usr/bin/env python3
"""gh-watch.py: tell you when something on your public repos needs a person.

Polls the GitHub notifications API once per run (meant for a timer: cron, a
systemd user timer, or your assistant's scheduler, every 5-15 min). It sends the
saved ETag, so an unchanged inbox costs no rate limit, and respects GitHub's
X-Poll-Interval. Each new or updated thread is sorted:

  now     a mention, review request, assignment, security alert, or a new
          issue / PR / discussion thread (bot titles like "Bump x" excluded)
  digest  everything else (comments on known threads, CI, releases, bots)

"now" items go to --notify-cmd (or stdout); digest items wait until a run
with --digest prints them (and clears them). The first run puts the whole
backlog in the digest. It never marks anything read.

    python3 scripts/gh-watch.py [--repos OWNER/A,OWNER/B] [--notify-cmd CMD]
    python3 scripts/gh-watch.py --digest            # print + clear the digest
    python3 scripts/gh-watch.py --dry-run           # show, save nothing

--notify-cmd: a command run once per "now" item with the message appended as
its last argument; `{key}` in it becomes a stable id for that item. Token: $GH_TOKEN
or $GITHUB_TOKEN, else `gh auth token` (classic token or gh login; needs the
notifications or repo scope). State: $XDG_STATE_HOME/go-public/gh-watch.json.
Stdlib Python only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.github.com/notifications"
NOW_REASONS = {"mention", "team_mention", "review_requested", "assign", "security_alert"}
NEW_TYPES = {"Issue", "PullRequest", "Discussion"}
BOT_TITLE = re.compile(r"^(bump |build\(deps|chore\(deps|chore\(main\): release|\[bot\])", re.I)


def state_path() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "go-public" / "gh-watch.json"


def save(sp: Path, st: dict):
    """Write the state atomically, so an interrupted run never leaves broken JSON."""
    sp.parent.mkdir(parents=True, exist_ok=True)
    tmp = sp.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(st, indent=1))
    os.replace(tmp, sp)


def token() -> str:
    t = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if t:
        return t
    if shutil.which("gh"):
        p = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True)
        if p.returncode == 0 and p.stdout.strip():
            return p.stdout.strip()
    sys.exit("gh-watch: no token. Set GH_TOKEN or run `gh auth login`.")


def fetch(tok: str, st: dict):
    """Returns (threads or None if unchanged, poll_interval)."""
    threads, url, first = [], API + "?per_page=50", True
    while url:
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "go-public-gh-watch",
        })
        if first and st.get("last_modified"):
            req.add_header("If-Modified-Since", st["last_modified"])
        if first and st.get("etag"):
            req.add_header("If-None-Match", st["etag"])
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                if first:
                    st["etag"] = r.headers.get("ETag") or st.get("etag")
                    st["last_modified"] = r.headers.get("Last-Modified") or st.get("last_modified")
                    st["poll_interval"] = int(r.headers.get("X-Poll-Interval") or 60)
                threads += json.load(r)
                m = re.search(r'<([^>]+)>;\s*rel="next"', r.headers.get("Link") or "")
                url = m.group(1) if m else None
        except urllib.error.HTTPError as e:
            if e.code == 304:
                st["poll_interval"] = int(e.headers.get("X-Poll-Interval") or st.get("poll_interval") or 60)
                return None
            sys.exit(f"gh-watch: GitHub said {e.code}: {e.read()[:300]!r}")
        except urllib.error.URLError as e:
            sys.exit(f"gh-watch: network error: {e.reason}")
        first = False
    return threads


def web_url(subject: dict, repo: str) -> str:
    api = subject.get("url") or ""
    m = re.search(r"/repos/([^/]+/[^/]+)/(issues|pulls|discussions)/(\d+)", api)
    if m:
        kind = "pull" if m.group(2) == "pulls" else m.group(2)
        return f"https://github.com/{m.group(1)}/{kind}/{m.group(3)}"
    return f"https://github.com/{repo}"


def classify(t: dict, seen: dict) -> str:
    subj = t.get("subject") or {}
    if t.get("reason") in NOW_REASONS:
        return "now"
    if t["id"] not in seen and subj.get("type") in NEW_TYPES and not BOT_TITLE.search(subj.get("title") or ""):
        return "now"
    return "digest"


def line(t: dict) -> str:
    subj, repo = t.get("subject") or {}, t["repository"]["full_name"]
    return f"[{repo}] {subj.get('type', '?')} ({t.get('reason')}): {subj.get('title', '')} {web_url(subj, repo)}"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repos", help="comma-separated OWNER/REPO list to watch (default: every repo)")
    ap.add_argument("--notify-cmd", help="command for 'now' items; message appended as last arg; {key} = item id")
    ap.add_argument("--digest", action="store_true", help="print and clear the waiting digest items (no poll)")
    ap.add_argument("--dry-run", action="store_true", help="poll and print, but save no state and notify nobody")
    ap.add_argument("--force", action="store_true", help="poll even if GitHub's poll interval has not passed")
    a = ap.parse_args()

    sp = state_path()
    st = json.loads(sp.read_text()) if sp.exists() else {}
    st.setdefault("seen", {})
    st.setdefault("digest", [])

    if a.digest:
        if st["digest"]:
            print(f"GitHub digest: {len(st['digest'])} item(s)\n")
            print("\n".join(f"- {d}" for d in st["digest"]))
        else:
            print("GitHub digest: nothing new.")
        if not a.dry_run:
            st["digest"] = []
            save(sp, st)
        return

    if not a.force and time.time() - st.get("polled_at", 0) < st.get("poll_interval", 60):
        print("gh-watch: polled less than X-Poll-Interval ago; skipping (use --force).")
        return
    first_run = "polled_at" not in st  # the backlog goes to the digest, not your phone
    threads = fetch(token(), st)
    st["polled_at"] = time.time()
    watch = {r.strip().lower() for r in (a.repos or "").split(",") if r.strip()}
    now, digest = [], []
    for t in threads or []:
        repo = t["repository"]["full_name"]
        if watch and repo.lower() not in watch:
            continue
        if st["seen"].get(t["id"]) == t.get("updated_at"):
            continue
        (now if not first_run and classify(t, st["seen"]) == "now" else digest).append(t)
        st["seen"][t["id"]] = t.get("updated_at")

    for t in now:
        msg = line(t)
        if a.notify_cmd and not a.dry_run:
            key = f"gh-{t['id']}-{re.sub(r'[^0-9]', '', t.get('updated_at') or '')}"
            cmd = [c.replace("{key}", key) for c in shlex.split(a.notify_cmd)] + [msg]
            try:
                p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
                err = None if p.returncode == 0 else f"exit {p.returncode}: {p.stderr.strip()[:200]}"
            except (OSError, subprocess.TimeoutExpired) as e:
                err = str(e)[:200]
            if err:  # keep it for the digest rather than lose it
                print(f"gh-watch: notify failed ({err})", file=sys.stderr)
                st["digest"].append("(notify failed) " + msg)
        print("NOW " + msg)
    for t in digest:
        st["digest"].append(line(t))
    if digest:
        print(f"gh-watch: {len(digest)} item(s) added to the digest.")
    if threads is None:
        print("gh-watch: no change.")

    if len(st["seen"]) > 2000:  # keep the newest
        st["seen"] = dict(sorted(st["seen"].items(), key=lambda kv: kv[1] or "")[-1000:])
    if not a.dry_run:
        save(sp, st)


if __name__ == "__main__":
    main()
