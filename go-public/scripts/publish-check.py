#!/usr/bin/env python3
"""publish-check.py: can this repo go public as it is? (part of go-public)

Checks what a public repo actually exposes: every commit on every branch and tag,
commit messages and author emails, the files that would be pushed now, and the
GitHub settings that matter once strangers can open pull requests.

    python3 scripts/publish-check.py [REPO] [--personal FILE] [--max-mb N] [--json OUT]

Sections and levels:
  BLOCK   must be fixed before the repo goes public (exit code 1)
  REVIEW  a person decides (intended or not?)
  INFO    context only

Needs git and gitleaks (https://github.com/gitleaks/gitleaks). A missing
gitleaks is a BLOCK, never a silent skip. Stdlib Python only. Read-only: it
changes nothing in the repo (a scratch copy of the files goes to a temp dir).

Personal list: literal strings, one per line (`re:` prefix for a regex, `#` for
comments). Default: `personal.local.txt` next to this skill (git-ignored), or
$GO_PUBLIC_PERSONAL. See `personal.example.txt`.

Repo allowlist `.publish-check-ignore` (optional, at the repo root):
  path:<glob>      skip matching paths in the personal/email scans
  allow:<literal>  a match containing this literal is fine (e.g. your public name)
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
INJECT = re.compile(r"\$\{\{\s*github\.(head_ref|event\.(issue|pull_request|comment|review|review_comment|discussion|head_commit|commits|pages)\b[\w.\[\]*]*\.(title|body|message|name|email|label|ref|head_ref|default_branch|page_name))")

GENERIC = {
    "home path": r"(/home/[a-z_][a-z0-9_-]*/|/Users/[A-Za-z][\w.-]*/|[A-Za-z]:\\\\?Users\\\\?[A-Za-z][\w.-]*|/mnt/[a-z]/Users/[\w.-]+)",
    "private IP": r"\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b",
    "tailnet host": r"\b[\w-]+\.(tail[0-9a-f]+\.ts\.net|local|lan|internal)\b(?![.\w-])",
    "phone number": r"(?<![\w.])(\+1[ .-]?)?\(?\b[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}\b",
}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
EMAIL_OK = re.compile(
    r"(noreply|no-reply)@|@users\.noreply\.github\.com$|@(example|test)\.(com|org|net)$"
    r"|@localhost$|^git@github\.com$|@[\w.-]*\.(png|jpg|svg|webp)$",
    re.I,
)
SENSITIVE_NAMES = [  # secrets: BLOCK
    ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*",
    "*.keystore", "*.jks", "credentials*.json", "*token*.json", "client_secret*.json",
    "service-account*.json", ".npmrc", ".pypirc", ".netrc", "*.kdbx",
]
DATA_NAMES = [  # personal data dumps: REVIEW
    "*.sqlite", "*.sqlite3", "*.db", "*.db-*", "*.jsonl", "*.log", "*.har", "*.pcap",
    "*.mbox", "*.eml", "*.vcf", "*.ics",
]
BINARY_NAMES = [  # built artifacts: REVIEW (OpenSSF Binary-Artifacts)
    "*.exe", "*.dll", "*.so", "*.dylib", "*.jar", "*.whl", "*.pyc", "*.class",
    "*.zip", "*.tar", "*.tar.gz", "*.tgz", "*.7z", "*.iso", "*.dmg", "*.apk", "*.msi",
]
AGENT_NAMES = [  # agent instructions, memory and transcripts: REVIEW (often personal workflow)
    "CLAUDE.md", "AGENTS.md", "GEMINI.md", "MEMORY.md", ".claude/*", ".codex/*", ".cursor/*",
    ".agents/*", ".gemini/*", "*.transcript*", "*session*.jsonl",
]
SENSITIVE_OK = {".env.example", ".env.sample", ".env.template", ".npmrc.example"}


def sh(args, cwd=None, check=True, text=True):
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=text)
    if check and p.returncode != 0:
        raise SystemExit(f"command failed: {' '.join(args)}\n{p.stderr}")
    return p


class Report:
    def __init__(self):
        self.items = []  # (section, level, title, details)

    def add(self, section, level, title, details=None):
        self.items.append((section, level, title, list(details or [])))

    def blocks(self):
        return [i for i in self.items if i[1] == "BLOCK"]

    def render(self):
        out, sections = [], []
        for s, *_ in self.items:
            if s not in sections:
                sections.append(s)
        for s in sections:
            out.append(f"\n## {s}\n")
            for sec, lvl, title, details in self.items:
                if sec != s:
                    continue
                out.append(f"- **{lvl}** {title}")
                for d in details[:25]:
                    out.append(f"    - {d}")
                if len(details) > 25:
                    out.append(f"    - … {len(details) - 25} more")
        n_block = len(self.blocks())
        n_rev = sum(1 for i in self.items if i[1] == "REVIEW")
        verdict = "NO-GO" if n_block else ("GO after review" if n_rev else "GO")
        head = f"# publish-check: {verdict}  ({n_block} block, {n_rev} review)"
        return head + "\n" + "\n".join(out) + "\n"


def load_ignore(repo: Path):
    globs, allows = [".publish-check-ignore"], []
    f = repo / ".publish-check-ignore"
    if f.exists():
        for line in f.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("path:"):
                globs.append(line[5:].strip())
            elif line.startswith("allow:"):
                allows.append(line[6:].strip())
    return globs, allows


def skipped(path: str, globs) -> bool:
    return any(fnmatch.fnmatch(path, g) or fnmatch.fnmatch(os.path.basename(path), g) for g in globs)


def load_personal(path: Path | None):
    pats = []
    if path and path.exists():
        for line in path.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("re:"):
                pats.append((line[3:].strip(), re.compile(line[3:].strip(), re.I)))
            else:
                pats.append((line, re.compile(re.escape(line), re.I)))
    return pats


def build_patterns(personal):
    pats = [(f"personal: {label}", rx) for label, rx in personal]
    pats += [(name, re.compile(rx)) for name, rx in GENERIC.items()]
    return pats


def line_hits(line, pats, allows):
    hits = []
    for label, rx in pats:
        m = rx.search(line)
        if m and not any(a.lower() in line.lower() for a in allows):
            hits.append((label, m.group(0)))
    for m in EMAIL.finditer(line):
        e = m.group(0)
        if not EMAIL_OK.search(e) and not any(a.lower() in e.lower() for a in allows):
            hits.append(("email", e))
    return hits


# ---------------------------------------------------------------- sections

def check_gitleaks(repo: Path, tree: Path, max_mb: float, rep: Report, sec="Secrets"):
    if not shutil.which("gitleaks"):
        rep.add(sec, "BLOCK", "gitleaks is not installed, so secrets were NOT checked",
                ["install: https://github.com/gitleaks/gitleaks/releases (single binary)"])
        return
    tmp = Path(tempfile.mkdtemp(prefix="pc-gl-"))
    try:
        for kind, args in (
            ("history (all branches + tags)", ["gitleaks", "git", str(repo), "--log-opts=--all"]),
            ("files that would be pushed now", ["gitleaks", "dir", str(tree)]),
        ):
            out = tmp / "r.json"
            print(f"publish-check: gitleaks over {kind}…", file=sys.stderr)
            p = sh(args + ["--no-banner", "--redact", "-f", "json", "-r", str(out),
                           "--max-target-megabytes", str(max(1, int(max_mb))),
                           "--exit-code", "3", "-l", "error"], check=False)
            if p.returncode not in (0, 3):
                rep.add(sec, "BLOCK", f"gitleaks failed on {kind}", [p.stderr.strip()[:300]])
                continue
            found = json.loads(out.read_text() or "[]") if out.exists() else []
            if not found:
                rep.add(sec, "INFO", f"gitleaks: nothing in {kind}")
                continue
            rows = []
            for f in found:
                where = f.get("File", "").replace(str(tree) + "/", "")
                c = (f.get("Commit") or "")[:9]
                rows.append(f"{f.get('RuleID')}: {where}:{f.get('StartLine')}"
                            + (f" @ {c} ({f.get('Date', '')[:10]})" if c else ""))
            rep.add(sec, "BLOCK", f"gitleaks: {len(found)} possible secret(s) in {kind}. "
                    "Rotate real ones first; then remove (see references/publish-check.md)",
                    sorted(set(rows)))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def check_tree_text(tree: Path, files, pats, globs, allows, rep: Report, sec="Personal info"):
    hits = defaultdict(list)
    for rel in files:
        if skipped(rel, globs):
            continue
        p = tree / rel
        if p.is_symlink() or not p.is_file() or p.stat().st_size > 2_000_000:
            continue
        try:
            data = p.read_bytes()
        except OSError:
            continue
        if b"\0" in data[:8000]:
            continue
        for n, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            if len(line) > 4000:
                line = line[:4000]
            for label, match in line_hits(line, pats, allows):
                hits[label].append(f"{rel}:{n}  `{match}`")
    if not hits:
        rep.add(sec, "INFO", "current files: no personal details, home paths, private IPs or emails")
    for label, rows in sorted(hits.items()):
        lvl = "BLOCK" if label.startswith("personal:") or label in ("home path", "private IP", "tailnet host") else "REVIEW"
        rep.add(sec, lvl, f"current files: {label} ({len(rows)})", rows)


def check_history_text(repo: Path, current_hits_files, pats, globs, allows, rep: Report, sec="Personal info"):
    """Added lines and commit messages across all history, current file aside."""
    p = subprocess.Popen(
        ["git", "-C", str(repo), "log", "--all", "-p", "--no-color", "--no-ext-diff",
         "--no-renames", "--format=@@C %h %ad%n%B@@E", "--date=short"],
        stdout=subprocess.PIPE, text=True, errors="replace")
    commit, path, in_msg = "", "", False
    seen = defaultdict(dict)  # label -> {(match): first "commit path"}
    for raw in p.stdout:
        line = raw.rstrip("\n")
        if line.startswith("@@C "):
            commit, in_msg, path = line[4:], True, "(commit message)"
            continue
        if in_msg:
            if line == "@@E":
                in_msg = False
                continue
            body = line
        elif line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else line[4:]
            continue
        elif line.startswith("+") and not line.startswith("+++"):
            body = line[1:]
        else:
            continue
        if path != "(commit message)" and skipped(path, globs):
            continue
        for label, match in line_hits(body[:4000], pats, allows):
            key = match.lower()
            if key not in seen[label]:
                seen[label][key] = f"`{match}` first at {commit.split()[0]} ({commit.split()[1] if ' ' in commit else ''}) in {path}"
    p.wait()
    any_hit = False
    for label, d in sorted(seen.items()):
        rows = list(d.values())
        lvl = "BLOCK" if label.startswith("personal:") or label in ("home path", "private IP", "tailnet host") else "REVIEW"
        any_hit = True
        rep.add(sec, lvl, f"git history (any branch, incl. commit messages): {label} ({len(rows)} distinct)", rows)
    if not any_hit:
        rep.add(sec, "INFO", "git history: no personal details, home paths, private IPs or emails")


def check_authors(repo: Path, personal, allows, rep: Report, sec="Personal info"):
    out = sh(["git", "-C", str(repo), "log", "--all", "--format=%an <%ae>%n%cn <%ce>"]).stdout
    ids = sorted({l for l in out.splitlines() if l.strip()})
    mine, other = [], []
    for i in ids:
        email = i.split("<")[-1].rstrip(">")
        if any(a.lower() in i.lower() for a in allows) or EMAIL_OK.search(email):
            continue
        (mine if any(rx.search(i) for _, rx in personal) else other).append(i)
    fix = "fix: rewrite with a mailmap (references/publish-check.md, step 4) or allow it in .publish-check-ignore"
    if mine:
        rep.add(sec, "BLOCK", "commit identities on your personal list become public with the history", mine + [fix])
    if other:
        rep.add(sec, "REVIEW", "commit author/committer emails become public with the history", other + [fix])
    if not mine and not other:
        rep.add(sec, "INFO", f"commit identities: {len(ids)}, all noreply/allowlisted")


def check_files(repo: Path, root: Path, files, personal, max_mb: float, rep: Report, sec="Files"):
    def match(name, globs):
        b = os.path.basename(name)
        return b not in SENSITIVE_OK and any(fnmatch.fnmatch(b, g) for g in globs)

    added = sh(["git", "-C", str(repo), "log", "--all", "--diff-filter=A", "--name-only", "--format="]).stdout
    added = {f for f in added.splitlines() if f}
    for globs, lvl, what in ((SENSITIVE_NAMES, "BLOCK", "key/env/credential files"),
                             (DATA_NAMES, "REVIEW", "data files (databases, logs, mail, exports): real data or fixtures?"),
                             (BINARY_NAMES, "REVIEW", "built binaries/archives (unreviewable; rebuild from source or attach to a release)")):
        now = [f for f in files if match(f, globs)]
        if now:
            rep.add(sec, lvl, f"{what}, would be pushed", now)
        hist = sorted({f for f in added if match(f, globs)} - set(now))
        if hist:
            rep.add(sec, lvl, f"{what}, deleted now but still in history", hist)
    agent_now = [f for f in files if any(fnmatch.fnmatch(f, g) or fnmatch.fnmatch(os.path.basename(f), g) for g in AGENT_NAMES)]
    if agent_now:
        rep.add(sec, "REVIEW", "agent instructions / memory / sessions would be pushed: read them for "
                "personal workflow, machine names and private notes", agent_now)
    if personal:
        named = sorted({f for f in set(files) | added
                        if any(rx.search(f) for _, rx in personal)})
        if named:
            rep.add(sec, "BLOCK", "file or folder names contain something on your personal list (now or in history)", named)
    # large blobs anywhere in history
    objs = sh(["git", "-C", str(repo), "rev-list", "--objects", "--all"]).stdout
    names = {}
    for l in objs.splitlines():
        sha, _, name = l.partition(" ")
        if name:
            names[sha] = name
    p = subprocess.run(["git", "-C", str(repo), "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
                       input="\n".join(names), capture_output=True, text=True)
    big = []
    for l in p.stdout.splitlines():
        sha, typ, size = l.split()
        if typ == "blob" and int(size) > max_mb * 1_000_000:
            big.append((int(size), names.get(sha, sha)))
    if big:
        big.sort(reverse=True)
        rep.add(sec, "REVIEW", f"files over {max_mb:g} MB anywhere in history (data, media, builds?)",
                [f"{s / 1e6:.1f} MB  {n}" for s, n in big])
    gm = root / ".gitmodules"
    if gm.exists():
        urls = re.findall(r"url\s*=\s*(\S+)", gm.read_text())
        rep.add(sec, "REVIEW", "submodules: each must be public too, or clones break", urls)
    links = []
    for f in files:
        p_ = root / f
        if p_.is_symlink():
            t = os.readlink(p_)
            if t.startswith("/") or t.startswith(".."):
                links.append(f"{f} -> {t}")
    if links:
        rep.add(sec, "REVIEW", "symlinks pointing outside the repo (dangling for everyone else, and they reveal paths)", links)


def check_remote_refs(repo: Path, rep: Report, sec="Secrets"):
    """History on the remote that this clone never fetched was not scanned."""
    r = sh(["git", "-C", str(repo), "remote"], check=False)
    missing = []
    for remote in r.stdout.split():
        ls = sh(["git", "-C", str(repo), "ls-remote", remote], check=False)
        if ls.returncode != 0:
            rep.add(sec, "REVIEW", f"could not list refs on remote '{remote}' (offline?): its unfetched branches were not scanned")
            continue
        for line in ls.stdout.splitlines():
            sha, _, ref = line.partition("\t")
            if ref.endswith("^{}") or ref == "HEAD":
                continue
            if sh(["git", "-C", str(repo), "cat-file", "-e", sha], check=False).returncode != 0:
                missing.append(f"{remote} {ref}")
    if missing:
        rep.add(sec, "BLOCK", "refs on the remote that were never fetched, so NOT scanned (they go public too, "
                "including refs/pull/*): git fetch <remote> '+refs/*:refs/remote-all/*' then rerun", missing)


def check_github(repo: Path, rep: Report, sec="GitHub"):
    wf = repo / ".github" / "workflows"
    if wf.is_dir():
        selfh, prt, inj = [], [], []
        for f in sorted(wf.glob("*.y*ml")):
            t = f.read_text(errors="replace")
            if re.search(r"runs-on:.*self-hosted", t):
                selfh.append(f.name)
            if "pull_request_target" in t:
                prt.append(f.name)
            for n, line in enumerate(t.splitlines(), 1):
                if INJECT.search(line):
                    inj.append(f"{f.name}:{n}  {line.strip()[:120]}")
        if selfh:
            rep.add(sec, "BLOCK", "workflows on self-hosted runners: on a public repo a fork PR can run code on that machine", selfh)
        if prt:
            rep.add(sec, "REVIEW", "workflows using pull_request_target (runs fork code with secrets if it checks out the PR)", prt)
        if inj:
            rep.add(sec, "REVIEW", "untrusted text (titles, bodies, branch names) expanded inside workflow steps: "
                    "script injection; pass it through env: instead", inj)
    if not shutil.which("gh"):
        rep.add(sec, "REVIEW", "gh not installed: repo settings and Actions secrets not checked")
        return
    v = sh(["gh", "repo", "view", "--json", "nameWithOwner,visibility,isFork,hasWikiEnabled"], cwd=repo, check=False)
    if v.returncode != 0:
        rep.add(sec, "INFO", "no GitHub remote found (gh repo view failed); settings checks skipped")
        return
    info = json.loads(v.stdout)
    rep.add(sec, "INFO", f"{info['nameWithOwner']} is {info['visibility'].lower()}")
    nwo = info["nameWithOwner"]
    if info["visibility"] != "PUBLIC":
        # Everything on GitHub goes public with the code, not just git history.
        def count(args):
            r = sh(args, cwd=repo, check=False)
            return len([l for l in r.stdout.splitlines() if l.strip()]) if r.returncode == 0 else 0
        rows = []
        for label, args in (
            ("issues", ["gh", "issue", "list", "--state", "all", "--limit", "1000", "--json", "number", "--jq", ".[].number"]),
            ("pull requests", ["gh", "pr", "list", "--state", "all", "--limit", "1000", "--json", "number", "--jq", ".[].number"]),
            ("Actions runs (logs + artifacts)", ["gh", "run", "list", "--limit", "1000", "--json", "databaseId", "--jq", ".[].databaseId"]),
            ("releases (assets)", ["gh", "release", "list", "--limit", "1000", "--json", "tagName", "--jq", ".[].tagName"]),
        ):
            n = count(args)
            if n:
                rows.append(f"{n} {label}")
        if info.get("hasWikiEnabled"):
            w = sh(["git", "ls-remote", f"https://github.com/{nwo}.wiki.git"], check=False)
            if w.returncode == 0 and w.stdout.strip():
                rows.append("a wiki with pages")
        pg = sh(["gh", "api", f"repos/{nwo}/pages", "--jq", ".html_url"], check=False)
        if pg.returncode == 0 and pg.stdout.strip():
            rows.append(f"a Pages site ({pg.stdout.strip()})")
        if rows:
            rep.add(sec, "REVIEW", "these go public with the repo (comments, screenshots, logs included); "
                    "read or delete before the flip (references/publish-check.md step 3)", rows)
    s = sh(["gh", "secret", "list"], cwd=repo, check=False)
    if s.returncode == 0 and s.stdout.strip():
        rep.add(sec, "REVIEW", "Actions secrets exist: check no workflow can leak them to fork PRs",
                [l.split("\t")[0] for l in s.stdout.splitlines()])
    if info["visibility"] != "PUBLIC":
        rep.add(sec, "INFO", "after the flip: turn on secret scanning + push protection (references/publish-check.md, step 6)")
    else:
        sa = sh(["gh", "api", f"repos/{info['nameWithOwner']}", "--jq", ".security_and_analysis"], check=False)
        try:
            d = json.loads(sa.stdout or "{}") or {}
        except json.JSONDecodeError:
            d = {}
        off = [k for k in ("secret_scanning", "secret_scanning_push_protection")
               if (d.get(k) or {}).get("status") != "enabled"]
        if off:
            rep.add(sec, "REVIEW", "public repo without " + " / ".join(off), ["see references/publish-check.md, step 6"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("repo", nargs="?", default=".")
    ap.add_argument("--personal", help="personal strings file (default: personal.local.txt beside the skill)")
    ap.add_argument("--max-mb", type=float, default=5.0,
                    help="files above this are listed for review and skipped by gitleaks (default 5)")
    ap.add_argument("--json", help="also write findings as JSON here")
    ap.add_argument("--no-history-text", action="store_true", help="skip the personal/email scan of history (faster)")
    a = ap.parse_args()

    bare = sh(["git", "-C", a.repo, "rev-parse", "--is-bare-repository"]).stdout.strip() == "true"
    repo = Path(a.repo).resolve() if bare else Path(sh(["git", "-C", a.repo, "rev-parse", "--show-toplevel"]).stdout.strip())
    rep = Report()
    personal_file = Path(a.personal or os.environ.get("GO_PUBLIC_PERSONAL") or SKILL_DIR / "personal.local.txt")
    personal = load_personal(personal_file)
    if not personal:
        rep.add("Personal info", "REVIEW", f"no personal list at {personal_file}: only generic patterns ran",
                ["copy personal.example.txt to personal.local.txt and fill it in"])
    pats = build_patterns(personal)
    globs, allows = load_ignore(repo)

    tree = Path(tempfile.mkdtemp(prefix="pc-tree-"))
    try:
        if bare:  # a mirror clone (history rewrite, step 4B): check what HEAD would publish
            files = [f for f in sh(["git", "-C", str(repo), "ls-tree", "-r", "-z", "--name-only", "HEAD"]).stdout.split("\0") if f]
            arch = subprocess.run(["git", "-C", str(repo), "archive", "HEAD"], capture_output=True, check=True).stdout
            subprocess.run(["tar", "-x", "-C", str(tree)], input=arch, check=True)
        else:
            files = [f for f in sh(["git", "-C", str(repo), "ls-files", "-z", "-co", "--exclude-standard"]).stdout.split("\0") if f]
            for f in files:
                src, dst = repo / f, tree / f
                if src.is_symlink() or not src.is_file():
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        print(f"publish-check: {repo} ({len(files)} files)…", file=sys.stderr)
        check_remote_refs(repo, rep)
        check_gitleaks(repo, tree, a.max_mb, rep)
        check_tree_text(tree, files, pats, globs, allows, rep)
        if not a.no_history_text:
            print("publish-check: scanning history for personal details…", file=sys.stderr)
            check_history_text(repo, files, pats, globs, allows, rep)
        check_authors(repo, personal, allows, rep)
        check_files(repo, tree if bare else repo, files, personal, a.max_mb, rep)
        if not bare:
            check_github(repo, rep)
    finally:
        shutil.rmtree(tree, ignore_errors=True)

    print(rep.render())
    if a.json:
        Path(a.json).write_text(json.dumps(
            [dict(section=s, level=l, title=t, details=d) for s, l, t, d in rep.items], indent=2))
    sys.exit(1 if rep.blocks() else 0)


if __name__ == "__main__":
    main()
