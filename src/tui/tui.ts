// Bridge between the coordinator and its display. The files are the loop's
// memory, so the dashboard reads backlog.json and journal.jsonl itself; this
// module holds only what files can't show — the live scripts (each with an
// output ring), the status line, the campaign clock — and fans mutations out
// to whichever display is attached. Live agents and their spend are the fleet's
// (agent/fleet.ts); the dashboard reads that map directly.
//
// TTY → interactive Ink dashboard (dashboard.tsx) on the alternate screen.
// Non-TTY (piped, CI, container logs) → plain timestamped lines.

const tty = process.stdout.isTTY;

// A script (verify, flake probe, phase gate, fast check) run through shAsync
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

export const store: {
  scripts: Map<string, ScriptView>;
  statusLine: string;
  startedAt: number | null;
} = {
  scripts: new Map(),
  statusLine: '',
  startedAt: null,
};

const listeners = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => { for (const fn of listeners) fn(); };

let app: { unmount(): void } | null = null;

export function start(): void {
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

export function stop(): void {
  if (app) { app.unmount(); app = null; }
  if (tty && store.startedAt) process.stdout.write('\x1b[?1049l\x1b[?25h');
  store.startedAt = null;
}

export function log(msg: string): void {
  store.statusLine = msg;
  if (!tty) console.log(`${hhmm(Date.now())} ${msg}`);
  else emit();
}

// --- scripts: the same live-tail treatment for shAsync-run processes --------

export function scriptStart(label: string, cmd: string, ticketId?: string): void {
  store.scripts.set(label, { cmd, startedAt: Date.now(), output: [], partial: '', ticketId });
  if (!tty) console.log(`${hhmm(Date.now())} $ ${label} started: ${cmd.slice(0, 100)}`);
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
  if (tty && !scriptTimer) scriptTimer = setTimeout(() => { scriptTimer = null; emit(); }, 150);
}

export function scriptEnd(label: string, status: number | null): void {
  store.scripts.delete(label);
  if (!tty) console.log(`${hhmm(Date.now())} $ ${label} exit ${status}`);
  else emit();
}

export const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
export const dur = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
