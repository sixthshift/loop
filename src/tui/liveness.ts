// Measured liveness for a streaming agent's tool work. Transcript silence is
// a false hang signal — a long e2e run is silent by design (see the
// stall-watchdog landmine from campaign 20) — so this samples the one thing
// that can't lie: CPU consumed by the agent's whole process subtree, read
// from /proc. Display-only: the verdict on a stuck worker stays with the
// operator.
//
// Non-Linux hosts have no /proc; liveness() returns an empty map and the
// dashboard shows nothing rather than guessing.

import fs from 'node:fs';

export type Liveness = { idleForMs: number };

const SWEEP_MS = 3000;
const linux = fs.existsSync('/proc/self/stat');

let lastSweepAt = 0;
const subtreeJiffies = new Map<number, number>(); // pid -> last summed subtree jiffies
const lastActiveAt = new Map<number, number>();   // pid -> ts of last observed cpu movement

// pids -> Map(pid -> { idleForMs }). Throttled: at most one /proc sweep per
// SWEEP_MS regardless of render cadence.
export function liveness(pids: number[]): Map<number, Liveness> {
  const out = new Map<number, Liveness>();
  if (!linux || !pids.length) return out;
  const now = Date.now();
  if (now - lastSweepAt >= SWEEP_MS) { sweep(pids, now); lastSweepAt = now; }
  for (const pid of pids) {
    const at = lastActiveAt.get(pid);
    if (at !== undefined) out.set(pid, { idleForMs: now - at });
  }
  return out;
}

function sweep(pids: number[], now: number): void {
  const byParent = new Map<number, number[]>(); // ppid -> child pids
  const own = new Map<number, number>();        // pid -> own utime+stime
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try { stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8'); } catch { continue; } // raced an exit
    const m = stat.match(/^\d+ \(.*\) (.+)$/s); // comm is parenthesized and may contain spaces
    if (!m) continue;
    const f = m[1]!.split(' '); // f[1]=ppid, f[11]=utime, f[12]=stime
    const pid = Number(entry), ppid = Number(f[1]);
    own.set(pid, Number(f[11]) + Number(f[12]));
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid)!.push(pid);
  }

  const keep = new Set(pids);
  for (const k of subtreeJiffies.keys()) if (!keep.has(k)) subtreeJiffies.delete(k);
  for (const k of lastActiveAt.keys()) if (!keep.has(k)) lastActiveAt.delete(k);

  for (const pid of pids) {
    if (!own.has(pid)) continue; // process gone — the agent layer notices, not us
    let total = 0;
    const stack = [pid];
    while (stack.length) {
      const p = stack.pop()!;
      total += own.get(p) ?? 0;
      for (const c of byParent.get(p) ?? []) stack.push(c);
    }
    const prev = subtreeJiffies.get(pid);
    subtreeJiffies.set(pid, total);
    // First sight counts as active (benefit of the doubt); afterwards any
    // movement counts — including a child arriving or leaving, since a
    // subtree that changes shape is a subtree doing something.
    if (prev === undefined || total !== prev) lastActiveAt.set(pid, now);
  }
}
