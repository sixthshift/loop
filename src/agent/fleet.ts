// The live agents — the set of `claude` subprocesses running right now, the
// window each shows of itself (a transcript ring plus the token stream while
// it generates), the cumulative spend they've rung up, and the one handle that
// can kill one. Everything about a running agent lives here: agent.ts feeds it,
// the dashboard reads it, the operator kills through it.
//
// This is the single owner that used to be three — a display map, a separate
// label→kill registry, and the child handle trapped in a spawn closure — so
// "which agents are live" and "can I kill this one" no longer have to agree
// across maps. Kill is operator intent: the rejection it triggers is marked
// non-transient in agent.ts, so a killed worker is never silently re-run.
//
// tty-aware like the display bridge: an interactive dashboard subscribes and
// repaints; a piped/CI run gets plain lifecycle lines instead.

const tty = process.stdout.isTTY;

export type AgentLive = { text: string; thinking: boolean };
export type LiveAgent = {
  model: string;
  startedAt: number;
  pid?: number;
  transcript: { ts: number; line: string }[];
  live?: AgentLive | null;
  kill: () => void;
};

export const fleet: {
  agents: Map<string, LiveAgent>;
  spend: { costUsd: number; tokens: number; calls: number };
} = {
  agents: new Map(),
  spend: { costUsd: 0, tokens: 0, calls: 0 },
};

const listeners = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => { for (const fn of listeners) fn(); };

export function register(label: string, { model, pid, kill }: { model: string; pid?: number; kill: () => void }): void {
  fleet.agents.set(label, { model, startedAt: Date.now(), pid, transcript: [], kill });
  if (!tty) console.log(`${stamp()} ⚙ ${label} (${model}) started`);
  else emit();
}

// Drop the live entry and tally its spend. Spend is passed only when the agent
// completed cleanly — an error or an operator kill removes it with none, so a
// wall failure never inflates the cost line. Idempotent: 'error' and 'close'
// can both fire for one child, so a second call after the entry is gone is a
// no-op and the call counts exactly once.
export function remove(label: string, spend?: { tokens: number; costUsd: number }): void {
  if (!fleet.agents.delete(label)) return;
  fleet.spend.calls += 1;
  if (spend) { fleet.spend.tokens += spend.tokens; fleet.spend.costUsd += spend.costUsd; }
  if (!tty) console.log(`${stamp()} ⚙ ${label} finished${spend ? ` (${spend.tokens} tok, $${spend.costUsd.toFixed(2)})` : ''}`);
  else emit();
}

// A completed transcript line for the live tail. Ring-buffered and dropped with
// the agent at remove() — this is a window, not a record (the journal is the
// record). Non-TTY drops them: tool-by-tool noise would bury the event log CI
// wants. A finished message supersedes whatever was mid-stream, so live clears.
export function event(label: string, line: string): void {
  const a = fleet.agents.get(label);
  if (!a) return;
  a.live = null;
  a.transcript.push({ ts: Date.now(), line });
  if (a.transcript.length > 300) a.transcript.splice(0, a.transcript.length - 300);
  if (tty) emit();
}

// Token-level deltas straight off the API stream, held as one growing tail
// (capped) — the "watch it type" window; the finished message lands via
// event(). Emits are throttled: deltas arrive many times a second and the
// display needs ~7fps, not one render per token.
let deltaTimer: ReturnType<typeof setTimeout> | null = null;

export function delta(label: string, chunk: string, thinking: boolean): void {
  const a = fleet.agents.get(label);
  if (!a || !chunk) return;
  if (!a.live || a.live.thinking !== thinking) a.live = { text: '', thinking };
  a.live.text += chunk;
  if (a.live.text.length > 2000) a.live.text = a.live.text.slice(-2000);
  if (tty && !deltaTimer) deltaTimer = setTimeout(() => { deltaTimer = null; emit(); }, 150);
}

// Operator kill. Only reaches a live child; a label that has already settled
// returns false so the caller can say so rather than pretend it acted.
export function kill(label: string): boolean {
  const a = fleet.agents.get(label);
  if (a) a.kill();
  return Boolean(a);
}

export function killAll(): void {
  for (const a of fleet.agents.values()) a.kill();
}

const stamp = () => new Date().toTimeString().slice(0, 8);
