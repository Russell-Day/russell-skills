#!/usr/bin/env python3
"""coupling-report.py: where is this codebase tied to one person and one machine?

Counts, per file and per top-level directory, the places a stranger would trip:

  machine   home paths, private/Tailscale IPs, .local/.lan hosts, /mnt/<drive>,
            Windows drive paths, hardcoded venv or /usr/local tool paths
  identity  your personal list (personal.local.txt) and any non-example email
  dated     history kept inside instructions: ISO dates, "plan 123", "since ..."
  <kinds>   your own terms from coupling.local.txt (tools, harness, models, ...)

and lists files over --big lines. The output is a worklist for the generalize
phase, not a verdict: a hit is a place to look, and some hits are fine.

    python3 scripts/coupling-report.py [REPO] [--terms FILE] [--personal FILE]
        [--exclude GLOB ...] [--depth N] [--top N] [--big N] [--json OUT]

Terms file (default coupling.local.txt next to this skill, or $GO_PUBLIC_TERMS):
one term per line as `kind: term`, `kind: re:<regex>`, or a bare term (kind
"personal"). Terms match case-insensitively; `#` starts a comment. See
coupling.example.txt. Read-only. Stdlib Python only.
"""
from __future__ import annotations

import argparse
import fnmatch
import importlib.util
import json
import os
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("publish_check", Path(__file__).with_name("publish-check.py"))
pc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pc)  # reuse its patterns and list loaders

MACHINE = {
    **{k: v for k, v in pc.GENERIC.items() if k != "phone number"},
    "/mnt/<drive>": r"/mnt/[a-z]/",
    "drive path": r"\b[C-Z]:[\\/][\w .-]+[\\/]",
    "venv/tool path": r"(\.venv/bin/|/usr/local/bin/|/opt/homebrew/bin/)",
}
DATED = {
    "ISO date": r"\b20\d\d-[01]\d-[0-3]\d\b",
    "plan number": r"\bplans? \d+\b",
    "since/until": r"\b(since|until|as of|from) (20\d\d|\d{1,2}/\d{1,2}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d)",
}
TEXT_EXT_SKIP = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".woff", ".woff2", ".ttf", ".mp3", ".mp4", ".sqlite", ".db"}


def load_terms(path: Path | None):
    """[(kind, label, regex)]"""
    out = []
    if not path or not path.exists():
        return out
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        kind, sep, term = line.partition(":")
        if not sep or " " in kind.strip() or kind.strip() == "re":
            kind, term = "personal", line
        kind, term = kind.strip().lower(), term.strip()
        if term.startswith("re:"):
            out.append((kind, term[3:].strip(), re.compile(term[3:].strip(), re.I)))
        else:
            out.append((kind, term, re.compile(r"(?<![\w-])" + re.escape(term) + r"(?![\w-])", re.I)))
    return out


def list_files(repo: Path):
    try:
        p = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=repo, capture_output=True, check=True)
        return [f for f in p.stdout.decode(errors="replace").split("\0") if f]
    except (subprocess.CalledProcessError, FileNotFoundError):
        return [str(p.relative_to(repo)) for p in repo.rglob("*") if p.is_file() and ".git" not in p.parts]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("repo", nargs="?", default=".")
    ap.add_argument("--terms", help="coupling terms file (default: coupling.local.txt next to the skill)")
    ap.add_argument("--personal", help="personal list (default: personal.local.txt next to the skill)")
    ap.add_argument("--exclude", action="append", default=[], help="glob to skip (repeatable), e.g. 'library/*'")
    ap.add_argument("--depth", type=int, default=1, help="directory depth for the rollup (default 1)")
    ap.add_argument("--top", type=int, default=40, help="files to list (default 40)")
    ap.add_argument("--big", type=int, default=500, help="flag files over this many lines (default 500)")
    ap.add_argument("--json", help="also write the full result as JSON")
    a = ap.parse_args()

    repo = Path(a.repo).resolve()
    terms_file = Path(a.terms or os.environ.get("GO_PUBLIC_TERMS") or SKILL_DIR / "coupling.local.txt")
    personal_file = Path(a.personal or os.environ.get("GO_PUBLIC_PERSONAL") or SKILL_DIR / "personal.local.txt")
    globs, allows = pc.load_ignore(repo)
    globs += a.exclude

    pats = [("machine", k, re.compile(v)) for k, v in MACHINE.items()]
    pats += [("identity", label, rx) for label, rx in pc.load_personal(personal_file)]
    pats += [("dated", k, re.compile(v, re.I)) for k, v in DATED.items()]
    pats += load_terms(terms_file)
    kinds = list(dict.fromkeys(k for k, *_ in pats))
    if "identity" not in kinds:
        kinds.insert(1, "identity")

    per_file: dict[str, Counter] = {}
    term_hits: Counter = Counter()
    term_files: dict[tuple, set] = defaultdict(set)
    lines_of: dict[str, int] = {}
    for f in list_files(repo):
        if pc.skipped(f, globs) or Path(f).suffix.lower() in TEXT_EXT_SKIP:
            continue
        p = repo / f
        try:
            if p.is_symlink() or not p.is_file() or p.stat().st_size > 2_000_000:
                continue
            raw = p.read_bytes()
        except OSError:
            continue
        if b"\0" in raw[:8192]:
            continue
        text = raw.decode(errors="replace").splitlines()
        lines_of[f] = len(text)
        c = Counter()
        for line in text:
            low = line.lower()
            if any(x.lower() in low for x in allows):
                continue
            for kind, label, rx in pats:
                n = len(rx.findall(line))
                if n:
                    c[kind] += n
                    term_hits[(kind, label)] += n
                    term_files[(kind, label)].add(f)
            for m in pc.EMAIL.finditer(line):
                if not pc.EMAIL_OK.search(m.group(0)):
                    c["identity"] += 1
                    term_hits[("identity", "email " + m.group(0))] += 1
                    term_files[("identity", "email " + m.group(0))].add(f)
        if c:
            per_file[f] = c

    def dir_of(f):
        parts = Path(f).parts
        return "/".join(parts[: a.depth]) + "/" if len(parts) > a.depth else "(root)"

    per_dir: dict[str, Counter] = defaultdict(Counter)
    files_in_dir: Counter = Counter(dir_of(f) for f in lines_of)
    for f, c in per_file.items():
        per_dir[dir_of(f)].update(c)

    def row(name, c, extra=()):
        return "| " + " | ".join([name, *extra, *(str(c.get(k, 0) or "") for k in kinds), str(sum(c.values()))]) + " |"

    out = [f"# coupling report: {repo.name}",
           f"{len(lines_of)} text files scanned, {len(per_file)} with hits. Terms: "
           f"{terms_file if terms_file.exists() else 'none (copy coupling.example.txt to coupling.local.txt)'}",
           "", f"## By directory (depth {a.depth})", "",
           "| dir | files | " + " | ".join(kinds) + " | total |", "|---|---|" + "---|" * (len(kinds) + 1)]
    for d, c in sorted(per_dir.items(), key=lambda kv: -sum(kv[1].values())):
        out.append(row(d, c, (str(files_in_dir[d]),)))
    out += ["", f"## Files (top {a.top})", "", "| file | lines | " + " | ".join(kinds) + " | total |",
            "|---|---|" + "---|" * (len(kinds) + 1)]
    for f, c in sorted(per_file.items(), key=lambda kv: -sum(kv[1].values()))[: a.top]:
        out.append(row(f, c, (str(lines_of[f]),)))
    out += ["", "## Terms", "", "| kind | term | hits | files |", "|---|---|---|---|"]
    for (kind, label), n in term_hits.most_common(60):
        out.append(f"| {kind} | `{label}` | {n} | {len(term_files[(kind, label)])} |")
    big = sorted(((n, f) for f, n in lines_of.items() if n > a.big), reverse=True)
    if big:
        out += ["", f"## Big files (over {a.big} lines)", ""] + [f"- {f}: {n}" for n, f in big]
    print("\n".join(out))

    if a.json:
        Path(a.json).write_text(json.dumps({
            "repo": str(repo), "kinds": kinds,
            "dirs": {d: dict(c) for d, c in per_dir.items()},
            "files": {f: {"lines": lines_of[f], **dict(c)} for f, c in per_file.items()},
            "terms": [{"kind": k, "term": t, "hits": n, "files": sorted(term_files[(k, t)])} for (k, t), n in term_hits.most_common()],
            "big": [{"file": f, "lines": n} for n, f in big],
        }, indent=2))


if __name__ == "__main__":
    main()
