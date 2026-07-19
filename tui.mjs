// Realtime campaign display. The files are the loop's memory, so the
// renderer mostly polls them — backlog.json for structure, journal.jsonl as
// the event feed. The only in-memory extra is what files can't show: agents
// currently alive and the running spend tally.
//
// TTY → alternate-screen dashboard redrawn each second.
// Non-TTY (piped, CI, container logs) → plain timestamped lines.

import { backlog, journalTail, campaignExists } from './run.mjs';

const tty = process.stdout.isTTY;
const agents = new Map(); // label -> { model, startedAt }
const spend = { costUsd: 0, tokens: 0, calls: 0 };
let statusLine = '';
let startedAt = null;
let timer = null;

export function start() {
  if (startedAt) return;
  startedAt = Date.now();
  if (!tty) return;
  process.stdout.write('\x1b[?1049h\x1b[?25l'); // alt screen, hide cursor
  timer = setInterval(render, 1000);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(130); });
  render();
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (tty && startedAt) process.stdout.write('\x1b[?1049l\x1b[?25h');
  startedAt = null;
}

export function log(msg) {
  statusLine = msg;
  if (!tty || !timer) console.log(`${hhmm(Date.now())} ${msg}`);
  else render();
}

export function agentStart(label, model) {
  agents.set(label, { model, startedAt: Date.now() });
  if (!tty || !timer) console.log(`${hhmm(Date.now())} ⚙ ${label} (${model}) started`);
  else render();
}

export function agentEnd(label, { tokens = 0, costUsd = 0 } = {}) {
  agents.delete(label);
  spend.tokens += tokens;
  spend.costUsd += costUsd;
  spend.calls += 1;
  if (!tty || !timer) console.log(`${hhmm(Date.now())} ⚙ ${label} finished (${tokens} tok, $${costUsd.toFixed(2)})`);
  else render();
}

// --- rendering ---------------------------------------------------------------

const KIND_ICON = {
  close: '✓', attempt: '✗', status: '⇢', add: '+', vet: '✔', decompose: '⑂',
  triage: '▲', 'triage-refused': '▲', review: '◎', 'phase-close': '■',
  'gate-red': '‼', escalation: '‼', 'accepted-risk': '⚑', 'flake-probe': '≈',
  'integration-red': '‼', verify: '·', intake: '◈', seed: '◈', init: '◈',
};

function render() {
  const w = Math.max(60, process.stdout.columns || 100);
  const lines = [];
  const rule = '─'.repeat(w);

  const title = ` loop campaign — ${safe(() => backlog().project) ?? '(intake)'}`;
  const clock = `elapsed ${dur(Date.now() - startedAt)} `;
  lines.push('\x1b[1m' + title + ' '.repeat(Math.max(1, w - title.length - clock.length)) + clock + '\x1b[0m');
  lines.push(rule);

  if (campaignExists()) {
    const b = backlog();
    const closes = new Set(journalTail(5000).filter(j => j.kind === 'phase-close').map(j => j.subject));
    for (const p of b.phases) {
      const ts = b.tickets.filter(t => t.phase === p.id && t.status !== 'decomposed');
      const done = ts.filter(t => t.status === 'closed').length;
      const gate = closes.has(p.id) ? '\x1b[32m[gate ✓]\x1b[0m' : ts.length && done === ts.length ? '\x1b[33m[gate …]\x1b[0m' : '';
      lines.push(` ${p.id.padEnd(4)} ${bar(done, ts.length, 24)} ${String(done).padStart(2)}/${ts.length}  ${gate}  ${trunc(p.delivers, w - 45)}`);
    }
    lines.push(rule);
    const counts = b.tickets.reduce((m, t) => ((m[t.status] = (m[t.status] || 0) + 1), m), {});
    const attempts = b.tickets.reduce((n, t) => n + (t.attempts?.length ?? 0), 0);
    lines.push(' ' + ['draft', 'vetted', 'in-flight', 'closed', 'blocked', 'failed-wall']
      .filter(s => counts[s]).map(s => `${counts[s]} ${s}`).join(' · ')
      + `   attempts ${attempts}   spend $${spend.costUsd.toFixed(2)} / ${Math.round(spend.tokens / 1000)}k tok / ${spend.calls} agents`);
    lines.push(rule);
  }

  lines.push(agents.size ? ' agents' : ' agents  (none live)');
  for (const [label, a] of agents) {
    lines.push(`  ⚙ ${label.padEnd(24)} ${a.model.padEnd(7)} ${dur(Date.now() - a.startedAt)}`);
  }
  lines.push(rule);

  if (statusLine) lines.push(' ' + '\x1b[36m' + trunc(statusLine, w - 2) + '\x1b[0m');
  const feedRows = Math.max(3, (process.stdout.rows || 30) - lines.length - 2);
  for (const j of journalTail(feedRows)) {
    const icon = KIND_ICON[j.kind] ?? '·';
    lines.push(trunc(`  ${hhmm(Date.parse(j.ts))} ${icon} ${j.subject.padEnd(8)} ${j.body}`, w - 1));
  }

  process.stdout.write('\x1b[H\x1b[J' + lines.join('\n') + '\n');
}

const safe = fn => { try { return fn(); } catch { return undefined; } };
const hhmm = ts => new Date(ts).toTimeString().slice(0, 8);
const trunc = (s, n) => (s = String(s).replace(/\s+/g, ' '), s.length > n ? s.slice(0, n - 1) + '…' : s);
const bar = (done, total, width) => {
  const filled = total ? Math.round((done / total) * width) : 0;
  return '\x1b[32m' + '█'.repeat(filled) + '\x1b[2m' + '░'.repeat(width - filled) + '\x1b[0m';
};
const dur = ms => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
