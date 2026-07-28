// Runtime reporting shared by the coordinator and its display. The files are the loop's
// memory, so the dashboard reads backlog.json and journal.jsonl itself; this
// module holds only what files can't show — the live scripts (each with an
// output ring), the status line, the campaign clock — and fans mutations out
// to whichever display is attached. Live agents and their spend are the fleet's
// (agent/fleet.ts); the dashboard reads that map directly.
//
// TTY mounting belongs to tui/app.ts, the composition boundary that is allowed
// to know about the campaign-aware dashboard. This module stays a leaf:
// non-TTY output plus in-memory live facts and subscriptions.

export const interactive = Boolean(process.stdout.isTTY);

// A script (verify, flake probe, campaign gate, fast check) run through shAsync
// with a label. Same shape a reader wants as an agent — a live output tail and
// a pid for the liveness cell — minus the model/token machinery.
export type ScriptView = {
  cmd: string;
  startedAt: number;
  output: { ts: number; line: string }[];
  partial: string; // trailing chunk not yet newline-terminated (progress bars, prompts)
  pid?: number;
  ticketId?: string;
};

// The coordinator's narration, ring-buffered like a script's output rather than
// held one line at a time. A single `statusLine` meant the newest message erased
// the one before it, so the dashboard could show what the loop is doing and never
// what it just did — and a message longer than the terminal was unreadable in the
// only place it appeared. The journal is the durable record; this is the running
// commentary between its entries, and it has to survive long enough to be read.
const LOG_KEEP = 200;

export const store: {
  scripts: Map<string, ScriptView>;
  logs: { ts: number; line: string }[];
  startedAt: number | null;
  requestedView: 'requirements' | null;
} = {
  scripts: new Map(),
  logs: [],
  startedAt: null,
  requestedView: null,
};

const listeners = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => { for (const fn of listeners) fn(); };

export function beginReporting(): void {
  if (store.startedAt) return;
  store.startedAt = Date.now();
}

export function endReporting(): void {
  store.startedAt = null;
}

export function log(msg: string): void {
  store.logs.push({ ts: Date.now(), line: msg });
  if (store.logs.length > LOG_KEEP) store.logs.splice(0, store.logs.length - LOG_KEEP);
  if (!interactive) console.log(`${hhmm(Date.now())} ${msg}`);
  else emit();
}

// Kickoff's requirement enumeration is a load-bearing contract, not a journal
// detail. TTY campaigns open its dedicated view; headless campaigns print the
// same complete list into ordinary output.
export function showRequirements(requirements: { id: string; clause: string }[]): void {
  if (!interactive) {
    console.log(`${hhmm(Date.now())} requirements (${requirements.length}):`);
    for (const requirement of requirements)
      console.log(`  ${requirement.id}: ${requirement.clause}`);
    return;
  }
  store.requestedView = 'requirements';
  emit();
}

export function takeRequestedView(): 'requirements' | null {
  const requested = store.requestedView;
  store.requestedView = null;
  return requested;
}

// --- scripts: the same live-tail treatment for shAsync-run processes --------

export function scriptStart(label: string, cmd: string, ticketId?: string): void {
  store.scripts.set(label, { cmd, startedAt: Date.now(), output: [], partial: '', ticketId });
  if (!interactive) console.log(`${hhmm(Date.now())} $ ${label} started: ${cmd.slice(0, 100)}`);
  else emit();
}

export function scriptPid(label: string, pid: number | undefined): void {
  const s = store.scripts.get(label);
  if (s) s.pid = pid;
}

// Raw stdout/stderr chunk from a running script. Reassembled into lines across
// chunk boundaries (a chunk rarely ends on a newline); the incomplete tail is
// held in `partial` so a mid-line progress bar still shows as the live line.
// Ring-buffered and throttled like agent deltas — a chatty test suite must not
// drive one render per write.
let scriptTimer: ReturnType<typeof setTimeout> | null = null;

export function scriptData(label: string, chunk: string): void {
  const s = store.scripts.get(label);
  if (!s) return;
  const lines = (s.partial + chunk).split('\n');
  s.partial = lines.pop() ?? '';
  for (const l of lines) if (l.length) s.output.push({ ts: Date.now(), line: l });
  if (s.output.length > 500) s.output.splice(0, s.output.length - 500);
  if (interactive && !scriptTimer) scriptTimer = setTimeout(() => { scriptTimer = null; emit(); }, 150);
}

export function scriptEnd(label: string, status: number | null): void {
  store.scripts.delete(label);
  if (!interactive) console.log(`${hhmm(Date.now())} $ ${label} exit ${status}`);
  else emit();
}

export const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
export const dur = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
