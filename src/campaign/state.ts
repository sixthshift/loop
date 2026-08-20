// Campaign-level runtime infrastructure: shell execution, sync and async, plus
// the Frontier type the derived facts are returned as. The paths themselves are
// in paths.ts — a leaf, because this module depends on live.ts and live.ts needs
// a path, which is a cycle if the constants live here.
// Durable campaign decisions live in backlog.json; journal.jsonl is the audit
// trail around them.
//
// This file used to also hold a repository-scoped coordinator lock. It is gone
// rather than merely unused: the seat is a model in a conversation, which cannot
// hold a pidfile across separate verb invocations, so no verb ever took it (see
// mechanics.ts). Exclusivity while recover runs is now the coordinator's to keep
// — stated as invariant 3 in the skill, and unenforced here, which is a scar
// worth reading as one rather than a lock that looks like coverage.

import { spawnSync, spawn } from 'node:child_process';
import { liveStart, livePid, liveData, liveEnd } from './live.ts';

export type ShResult = { status: number | null; stdout: string; stderr: string };

// The frontier gate's verdict — the derived facts the drive branches on,
// computed natively in frontier.ts. The type is the whole contract.
export type Frontier = {
  problems: { ticket: string; issue: string }[];
  cycles: string[][];
  ready: string[];
  waiting: string[]; // open, but a dependency is still open — derived, never stored
  dispatchable: string[];
  capped: { ticket: string; attempts: number }[];
  stuck: { ticket: string; window: number }[];
  inFlight: string[];
  complete: boolean;
  // `complete` says ticket work has drained; this says the slow suite's verdict
  // still describes the tree as it stands. Two facts, deliberately separate — a
  // campaign can be complete with a stale gate, which is exactly the state that
  // must not be reported as done. Green only covers the snapshot it measured, so
  // this is a comparison of the run's ticket and closed counts against the
  // current ones, and it is here rather than in the coordinator's head because a
  // remembered green is the easiest thing in the loop to carry past new work.
  gateGreen: boolean;
  counts: Record<string, number>;
  // Spec coverage as arithmetic rather than a terminal judgement: which
  // enumerated requirements no ticket claims, and which are delivered by
  // tickets that all closed. Advisory — it never gates dispatch — but it is the
  // only reading of "how much of the spec is actually done" available while the
  // campaign is still running.
  coverage: { requirements: number; unmapped: string[]; proven: string[] };
  // The milestone that has been reached and not yet swept, or null. Reaching one
  // — every clause it delivers now proven — is the campaign's reflective pass
  // falling due, because it is a moment the product actually had. There is no
  // count-based fallback: a spec declares its checkpoints or the campaign
  // reflects only at termination, and an interval that knows nothing about the
  // product is not worth the read it costs.
  sweepDue: string | null;
};

export function sh(cmd: string, cwd = '.'): ShResult {
  return spawnSync('bash', ['-lc', cmd], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// For measurements that run minutes (verify, gates): keeps the event loop —
// and therefore the live display — breathing while a test suite grinds.
// The hour cap is a hang backstop, not a budget, and it is the ONLY bound on a
// check — nothing above it caps an individual command, so a suite that wedges
// burns an hour before the group is killed. The child is a process group and the
// kill targets the whole group: a leaked grandchild (a test suite's dev server)
// holding the stdio pipes would otherwise keep `close` from ever firing.
// `label` opts a run into the live window (live.ts): the run publishes itself to
// `.ailoop/campaign/live/` so a dashboard in another process can watch it, since
// the coordinator driving this verb never sees the stream. Unlabeled runs stay
// silent — internal git and probe calls are not what anyone is watching for.
// The status a run carries when the backstop killed it, rather than the command
// choosing an exit code. Exported because a killed check and a failing one are
// different findings — one is a hang nobody has noticed, the other is the check
// doing its job — and only the runner can tell them apart.
export const SH_TIMEOUT = 124;

export function shAsync(cmd: string, cwd = '.', opts: { label?: string; ticketId?: string } = {}): Promise<ShResult> {
  const { label, ticketId } = opts;
  const timeoutMs = 60 * 60 * 1000;
  return new Promise(resolve => {
    const child = spawn('bash', ['-lc', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (label) { liveStart(label, cmd, ticketId); livePid(label, child.pid); }
    let stdout = '', stderr = '', settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (label) liveEnd(label);
      resolve({ status, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      stderr += `\nshAsync: killed after ${Math.round(timeoutMs / 60000)}m (hang backstop)`;
      finish(SH_TIMEOUT);
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; if (label) liveData(label, String(d)); });
    child.stderr.on('data', d => { stderr += d; if (label) liveData(label, String(d)); });
    child.on('close', status => finish(status));
    child.on('error', e => { stderr += String(e); finish(127); });
  });
}
