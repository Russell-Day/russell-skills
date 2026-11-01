"""board.py tests on an isolated board (tmp --root); never the live ~/message_board."""
import json
import math
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

import pytest

# The brief's feedback line comes from this (else the repo's accounts.local.json); pin it for the tests.
os.environ['MESSAGE_BOARD_FEEDBACK'] = '`fb add "<text>" --project message-board`'
BOARD = Path(__file__).with_name('board.py')
NOTE = '''area: Mail sync
projects: myapp
keywords: mail
updated: 2026-10-30

## Summary
- Polling only; fast pass every 2 min.
- Gotcha: promo gate.

## Log
- 2026-10-30 plan 1 S1 · abc · log line that must not show
'''


@pytest.fixture
def root(tmp_path):
    (tmp_path / 'notes').mkdir()
    (tmp_path / 'notes' / 'mail-sync.md').write_text(NOTE)
    return tmp_path


def run(root, *args, ok=True):
    proc = subprocess.run([sys.executable, str(BOARD), '--root', str(root), *map(str, args)],
                          capture_output=True, text=True, timeout=30)
    if ok:
        assert proc.returncode == 0, proc.stderr
    return proc


def js(root, *args):
    return json.loads(run(root, *args).stdout)


def post(root, body='hello', topic='t', agent='a', **opts):
    path = root / 'msg.txt'
    path.write_text(body)
    extra = [x for k, v in opts.items() for x in (f"--{k.replace('_', '-')}", v)]
    return js(root, 'post', '--agent', agent, '--topic', topic, '--file', path, *extra)['posted']


def db(root):
    con = sqlite3.connect(root / 'board.sqlite')
    con.row_factory = sqlite3.Row
    return con


def brief_row(root, brief_id):
    with db(root) as con:
        return dict(con.execute('SELECT * FROM briefs WHERE id=?', (brief_id,)).fetchone())


def brief_id(out):
    return int(out.split('Brief #')[1].split(':')[0])


def test_migration_keeps_rows_and_is_idempotent(root):
    con = sqlite3.connect(root / 'board.sqlite')
    con.executescript('''
      CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, recipient TEXT,
        topic TEXT, body TEXT, created REAL);
      CREATE TABLE cards (agent TEXT PRIMARY KEY, title TEXT, summary TEXT, project TEXT, state TEXT, updated REAL);
      CREATE TABLE receipts (agent TEXT, post INTEGER, PRIMARY KEY(agent, post));
      INSERT INTO posts(sender,recipient,topic,body,created) VALUES ('old','*','legacy','kept body',1.0);
    ''')
    con.close()
    run(root, 'who')
    run(root, 'who')  # second connect: no duplicate-column error
    with db(root) as con:
        cols = [r['name'] for r in con.execute('PRAGMA table_info(posts)')]
        assert cols.count('area') == 1 and cols.count('reply_to') == 1
        row = dict(con.execute('SELECT * FROM posts').fetchone())
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert row['body'] == 'kept body' and row['sender'] == 'old' and row['area'] is None
    assert {'briefs', 'helped'} <= tables
    new = post(root, area='mail-sync')
    assert new == 2


def test_post_area_and_read_area(root):
    a = post(root, area='mail-sync')
    post(root, area='class-page')
    post(root)
    rows = js(root, 'read', '--agent', 'x', '--area', 'mail-sync')
    assert [r['id'] for r in rows] == [a] and rows[0]['area'] == 'mail-sync'
    assert len(js(root, 'read', '--agent', 'x')) == 3


def test_post_bad_area_slug(root):
    (root / 'm.txt').write_text('x')
    proc = run(root, 'post', '--agent', 'a', '--topic', 't', '--file', root / 'm.txt', '--area', 'Bad Slug', ok=False)
    assert proc.returncode != 0 and 'Bad area' in proc.stderr
    assert js(root, 'read', '--agent', 'a') == []


def test_reply_inherits_area(root):
    parent = post(root, area='mail-sync')
    reply = post(root, reply_to=parent)
    other = post(root, reply_to=parent, area='class-page')
    with db(root) as con:
        areas = dict(con.execute('SELECT id, area FROM posts').fetchall())
        assert con.execute('SELECT reply_to FROM posts WHERE id=?', (reply,)).fetchone()[0] == parent
    assert areas[reply] == 'mail-sync' and areas[other] == 'class-page'


def test_reply_to_unknown_post_fails(root):
    (root / 'm.txt').write_text('x')
    proc = run(root, 'post', '--agent', 'a', '--topic', 't', '--file', root / 'm.txt', '--reply-to', 99, ok=False)
    assert proc.returncode != 0 and 'No post 99' in proc.stderr


def test_thread_nesting(root):
    top = post(root, body='root body', topic='root', area='mail-sync')
    child = post(root, body='child body', topic='child', reply_to=top)
    post(root, body='grandchild body', topic='grand', reply_to=child)
    post(root, body='second child', topic='child2', reply_to=top)
    lines = run(root, 'thread', top).stdout.splitlines()
    heads = [line for line in lines if '#' in line]
    assert heads[0].startswith(f'#{top} [mail-sync]')
    assert heads[1].startswith(f'  #{child} ')
    assert heads[2].startswith(f'    #{child + 1} ')
    assert heads[3].startswith(f'  #{child + 2} ')
    assert '      grandchild body' in lines
    assert 'reply to #' in run(root, 'thread', child).stdout


def test_areas_lists_notes_and_post_areas(root):
    post(root, area='class-page')
    post(root, area='class-page')
    rows = {r['area']: r for r in js(root, 'areas')}
    assert rows['class-page']['posts'] == 2 and rows['class-page']['note'] is False and rows['class-page']['last']
    assert rows['mail-sync'] == {'area': 'mail-sync', 'note': True, 'posts': 0, 'last': None}
    assert next(iter(rows)) == 'class-page'  # newest activity first


def test_brief_note_posts_footer_and_row(root):
    p1 = post(root, body='mail finding', topic='fast pass', area='mail-sync')
    r1 = post(root, body='agreed, fixed', reply_to=p1)
    post(root, body='unrelated', area='class-page')
    out = run(root, 'brief', '--agent', 'job1', '--area', 'mail-sync').stdout
    assert 'Polling only; fast pass every 2 min.' in out and 'log line' not in out
    assert f'#{p1} [mail-sync]' in out and f'↳ #{r1} a: agreed, fixed' in out
    assert 'unrelated' not in out
    bid = brief_id(out)
    assert f'Brief #{bid}: when done, run board.py helped --agent job1 --brief {bid} --posts <ids> (or --none)' in out
    assert 'fb add "<text>" --project message-board' in out
    row = brief_row(root, bid)
    assert row['agent'] == 'job1' and row['areas'] == 'mail-sync' and row['post_ids'] == str(p1)
    assert row['note_slugs'] == 'mail-sync'


def test_brief_first_paragraph_without_summary(root):
    (root / 'notes' / 'plain-note.md').write_text('area: Plain\nupdated: 2026-10-30\n\nFirst para line.\nStill first.\n\nSecond para.\n')
    out = run(root, 'brief', '--agent', 'j', '--area', 'plain-note').stdout
    assert 'First para line.\nStill first.' in out and 'Second para' not in out


def test_brief_matches_files_by_basename(root):
    hit = post(root, body='watch out in src/backend/mail_triage/watches.py')
    by_name = post(root, body='watches.py has a race')
    post(root, body='nothing relevant')
    out = run(root, 'brief', '--agent', 'j', '--area', 'class-page', '--files', 'src/backend/mail_triage/watches.py').stdout
    assert f'#{hit} ' in out and f'#{by_name} ' in out and 'nothing relevant' not in out


def test_brief_unknown_area(root):
    out = run(root, 'brief', '--agent', 'j', '--area', 'no-such-area').stdout
    assert out.count('no note for area no-such-area') == 1
    assert 'no posts yet' in out and 'Brief #' in out


def test_brief_respects_token_cap_and_logs_tokens(root):
    ids = [post(root, body='x' * 380 + f' n{i}', area='mail-sync') for i in range(20)]
    out = run(root, 'brief', '--agent', 'j', '--area', 'mail-sync', '--max-tokens', 400).stdout
    text = out[:-1]  # print's newline
    assert len(text) <= 1600
    row = brief_row(root, brief_id(out))
    assert row['chars'] == len(text) and row['est_tokens'] == math.ceil(len(text) / 4)
    shown = [int(x) for x in row['post_ids'].split(',')]
    assert 0 < len(shown) < 20 and shown == sorted(ids, reverse=True)[:len(shown)]
    assert run(root, 'brief', '--agent', 'j', '--area', 'mail-sync', '--max-tokens', 50, ok=False).returncode != 0


def test_helped_marks_reorder_brief(root):
    old = post(root, body='older', area='mail-sync')
    new = post(root, body='newer', area='mail-sync')
    first = run(root, 'brief', '--agent', 'j', '--area', 'mail-sync').stdout
    assert first.index(f'#{new} ') < first.index(f'#{old} ')
    js(root, 'helped', '--agent', 'j', '--brief', brief_id(first), '--posts', old)
    second = run(root, 'brief', '--agent', 'j', '--area', 'mail-sync').stdout
    assert second.index(f'#{old} ') < second.index(f'#{new} ') and f'#{old} [mail-sync] ▲1' in second


def test_helped_variants(root):
    p1, p2 = post(root, area='mail-sync'), post(root, area='mail-sync')
    bid = brief_id(run(root, 'brief', '--agent', 'j', '--area', 'mail-sync').stdout)
    assert js(root, 'helped', '--agent', 'j', '--brief', bid, '--posts', f'{p1},{p2}')['posts'] == [p1, p2]
    js(root, 'helped', '--agent', 'j', '--brief', bid, '--posts', p1)  # repeat: not duplicated
    js(root, 'helped', '--agent', 'k', '--brief', bid, '--none', '--note', 'off topic')
    js(root, 'helped', '--agent', 'k', '--posts', p2)
    with db(root) as con:
        rows = [tuple(r) for r in con.execute('SELECT brief, agent, post, verdict, note FROM helped ORDER BY id')]
    assert rows == [(bid, 'j', p1, 'helped', None), (bid, 'j', p2, 'helped', None),
                    (bid, 'k', None, 'unused', 'off topic'), (None, 'k', p2, 'helped', None)]
    assert 'needs --brief' in run(root, 'helped', '--agent', 'k', '--none', ok=False).stderr
    assert 'No brief 99' in run(root, 'helped', '--agent', 'k', '--brief', 99, '--posts', p1, ok=False).stderr
    assert 'No post 99' in run(root, 'helped', '--agent', 'k', '--posts', 99, ok=False).stderr
    assert run(root, 'helped', '--agent', 'k', '--brief', bid, ok=False).returncode != 0


def stats_fixture(root):
    p1, p2 = post(root, topic='best', area='mail-sync'), post(root, topic='ok')
    run(root, 'who')  # creates the tables
    now = time.time()
    with db(root) as con:
        for bid, tokens in ((1, 100), (2, 200), (3, 300), (4, 400)):
            con.execute('INSERT INTO briefs(id,agent,areas,chars,est_tokens,created) VALUES(?,?,?,?,?,?)',
                        (bid, 'j', 'mail-sync', tokens * 4, tokens, now))
        con.execute('INSERT INTO briefs(id,agent,areas,chars,est_tokens,created) VALUES(5,?,?,?,?,?)',
                    ('j', 'mail-sync', 4000, 1000, now - 10 * 86400))
    js(root, 'helped', '--agent', 'j', '--brief', 1, '--posts', p1)
    js(root, 'helped', '--agent', 'j', '--brief', 2, '--none')
    js(root, 'helped', '--agent', 'j', '--brief', 3, '--posts', f'{p1},{p2}')
    js(root, 'helped', '--agent', 'k', '--brief', 3, '--none')
    return p1, p2


def test_stats_math_and_json_shape(root):
    (root / 'notes' / 'class-page.md').write_text(NOTE)
    p1, p2 = stats_fixture(root)
    s = js(root, 'stats', '--since', '7d', '--json')
    assert set(s) == {'since', 'since_ts', 'briefs', 'tokens_injected', 'briefs_answered', 'answered_pct',
                      'briefs_helped', 'helped_pct', 'briefs_none', 'wasted_tokens', 'unanswered',
                      'unanswered_tokens', 'top_helped', 'areas_without_posts'}
    assert (s['briefs'], s['tokens_injected'], s['briefs_answered'], s['briefs_helped']) == (4, 1000, 3, 2)
    assert (s['helped_pct'], s['answered_pct']) == (66.7, 75.0)
    assert (s['briefs_none'], s['wasted_tokens'], s['unanswered'], s['unanswered_tokens']) == (1, 200, 1, 400)
    assert [(t['post'], t['marks']) for t in s['top_helped']] == [(p1, 2), (p2, 1)]
    assert set(s['top_helped'][0]) == {'post', 'marks', 'topic', 'area', 'sender'}
    assert s['areas_without_posts'] == ['class-page']


def test_stats_since_window(root):
    stats_fixture(root)
    s = js(root, 'stats', '--since', 'all', '--json')
    assert (s['briefs'], s['tokens_injected'], s['unanswered'], s['since_ts']) == (5, 2000, 2, None)
    assert run(root, 'stats', '--since', 'week', ok=False).returncode != 0


def test_stats_text(root):
    stats_fixture(root)
    out = run(root, 'stats').stdout
    assert 'Briefs made: 4 · tokens injected: 1,000' in out
    assert 'with a helped post: 2 (66.7% of answered)' in out
    assert 'wasted tokens: 200' in out and 'Unanswered: 1 · their tokens: 400' in out


def test_backfill_areas(root, tmp_path):
    (root / 'notes' / 'class-page.md').write_text(NOTE)
    (root / 'notes' / 'vault.md').write_text(NOTE)
    planning = tmp_path / 'planning'
    (planning / '42-calendar-adds').mkdir(parents=True)
    (planning / '42-calendar-adds' / 'plan.md').write_text('Touches mail-sync twice: mail-sync. Also class-page.')
    (planning / '77-other').mkdir()
    (planning / '77-other' / 'plan.md').write_text('no slugs here')
    direct = post(root, body='fixed the class-page header')
    one_word = post(root, body='see notes/vault.md')
    bare_word = post(root, body='the vault is fine')
    by_plan = post(root, topic='p42 S2 done', body='done')
    by_plan_word = post(root, topic='status', body='Plan 42 S1 ok')
    no_slug_plan = post(root, topic='plan77', body='x')
    keep = post(root, body='class-page', area='mail-sync')
    assert js(root, 'backfill-areas', '--planning', planning) == {'backfilled': 4}
    with db(root) as con:
        areas = dict(con.execute('SELECT id, area FROM posts').fetchall())
    assert areas[direct] == 'class-page' and areas[one_word] == 'vault' and areas[bare_word] is None
    assert areas[by_plan] == areas[by_plan_word] == 'mail-sync'
    assert areas[no_slug_plan] is None and areas[keep] == 'mail-sync'
    assert js(root, 'backfill-areas', '--planning', planning) == {'backfilled': 0}


def in_process_brief(root, area, files=None, max_tokens=200, agent='j'):
    import argparse
    sys.path.insert(0, str(BOARD.parent))
    import board
    args = argparse.Namespace(root=root, agent=agent, area=area, files=files, max_tokens=max_tokens)
    with board.connect(root) as con:
        text = board.brief(con, args)
        row = dict(con.execute('SELECT * FROM briefs ORDER BY id DESC LIMIT 1').fetchone())
    return text, row


def test_brief_cap_boundary_sweep(root):
    # The review's 801-of-800 case: one note plus one post whose size lands right at the edge.
    for size in range(100, 400, 7):
        board_root = root / f'b{size}'
        (board_root / 'notes').mkdir(parents=True)
        (board_root / 'notes' / 'mail-sync.md').write_text(NOTE.replace('Gotcha: promo gate.', 'g' * 900))
        post(board_root, body='y' * size, area='mail-sync')
        for cap in (200, 201, 230):
            text, row = in_process_brief(board_root, 'mail-sync', max_tokens=cap)
            assert len(text) <= cap * 4, (size, cap, len(text))
            assert row['chars'] == len(text) and row['est_tokens'] == math.ceil(len(text) / 4)


def test_brief_cap_with_several_unknown_areas(root):
    post(root, body='z' * 300, area='mail-sync')
    areas = 'mail-sync,' + ','.join(f'unknown-area-{i}' for i in range(6))
    text, row = in_process_brief(root, areas, files='src/a/very/long/path/name.py,src/b/other.ts', max_tokens=200)
    assert len(text) <= 800 and row['chars'] == len(text)
    assert text.count('no note for area') <= 1  # unknown areas share one line
    assert 'Brief #' in text and 'fb add' in text
    full, _ = in_process_brief(root, areas, max_tokens=1500)
    assert 'no note for area unknown-area-0, unknown-area-1' in full and 'Note mail-sync:' in full


def test_brief_folds_nested_replies(root):
    top = post(root, body='root question', area='mail-sync')
    mid = post(root, body='middle reply', reply_to=top)
    deep = post(root, body='grandchild decisive fix', reply_to=mid)
    out = run(root, 'brief', '--agent', 'j', '--area', 'mail-sync').stdout
    assert f'↳ #{mid} a: middle reply; #{deep} a: grandchild decisive fix' in out
    other = post(root, body='unrelated root', area='class-page')
    reply = post(root, body='no file here', reply_to=other)
    post(root, body='the fix is in src/watches.py', reply_to=reply)
    out = run(root, 'brief', '--agent', 'j', '--area', 'texting-guest-voice', '--files', 'src/watches.py').stdout
    assert f'- #{other} [class-page]' in out and 'the fix is in src/watches.py' in out
    assert f'- #{top} ' not in out


def test_brief_basename_on_path_boundary(root):
    hits = [post(root, body=b) for b in ('see `watches.py` now', 'in src/backend/watches.py:12', 'watches.py, then')]
    misses = [post(root, body=b) for b in ('overwatches.py.bak', 'watches.py.bak only', 'my_watches.py')]
    out = run(root, 'brief', '--agent', 'j', '--area', 'class-page', '--files', 'src/watches.py').stdout
    assert all(f'- #{i} ' in out for i in hits)
    assert not any(f'- #{i} ' in out for i in misses)


def test_brief_ranks_findings_above_status_reports(root):
    finding = post(root, topic='promo gate race', body='the fast pass drops promo mail when ' + 'q' * 300, area='mail-sync')
    done = post(root, topic='S1 round 2 DONE', body='implementation complete ' + 'd' * 300, area='mail-sync')
    wait = post(root, topic='p42 S1 wide suite wait', body='queued behind the heavy lock', area='mail-sync')
    verdict = post(root, topic='S2 packet', body='Item x\nVERDICT: DONE', area='mail-sync')
    newest = post(root, topic='plan 1 starting: owns broker.py', body='owning it now', area='mail-sync')
    out = run(root, 'brief', '--agent', 'j', '--area', 'mail-sync').stdout
    order = [int(x) for x in brief_row(root, brief_id(out))['post_ids'].split(',')]
    assert order[0] == finding and set(order[1:]) == {done, wait, verdict, newest}
    assert order[1:] == sorted(order[1:], reverse=True)  # status reports newest first among themselves
    assert 'd' * 120 not in out and 'q' * 300 in out  # status lines shortened, findings not
    # A helped mark still outranks everything, and a helped status post shows in full.
    js(root, 'helped', '--agent', 'j', '--posts', done)
    out = run(root, 'brief', '--agent', 'j', '--area', 'mail-sync').stdout
    assert brief_row(root, brief_id(out))['post_ids'].split(',')[:2] == [str(done), str(finding)]
    assert 'd' * 300 in out


def test_backfill_skips_tied_plans_and_reads_sender_plan(root, tmp_path):
    (root / 'notes' / 'calendar-sync.md').write_text(NOTE)
    planning = tmp_path / 'planning'
    for name, text in (('31-tied', 'mail-sync and calendar-sync, mail-sync and calendar-sync'),
                       ('45-nightly', 'calendar-sync once')):
        (planning / name).mkdir(parents=True)
        (planning / name / 'plan.md').write_text(text)
    tied = post(root, topic='Re: tests', body='p31 s3: update the kinds assertion')
    by_sender = post(root, topic='p31 case overlaps', body='heads-up', agent='plan45-8b461874')
    assert js(root, 'backfill-areas', '--planning', planning) == {'backfilled': 1}
    with db(root) as con:
        areas = dict(con.execute('SELECT id, area FROM posts').fetchall())
    assert areas[tied] is None and areas[by_sender] == 'calendar-sync'
