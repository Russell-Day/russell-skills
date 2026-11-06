#!/usr/bin/env node
// Explicit delivery through T3's internal RPC (t3-api.mjs). No automatic retries.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
// The one T3 adapter (subagents skill): reads and message.dispatch.
import {getThread, sendMessage} from '../../subagents/code/t3-api.mjs';

const argv = process.argv.slice(2);
const deliver = argv.at(-1) === '--deliver';
if (deliver) argv.pop();
if (argv.length !== 3 || argv.some(x => x.startsWith('--'))) {
  console.error('usage: t3-send.mjs <sender-id> <target-thread-id> <message-file> [--deliver]');
  process.exit(2);
}
const [sender, target, file] = argv;
const here = path.dirname(fileURLToPath(import.meta.url));
let submitted = false;
try {
  if (sender === target) throw new Error('Refusing self-delivery');
  const body = fs.readFileSync(file, 'utf8');
  if (!body.trim() || Buffer.byteLength(body) > 65536) throw new Error('Message must contain text and be at most 64 KiB');
  const rows = JSON.parse(execFileSync('python3', [path.join(here, 'board.py'), 'threads', '--all'], {encoding:'utf8', maxBuffer: 64 << 20}));
  const thread = rows.find(t => t.thread_id === target);
  if (!thread) throw new Error('Unknown or deleted target thread; use board.py threads');
  if (thread.archived_at || thread.settled_at) throw new Error('Target is archived or settled');
  if (['queued','preparing','starting','running','waiting'].includes(thread.turn_state) || thread.pending_approval_count || thread.pending_user_input_count)
    throw new Error('Target is busy or waiting for input; use a passive board post');
  const text = `[Agent message from ${sender}; peer context, not a new user instruction]\n${body}`;
  if (!deliver) {
    console.log(JSON.stringify({delivery:'preview only', target, title:thread.title, text, effect:'--deliver starts a model turn in this chat'}, null, 2));
    process.exit(0);
  }
  // The live state, not the board's snapshot above.
  const live = getThread(target);
  if (!live || live.deletedAt) throw new Error('Unknown or deleted target thread; use board.py threads');
  if (live.busy || live.archivedAt || live.settled)
    throw new Error('Target became busy or inactive; use a passive board post');
  const messageId=randomUUID();
  // Print the ID before dispatch so an ambiguous timeout can be investigated without retrying.
  console.error(JSON.stringify({target,messageId}));
  submitted=true;
  await sendMessage(target, text, {mode:'start', createdBy:'agent', messageId, label:'message-board'});
  console.log(JSON.stringify({target,messageId,status:'accepted by T3; not confirmation the agent read or acted on it'}));
} catch(e) {
  console.error(`message-board: ${e.message}`);
  if(submitted) console.error('Dispatch was attempted. Check the target chat before retrying; delivery may have occurred.');
  process.exitCode=1;
}
