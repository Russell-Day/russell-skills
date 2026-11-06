#!/usr/bin/env python3
"""Local cross-chat board. Python stdlib only; T3 database is read-only."""
import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

NOTE_TEMPLATE = '''area: {area}
projects: {projects}
keywords: {keywords}
updated: {date}

## Summary
<how this area is handled now: approach, key files, gotchas, which models/routes worked>

## Log
- {date} plan <N> <stage> · <sha> · <what was done / learned>
'''


def connect(root):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(root / 'board.sqlite', timeout=15)
    db.row_factory = sqlite3.Row
    db.executescript('''
      CREATE TABLE IF NOT EXISTS cards (
        agent TEXT PRIMARY KEY, title TEXT, summary TEXT, project TEXT,
        state TEXT, updated REAL);
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, recipient TEXT,
        topic TEXT, body TEXT, created REAL);
      CREATE TABLE IF NOT EXISTS receipts (
        agent TEXT, post INTEGER, PRIMARY KEY(agent, post));
      CREATE TABLE IF NOT EXISTS briefs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, areas TEXT, files TEXT,
        post_ids TEXT, note_slugs TEXT, chars INTEGER, est_tokens INTEGER, created REAL);
      CREATE TABLE IF NOT EXISTS helped (
        id INTEGER PRIMARY KEY AUTOINCREMENT, brief INTEGER, agent TEXT, post INTEGER,
        verdict TEXT, note TEXT, created REAL);
    ''')
    # Additive migration for boards made before areas and replies; other agents may race us.
    cols = {r['name'] for r in db.execute('PRAGMA table_info(posts)')}
    for name, kind in (('area', 'TEXT'), ('reply_to', 'INTEGER')):
        if name not in cols:
            try:
                db.execute(f'ALTER TABLE posts ADD COLUMN {name} {kind}')
            except sqlite3.OperationalError as e:
                if 'duplicate column' not in str(e):
                    raise
    return db


def t3_threads(dbpath, project=None, include_settled=False):
    # T3 0.1.0 tables (orchestration v2): thread fields live in payload_json; turn_state is the
    # latest run not held in a queue, the way T3's sidebar reads it.
    with sqlite3.connect(dbpath.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute('''
          SELECT t.thread_id, t.title, p.workspace_root AS project, t.updated_at,
            coalesce(json_extract(t.payload_json,'$.settledAt'),
              CASE WHEN json_extract(t.payload_json,'$.settledOverride')='settled' THEN t.updated_at END) AS settled_at,
            json_extract(t.payload_json,'$.archivedAt') AS archived_at,
            (SELECT s.status FROM orchestration_v2_projection_provider_sessions s
             WHERE s.thread_id=t.thread_id ORDER BY s.updated_at DESC LIMIT 1) AS session_status,
            (SELECT r.status FROM orchestration_v2_projection_runs r WHERE r.thread_id=t.thread_id
               AND NOT (r.status='queued' AND json_extract(r.payload_json,'$.queueHeld') IS 1)
             ORDER BY r.ordinal DESC LIMIT 1) AS turn_state,
            (SELECT count(*) FROM orchestration_v2_projection_runtime_requests q
             WHERE q.thread_id=t.thread_id AND q.status='pending' AND q.kind!='user_input') AS pending_approval_count,
            (SELECT count(*) FROM orchestration_v2_projection_runtime_requests q
             WHERE q.thread_id=t.thread_id AND q.status='pending' AND q.kind='user_input') AS pending_user_input_count,
            (SELECT substr(json_extract(m.payload_json,'$.text'),1,1000) FROM orchestration_v2_projection_messages m
             WHERE m.thread_id=t.thread_id AND m.role='user'
             ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS request_excerpt
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id=t.project_id
          WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL
          ORDER BY t.updated_at DESC
        ''').fetchall()
    result = []
    for row in rows:
        d = dict(row)
        if project and Path(d['project']).resolve() != Path(project).resolve():
            continue
        if not include_settled and (d['settled_at'] or d['archived_at']):
            continue
        d['request_excerpt'] = ' '.join((d['request_excerpt'] or '').split())[:220]
        result.append(d)
    return result


def note_path(root, slug):
    if not re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*', slug):
        raise ValueError(f'Bad note slug {slug!r}: use lowercase kebab-case like calendar-sync')
    return root / 'notes' / f'{slug}.md'


def note_meta(path):
    meta = {'slug': path.stem}
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        if not line.strip():
            break  # front lines end at the first blank line
        key, sep, value = line.partition(':')
        if sep:
            meta[key.strip()] = value.strip()
    return meta


def notes(args):
    """Lasting per-area how-tos as markdown files; agents edit them with their own tools."""
    folder = args.root / 'notes'
    paths = sorted(folder.glob('*.md')) if folder.is_dir() else []
    if args.notes_cmd == 'list':
        metas = sorted((note_meta(p) for p in paths), key=lambda m: m.get('updated', ''), reverse=True)
        for m in metas:
            print(f"{m['slug']}  |  {m.get('area', '')}  |  {m.get('updated', '')}  |  {m.get('projects', '')}")
        if not metas:
            print(f'No notes yet in {folder}')
    elif args.notes_cmd == 'find':
        words = [w.lower() for w in args.words if w.strip()]
        ranked = []
        for p in paths:
            lines = p.read_text(encoding='utf-8', errors='replace').splitlines()
            haystack = (p.stem + '\n' + '\n'.join(lines)).lower()
            matched = [w for w in words if w in haystack]
            if matched:
                hits = sum(haystack.count(w) for w in words)
                shown = [(n, line) for n, line in enumerate(lines, 1) if any(w in line.lower() for w in words)]
                ranked.append((len(matched), hits, p, shown))
        ranked.sort(key=lambda r: (-r[0], -r[1], r[2].name))
        for n_words, hits, p, shown in ranked:
            print(f'{p}  ({n_words}/{len(words)} words, {hits} hits)')
            for n, line in shown[:args.lines]:
                print(f'  {n}: {line.strip()[:200]}')
            if len(shown) > args.lines:
                print(f'  … {len(shown) - args.lines} more matching lines')
        if not ranked:
            print(f"No notes match: {' '.join(words)}")
    elif args.notes_cmd == 'show':
        path = note_path(args.root, args.slug)
        if not path.exists():
            raise ValueError(f'No note {args.slug}; `notes list` shows them')
        print(path.read_text(encoding='utf-8', errors='replace'), end='')
    elif args.notes_cmd == 'path':
        path = note_path(args.root, args.slug)
        if args.new and not path.exists():
            if not args.area or not args.projects:
                raise ValueError('--new needs --area and --projects')
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            projects = ', '.join(x.strip() for x in args.projects.split(',') if x.strip())
            with path.open('x', encoding='utf-8') as f:  # never overwrite
                f.write(NOTE_TEMPLATE.format(area=args.area, projects=projects,
                                             keywords=args.keywords or '<comma words>',
                                             date=time.strftime('%Y-%m-%d')))
        elif not path.exists():
            print('(no such note yet; add --new --area "<area>" --projects <p> to create it)', file=sys.stderr)
        print(path)


SLUG = r'[a-z0-9]+(-[a-z0-9]+)*'


def feedback_line():
    """The brief's last line: where to report a board gap. MESSAGE_BOARD_FEEDBACK, else
    messageBoard.feedback in the subagents skill's accounts.local.json; with neither the line is left out."""
    text = os.environ.get('MESSAGE_BOARD_FEEDBACK')
    if text is None:
        try:
            cfg = json.loads((Path(__file__).resolve().parents[2] / 'subagents' / 'accounts.local.json').read_text())
            text = (cfg.get('messageBoard') or {}).get('feedback')
        except (OSError, ValueError):
            text = None
    return f'If the board would have helped you more (missing info, a command you wanted, noise), file it: {text}' if text else ''


IMPROVE_LINE = feedback_line()


def check_area(slug):
    if not re.fullmatch(SLUG, slug):
        raise ValueError(f'Bad area {slug!r}: use a note slug like mail-sync')
    return slug


def comma_list(text):
    return [x.strip() for x in (text or '').split(',') if x.strip()]


def when(ts):
    return time.strftime('%Y-%m-%d %H:%M', time.localtime(ts)) if ts else '-'


def one_line(text, limit):
    text = ' '.join((text or '').split())
    return text if len(text) <= limit else text[:limit - 1] + '…'


def clip(text, limit):
    if len(text) <= limit:
        return text
    return text[:limit - 1].rstrip() + '…' if limit > 1 else '…'


def note_summary(path):
    """The note's `## Summary` section; without one, its first paragraph after the front lines."""
    lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    if '## Summary' in (line.strip() for line in lines):
        start = [line.strip() for line in lines].index('## Summary') + 1
        body = []
        for line in lines[start:]:
            if line.startswith('## '):
                break
            body.append(line)
        return '\n'.join(body).strip()
    paras = '\n'.join(lines).split('\n\n')
    if paras and re.match(r'\w+:', paras[0]):
        paras = paras[1:]  # front lines
    return next((p.strip() for p in paras if p.strip()), '')


def thread_root(db, post):
    seen = set()
    while post['reply_to'] and post['id'] not in seen:
        seen.add(post['id'])
        parent = db.execute('SELECT * FROM posts WHERE id=?', (post['reply_to'],)).fetchone()
        if not parent:
            break
        post = parent
    return post


def print_thread(db, post_id):
    top = db.execute('SELECT * FROM posts WHERE id=?', (post_id,)).fetchone()
    if not top:
        raise ValueError(f'No post {post_id}')
    out = []

    def walk(post, depth, seen):
        pad = '  ' * depth
        area = f" [{post['area']}]" if post['area'] else ''
        out.append(f"{pad}#{post['id']}{area} {post['sender']} → {post['recipient']} · {when(post['created'])} · {post['topic']}")
        out.extend(f'{pad}  {line}' for line in post['body'].rstrip().splitlines())
        for child in db.execute('SELECT * FROM posts WHERE reply_to=? ORDER BY id', (post['id'],)):
            if child['id'] not in seen:
                walk(child, depth + 1, seen | {child['id']})

    if top['reply_to']:
        out.append(f"(reply to #{top['reply_to']}; `thread {top['reply_to']}` shows its parent)")
    walk(top, 0, {top['id']})
    print('\n'.join(out))


def list_areas(db, root):
    rows = {r['area']: dict(r) for r in db.execute(
        'SELECT area, count(*) AS posts, max(created) AS last FROM posts WHERE area IS NOT NULL GROUP BY area')}
    folder = root / 'notes'
    notes_ = {p.stem for p in folder.glob('*.md')} if folder.is_dir() else set()
    result = [{'area': a, 'note': a in notes_, 'posts': rows.get(a, {}).get('posts', 0),
               'last': rows.get(a, {}).get('last')} for a in sorted(notes_ | set(rows))]
    result.sort(key=lambda r: -(r['last'] or 0))
    return result


def thread_replies(db, root_id):
    """Every descendant of a post (replies to replies too), in id order."""
    found, frontier = {}, [root_id]
    while frontier:
        marks = ','.join('?' * len(frontier))
        rows = db.execute(f'SELECT id, sender, body FROM posts WHERE reply_to IN ({marks})', frontier).fetchall()
        frontier = [r['id'] for r in rows if r['id'] not in found and r['id'] != root_id]
        found.update((r['id'], r) for r in rows if r['id'] in frontier)
    return [found[i] for i in sorted(found)]


def file_pattern(files):
    """Owned files as paths or basenames, on a path boundary: watches.py matches src/watches.py, not overwatches.py.bak."""
    names = sorted({n for f in files for n in (f, Path(f).name) if n})
    if not names:
        return None
    alts = '|'.join(re.escape(n) for n in names)
    return re.compile(rf'(?:^|(?<=[\s/`\'"(\[,:=]))(?:{alts})(?![\w-]|\.\w)', re.M)


BRIEF_POSTS_HEAD = 'Posts (most helped, then findings, then newest; status reports shortened):'
BRIEF_NO_POSTS = '(no posts yet in these areas or naming these files)'


# Progress and handoff reports (done/blocked/waiting/round N/verdict packets): a lead rarely needs them
# in a brief, so they rank below findings and show a short line.
STATUS_RE = re.compile(r'(?<![\w-])(?:done|status|ready|complete[sd]?|blocked|wait(?:s|ing)?|queued|resum(?:e|es|ing)|'
                       r'starting|packet|r\d+|round \d+|recheck|verdict|approved|committed|released|handoff)(?![\w-])', re.I)


def is_status(post):
    head = f"{post['topic'] or ''} {(post['body'] or '')[:80]}"
    return bool(STATUS_RE.search(head)) or 'VERDICT:' in (post['body'] or '')


def brief(db, args):
    """Context block for a worker: area note summaries + the most helped findings, newest first; logged in briefs."""
    areas = [check_area(a) for a in comma_list(args.area)]
    files = comma_list(args.files)
    if not areas:
        raise ValueError('--area needs at least one slug')
    if args.max_tokens < 200:
        raise ValueError('--max-tokens must be at least 200')
    cap = args.max_tokens * 4  # chars, at the chars/4 token estimate
    cur = db.execute('INSERT INTO briefs(agent,areas,files,created) VALUES(?,?,?,?)',
                     (args.agent, ','.join(areas), ','.join(files), time.time()))
    brief_id = cur.lastrowid
    head = f"## Board brief (areas: {', '.join(areas)}" + (f"; files: {', '.join(files)}" if files else '') + ')'
    foot = (f'Brief #{brief_id}: when done, run board.py helped --agent {args.agent} --brief {brief_id} '
            f'--posts <ids> (or --none)' + (f'\n{IMPROVE_LINE}' if IMPROVE_LINE else ''))
    notes_, posts_ = [], []  # (note slug or None, text), (post id, text)

    def render():
        return '\n'.join([head, *(t for _, t in notes_), BRIEF_POSTS_HEAD,
                          *([t for _, t in posts_] or [BRIEF_NO_POSTS]), foot])

    if len(render()) > cap:  # very long --files list: shorten the heading
        head = clip(head, max(len(head) - (len(render()) - cap), 20))
    # Notes (known ones and one line for unknown areas) share at most two thirds of the room left: the
    # note is what leads find useful; posts fill what the notes leave.
    known = [a for a in areas if (args.root / 'notes' / f'{a}.md').exists()]
    unknown = [a for a in areas if a not in known]
    items = len(known) + (1 if unknown else 0)
    each = (cap - len(render())) * 2 // 3 // items - 1  # -1: its newline
    for area in known:
        notes_.append((area, clip(f"Note {area}:\n{note_summary(args.root / 'notes' / f'{area}.md')}", each)))
    if unknown:
        notes_.append((None, clip(f"(no note for area {', '.join(unknown)}; `notes list` shows them)", each)))
    # Candidate threads: posts in these areas or naming these files, each counted once at its root.
    pattern = file_pattern(files)
    roots = {}
    for post in db.execute('SELECT * FROM posts ORDER BY id DESC'):
        if post['area'] in areas or (pattern and pattern.search(f"{post['topic']}\n{post['body']}")):
            root = thread_root(db, post)
            roots.setdefault(root['id'], root)
    votes = dict(db.execute("SELECT post, count(*) FROM helped WHERE verdict='helped' AND post IS NOT NULL GROUP BY post").fetchall())
    status = {i: is_status(p) for i, p in roots.items()}
    ranked = sorted(roots.values(), key=lambda p: (-votes.get(p['id'], 0), status[p['id']], -p['created'], -p['id']))
    for post in ranked:
        tag = f" ▲{votes[post['id']]}" if votes.get(post['id']) else ''
        area = f" [{post['area']}]" if post['area'] else ''
        body = one_line(post['body'], 120 if status[post['id']] and not votes.get(post['id']) else 400)
        part = f"- #{post['id']}{area}{tag} {when(post['created'])} {post['sender']}: {one_line(post['topic'], 80)} — {body}"
        replies = thread_replies(db, post['id'])
        if replies:
            part += '\n  ↳ ' + one_line('; '.join(f"#{r['id']} {r['sender']}: {one_line(r['body'], 80)}" for r in replies), 240)
        posts_.append((post['id'], part))
        if len(render()) > cap:
            posts_.pop()
            break
    # The whole assembled block is the cap's measure; trim posts, then notes, if anything still spills.
    while len(render()) > cap and posts_:
        posts_.pop()
    while len(render()) > cap and notes_:
        notes_.pop()
    text = render()
    if len(text) > cap:
        raise ValueError(f'--max-tokens {args.max_tokens} is too small for this brief ({len(text)} chars)')
    db.execute('UPDATE briefs SET post_ids=?, note_slugs=?, chars=?, est_tokens=? WHERE id=?',
               (','.join(str(i) for i, _ in posts_), ','.join(a for a, _ in notes_ if a), len(text),
                -(-len(text) // 4), brief_id))
    return text


def mark_helped(db, args):
    if args.none and not args.brief:
        raise ValueError('--none needs --brief')
    if args.brief and not db.execute('SELECT 1 FROM briefs WHERE id=?', (args.brief,)).fetchone():
        raise ValueError(f'No brief {args.brief}')
    posts = [int(x) for x in comma_list(args.posts)] if args.posts else [None]
    for post_id in posts:
        if post_id is not None and not db.execute('SELECT 1 FROM posts WHERE id=?', (post_id,)).fetchone():
            raise ValueError(f'No post {post_id}')
    verdict = 'unused' if args.none else 'helped'
    for post_id in posts:
        exists = db.execute('SELECT 1 FROM helped WHERE brief IS ? AND agent=? AND post IS ? AND verdict=?',
                            (args.brief, args.agent, post_id, verdict)).fetchone()
        if not exists:
            db.execute('INSERT INTO helped(brief,agent,post,verdict,note,created) VALUES(?,?,?,?,?,?)',
                       (args.brief, args.agent, post_id, verdict, args.note, time.time()))
    return {'brief': args.brief, 'verdict': verdict, 'posts': [p for p in posts if p is not None]}


def board_stats(db, root, since):
    if since == 'all':
        start = 0.0
    else:
        m = re.fullmatch(r'(\d+)d', since)
        if not m:
            raise ValueError('--since takes 7d, 30d, <N>d or all')
        start = time.time() - int(m.group(1)) * 86400
    briefs = [dict(r) for r in db.execute('SELECT id, est_tokens FROM briefs WHERE created>=?', (start,))]
    verdicts = {}
    for r in db.execute('SELECT h.brief, h.verdict FROM helped h JOIN briefs b ON b.id=h.brief WHERE b.created>=?', (start,)):
        verdicts.setdefault(r['brief'], set()).add(r['verdict'])
    tokens = lambda rows: sum(b['est_tokens'] or 0 for b in rows)  # noqa: E731
    answered = [b for b in briefs if b['id'] in verdicts]
    helped = [b for b in answered if 'helped' in verdicts[b['id']]]
    wasted = [b for b in answered if 'helped' not in verdicts[b['id']]]
    unanswered = [b for b in briefs if b['id'] not in verdicts]
    pct = lambda a, b: round(100 * a / b, 1) if b else None  # noqa: E731
    top = [dict(r) for r in db.execute('''
      SELECT h.post, count(*) AS marks, p.topic, p.area, p.sender FROM helped h JOIN posts p ON p.id=h.post
      WHERE h.verdict='helped' AND h.created>=? GROUP BY h.post ORDER BY marks DESC, h.post DESC LIMIT 10
    ''', (start,))]
    posted = {r[0] for r in db.execute('SELECT DISTINCT area FROM posts WHERE area IS NOT NULL AND created>=?', (start,))}
    folder = root / 'notes'
    notes_ = sorted(p.stem for p in folder.glob('*.md')) if folder.is_dir() else []
    return {
        'since': since, 'since_ts': start or None,
        'briefs': len(briefs), 'tokens_injected': tokens(briefs),
        'briefs_answered': len(answered), 'answered_pct': pct(len(answered), len(briefs)),
        'briefs_helped': len(helped), 'helped_pct': pct(len(helped), len(answered)),
        'briefs_none': len(wasted), 'wasted_tokens': tokens(wasted),
        'unanswered': len(unanswered), 'unanswered_tokens': tokens(unanswered),
        'top_helped': top,
        'areas_without_posts': [a for a in notes_ if a not in posted],
    }


def print_stats(s):
    pct = lambda v: '-' if v is None else f'{v:g}%'  # noqa: E731
    print(f"Board stats, {'all time' if s['since'] == 'all' else 'last ' + s['since']}")
    print(f"Briefs made: {s['briefs']} · tokens injected: {s['tokens_injected']:,}")
    print(f"Answered: {s['briefs_answered']} ({pct(s['answered_pct'])}) · with a helped post: "
          f"{s['briefs_helped']} ({pct(s['helped_pct'])} of answered)")
    print(f"Marked none: {s['briefs_none']} · wasted tokens: {s['wasted_tokens']:,}")
    print(f"Unanswered: {s['unanswered']} · their tokens: {s['unanswered_tokens']:,}")
    print('Top helped posts:' if s['top_helped'] else 'Top helped posts: none yet')
    for t in s['top_helped']:
        area = f" [{t['area']}]" if t['area'] else ''
        print(f"  #{t['post']} ×{t['marks']}{area} {one_line(t['topic'], 80)}")
    print(f"Areas with no posts ({len(s['areas_without_posts'])}): {', '.join(s['areas_without_posts']) or '-'}")


PLAN_RE = re.compile(r'(?<!\w)(?:plan[\s_-]?(\d{1,4})|p(\d{2,4}))(?!\d)', re.I)


def slug_counts(text, slugs):
    """Mentions per note slug: hyphenated slugs as words, one-word slugs only as notes/<slug>.md."""
    counts = {}
    for slug in slugs:
        pattern = rf'(?<![\w-]){re.escape(slug)}(?![\w-])' if '-' in slug else rf'notes/{re.escape(slug)}\.md'
        n = len(re.findall(pattern, text))
        if n:
            counts[slug] = n
    return counts


def best_slug(text, slugs, clear=False):
    """Most-mentioned slug, ties to the earliest; with clear, None unless one slug leads outright."""
    counts = slug_counts(text, slugs)
    if not counts:
        return None
    top = max(counts.values())
    if clear and list(counts.values()).count(top) > 1:
        return None
    return max(counts, key=lambda s: (counts[s], -text.find(s)))


def backfill_areas(db, root, planning):
    folder = root / 'notes'
    slugs = sorted(p.stem for p in folder.glob('*.md')) if folder.is_dir() else []
    plan_docs = {}
    for doc in sorted(planning.glob('*/plan.md')) if planning.is_dir() else []:
        num = re.match(r'(\d+)-', doc.parent.name)
        if num:
            plan_docs.setdefault(int(num.group(1)), []).append(doc)
    plan_slug = {}

    def slug_for_plan(n):
        if n not in plan_slug:
            text = '\n'.join(d.read_text(encoding='utf-8', errors='replace') for d in plan_docs.get(n, []))
            plan_slug[n] = best_slug(text, slugs, clear=True) if text else None
        return plan_slug[n]

    count = 0
    for post in db.execute('SELECT id, sender, topic, body FROM posts WHERE area IS NULL').fetchall():
        text = f"{post['topic']}\n{post['body']}"
        area = best_slug(text, slugs)
        if not area:
            # The sender's own plan first (p12-lead, plan12-…), then plans the post names; a plan whose
            # doc mentions several areas equally says nothing, so it is skipped rather than guessed.
            for m in PLAN_RE.finditer(f"{post['sender'] or ''}\n{text}"):
                area = slug_for_plan(int(m.group(1) or m.group(2)))
                if area:
                    break
        if area:
            db.execute('UPDATE posts SET area=? WHERE id=? AND area IS NULL', (area, post['id']))
            count += 1
    return {'backfilled': count}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(os.environ.get('MESSAGE_BOARD_HOME', '~/message_board')).expanduser())
    sub = parser.add_subparsers(dest='cmd', required=True)
    card = sub.add_parser('status', help='Register/update your own work card')
    card.add_argument('--agent', required=True, help='Exact T3 thread ID or stable CLI job ID')
    card.add_argument('--title', required=True)
    card.add_argument('--summary', required=True)
    card.add_argument('--project', default=str(Path.cwd()))
    card.add_argument('--state', choices=['working', 'blocked', 'done'], default='working')
    sub.add_parser('who', help='Cards with age and stale marker; no inferred liveness')
    post = sub.add_parser('post')
    post.add_argument('--agent', required=True)
    post.add_argument('--to', default='*', help='Exact recipient ID; default broadcasts')
    post.add_argument('--topic', required=True)
    post.add_argument('--file', type=Path, required=True, help='UTF-8 message file; use - for stdin')
    post.add_argument('--area', help='Area slug (same slugs as notes), e.g. mail-sync')
    post.add_argument('--reply-to', type=int, help='Parent post id; the reply takes its area unless --area is given')
    read = sub.add_parser('read', help='Read without marking messages acknowledged')
    read.add_argument('--agent', required=True)
    read.add_argument('--after', type=int, default=0)
    read.add_argument('--limit', type=int, default=30)
    read.add_argument('--unread', action='store_true')
    read.add_argument('--area', help='Only posts in this area')
    thread = sub.add_parser('thread', help='A post and its replies, nested')
    thread.add_argument('id', type=int)
    sub.add_parser('areas', help='Area slugs (notes + post areas) with post counts and last activity')
    brf = sub.add_parser('brief', help='Context block for a worker; logged so helped marks can measure it')
    brf.add_argument('--agent', required=True, help='Job ID of the worker the brief is for')
    brf.add_argument('--area', required=True, help='Area slug or comma list')
    brf.add_argument('--files', help='Comma list of owned files; posts naming them (path or basename) are included')
    brf.add_argument('--max-tokens', type=int, default=1500, help='Cap at the chars/4 estimate (default 1500)')
    hlp = sub.add_parser('helped', help='Mark which brief posts helped (or --none); --posts alone is a free upvote')
    hlp.add_argument('--agent', required=True)
    hlp.add_argument('--brief', type=int)
    marks = hlp.add_mutually_exclusive_group(required=True)
    marks.add_argument('--posts', help='Comma list of post ids that helped')
    marks.add_argument('--none', action='store_true', help='Nothing in the brief helped')
    hlp.add_argument('--note')
    sts = sub.add_parser('stats', help='Are briefs worth their tokens? Helped share, wasted tokens, top posts')
    sts.add_argument('--since', default='7d', help='7d, 30d, <N>d or all (default 7d)')
    sts.add_argument('--json', action='store_true')
    bfa = sub.add_parser('backfill-areas', help='One-off: best-effort area for old posts from note slugs and plan docs')
    bfa.add_argument('--planning', type=Path, required=True, help='Directory of <plan>/plan.md docs')
    ack = sub.add_parser('ack')
    ack.add_argument('--agent', required=True)
    ack.add_argument('ids', nargs='+', type=int)
    threads = sub.add_parser('threads', help='Read local T3 titles and request excerpts')
    threads.add_argument('--db', type=Path, default=Path.home()/'.t3/userdata/statev2.sqlite')
    threads.add_argument('--project', help='Filter by workspace root')
    threads.add_argument('--all', action='store_true', help='Include settled and archived threads')
    nts = sub.add_parser('notes', help='Lasting per-area how-tos (markdown under <root>/notes)')
    nsub = nts.add_subparsers(dest='notes_cmd', required=True)
    nsub.add_parser('list', help='One line per note, newest update first')
    find = nsub.add_parser('find', help='Case-insensitive word match, ranked by hits')
    find.add_argument('words', nargs='+')
    find.add_argument('--lines', type=int, default=5, help='Matching lines shown per note')
    show = nsub.add_parser('show')
    show.add_argument('slug')
    npath = nsub.add_parser('path', help='Print the note path; --new creates it from the template')
    npath.add_argument('slug')
    npath.add_argument('--new', action='store_true')
    npath.add_argument('--area')
    npath.add_argument('--projects', help='Comma list, e.g. myapp or myapp,russell-skills')
    npath.add_argument('--keywords', help='Comma words for find')
    args = parser.parse_args()
    if args.cmd == 'notes':
        return notes(args)
    if args.cmd == 'threads':
        result = t3_threads(args.db, args.project, args.all)
    else:
        with connect(args.root) as db:
            if args.cmd == 'status':
                db.execute('INSERT OR REPLACE INTO cards VALUES (?,?,?,?,?,?)',
                           (args.agent, args.title, args.summary, args.project, args.state, time.time()))
                result = {'registered': args.agent}
            elif args.cmd == 'who':
                result = [dict(r) for r in db.execute('SELECT * FROM cards ORDER BY updated DESC')]
                for r in result:
                    r['age_minutes'] = round((time.time()-r['updated'])/60, 1)
                    r['stale'] = r['age_minutes'] > 120
            elif args.cmd == 'post':
                body = sys.stdin.read() if str(args.file) == '-' else args.file.read_text()
                if not body.strip() or len(body.encode()) > 65536:
                    raise ValueError('Message must contain text and be at most 64 KiB')
                area = check_area(args.area) if args.area else None
                if args.reply_to is not None:
                    parent = db.execute('SELECT area FROM posts WHERE id=?', (args.reply_to,)).fetchone()
                    if not parent:
                        raise ValueError(f'No post {args.reply_to} to reply to')
                    area = area or parent['area']
                cur = db.execute('INSERT INTO posts(sender,recipient,topic,body,created,area,reply_to) VALUES(?,?,?,?,?,?,?)',
                                 (args.agent, args.to, args.topic, body, time.time(), area, args.reply_to))
                result = {'posted': cur.lastrowid, 'recipient': args.to, 'area': area, 'reply_to': args.reply_to,
                          'delivery': 'passive; recipient must read board'}
            elif args.cmd == 'read':
                if not 1 <= args.limit <= 500:
                    raise ValueError('--limit must be 1..500')
                result = [dict(r) for r in db.execute('''
                  SELECT p.*, r.post IS NOT NULL AS acknowledged FROM posts p
                  LEFT JOIN receipts r ON r.post=p.id AND r.agent=?
                  WHERE p.recipient IN ('*', ?) AND p.id>? AND (?=0 OR r.post IS NULL) AND (? IS NULL OR p.area=?)
                  ORDER BY p.id LIMIT ?
                ''', (args.agent, args.agent, args.after, args.unread, args.area, args.area, args.limit))]
            elif args.cmd == 'thread':
                return print_thread(db, args.id)
            elif args.cmd == 'areas':
                result = list_areas(db, args.root)
            elif args.cmd == 'brief':
                return print(brief(db, args))
            elif args.cmd == 'helped':
                result = mark_helped(db, args)
            elif args.cmd == 'stats':
                result = board_stats(db, args.root, args.since)
                if not args.json:
                    return print_stats(result)
            elif args.cmd == 'backfill-areas':
                result = backfill_areas(db, args.root, args.planning)
            elif args.cmd == 'ack':
                for post_id in args.ids:
                    row = db.execute("SELECT id FROM posts WHERE id=? AND recipient IN ('*',?)", (post_id, args.agent)).fetchone()
                    if not row:
                        raise ValueError(f'Post {post_id} does not exist or is addressed to another agent')
                    db.execute('INSERT OR IGNORE INTO receipts VALUES (?,?)', (args.agent, post_id))
                result = {'acknowledged': args.ids}
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (OSError, sqlite3.Error, ValueError) as e:
        sys.exit(f'message-board: {e}')
