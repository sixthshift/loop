// Bridge between the coordinator and its display. The files are the loop's
// memory, so the dashboard reads backlog.json and journal.jsonl itself; this
// module holds only what files can't show — agents currently alive (with a
// live transcript ring each), the running spend tally, the status line —
// and fans mutations out to whichever display is attached.
//
// TTY → interactive Ink dashboard (dashboard.tsx) on the alternate screen.
// Non-TTY (piped, CI, container logs) → plain timestamped lines.

const tty = process.stdout.isTTY;

export const store = {
  agents: new Map(), // label -> { model, startedAt, transcript: [{ts, line}] }
  spend: { costUsd: 0, tokens: 0, calls: 0 },
  statusLine: '',
  startedAt: null,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => { for (const fn of listeners) fn(); };

let app = null;

export function start() {
  if (store.startedAt) return;
  store.startedAt = Date.now();
  process.on('SIGTERM', () => { stop(); process.exit(130); });
  if (!tty) return;
  process.stdout.write('\x1b[?1049h'); // alt screen; ink manages the cursor
  // Dynamic so the non-TTY path never loads ink at all. The stopped-already
  // guard covers fast exits (usage errors, refused resume) that race the import.
  import('./dashboard.tsx').then(m => { if (store.startedAt) app = m.mount(); }).catch(e => {
    process.stdout.write('\x1b[?1049l');
    console.error(`dashboard failed to mount, continuing headless: ${e.message}`);
  });
}

export function stop() {
  if (app) { app.unmount(); app = null; }
  if (tty && store.startedAt) process.stdout.write('\x1b[?1049l\x1b[?25h');
  store.startedAt = null;
}

export function log(msg) {
  store.statusLine = msg;
  if (!tty) console.log(`${hhmm(Date.now())} ${msg}`);
  else emit();
}

export function agentStart(label, model) {
  store.agents.set(label, { model, startedAt: Date.now(), transcript: [] });
  if (!tty) console.log(`${hhmm(Date.now())} ⚙ ${label} (${model}) started`);
  else emit();
}

// The spawned child's pid — the anchor for the dashboard's measured-CPU
// liveness column (liveness.mjs walks the subtree under it).
export function agentPid(label, pid) {
  const a = store.agents.get(label);
  if (a) a.pid = pid;
}

export function agentEnd(label, { tokens = 0, costUsd = 0 } = {}) {
  store.agents.delete(label);
  store.spend.tokens += tokens;
  store.spend.costUsd += costUsd;
  store.spend.calls += 1;
  if (!tty) console.log(`${hhmm(Date.now())} ⚙ ${label} finished (${tokens} tok, $${costUsd.toFixed(2)})`);
  else emit();
}

// Live transcript line from a streaming agent. Ring-buffered per agent and
// dropped with it at agentEnd — this is a window, not a record (the journal
// is the record). Non-TTY drops them: tool-by-tool noise would bury the
// event log that CI actually wants. A completed message supersedes whatever
// was mid-stream, so the live buffer clears here.
export function agentEvent(label, line) {
  const a = store.agents.get(label);
  if (!a) return;
  a.live = null;
  a.transcript.push({ ts: Date.now(), line });
  if (a.transcript.length > 300) a.transcript.splice(0, a.transcript.length - 300);
  if (tty) emit();
}

// Token-level deltas from the model, straight off the API stream. Held as
// one growing tail (capped), not transcript lines — this is the "watch it
// type" window; the finished message lands via agentEvent. Emits are
// throttled: deltas arrive many times a second and the display needs ~7fps,
// not one render per token.
let deltaTimer = null;

export function agentDelta(label, chunk, thinking) {
  const a = store.agents.get(label);
  if (!a || !chunk) return;
  if (!a.live || a.live.thinking !== thinking) a.live = { text: '', thinking };
  a.live.text += chunk;
  if (a.live.text.length > 2000) a.live.text = a.live.text.slice(-2000);
  if (tty && !deltaTimer) deltaTimer = setTimeout(() => { deltaTimer = null; emit(); }, 150);
}

export const hhmm = ts => new Date(ts).toTimeString().slice(0, 8);
export const dur = ms => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
