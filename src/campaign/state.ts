// Campaign-level runtime infrastructure: shell execution, the repository-scoped
// coordinator lock, learnings, and spec hashing. The paths themselves are in
// paths.ts — a leaf, because this module depends on live.ts and live.ts needs a
// path, which is a cycle if the constants live here.
// Durable campaign decisions live in backlog.json; journal.jsonl is the audit
// trail around them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { LEARNINGS } from './paths.ts';
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
};


// The identity a campaign runs under, established at kickoff and re-checked
// (by spec sha) on every resume.
export type CampaignContext = { specPath: string; spec: string };

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
      finish(124);
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; if (label) liveData(label, String(d)); });
    child.stderr.on('data', d => { stderr += d; if (label) liveData(label, String(d)); });
    child.on('close', status => finish(status));
    child.on('error', e => { stderr += String(e); finish(127); });
  });
}


// The lock belongs to the target repository, not to campaign state: it must
// exist before kickoff creates backlog.json, and a refused kickoff must still
// leave no campaign residue. `wx` is the exclusion primitive — checking then
// writing is a race in which two coordinators can both pass the check.
const lockFile = (): string => {
  const common = sh('git rev-parse --git-common-dir');
  if (common.status !== 0) throw new Error('loop must run from a git repository');
  return path.join(path.resolve(common.stdout.trim()), 'ailoop', 'coordinator.pid');
};

export class LockHeldError extends Error {
  pid: number | null;
  constructor(pid: number | null) {
    super(pid
      ? `another coordinator (pid ${pid}) is already driving this repository`
      : 'another coordinator is already driving this repository');
    this.pid = pid;
  }
}

let heldLock: string | null = null;

export function acquireLock(): void {
  const file = lockFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      heldLock = file;
      process.once('exit', releaseLock);
      return;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      const pid = readLockPid(file);
      if (pid === process.pid) { heldLock = file; return; }
      if (pid !== null && processAlive(pid)) throw new LockHeldError(pid);
      // A dead owner left the pidfile behind. Remove it, then retry the
      // exclusive create; that retry decides ownership if another coordinator
      // reached the same point.
      try { fs.unlinkSync(file); } catch (unlink: any) {
        if (unlink.code !== 'ENOENT') throw unlink;
      }
    }
  }
  throw new LockHeldError(readLockPid(file));
}

export function releaseLock(): void {
  const file = heldLock;
  heldLock = null;
  if (!file) return;
  try {
    if (readLockPid(file) === process.pid) fs.unlinkSync(file);
  } catch { /* already released */ }
}

const readLockPid = (file: string): number | null => {
  try {
    const pid = parseInt(fs.readFileSync(file, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error: any) {
    // EPERM still proves the process exists; a shared repository must not let
    // one user reclaim another user's live coordinator.
    return error.code === 'EPERM';
  }
};

export function specSha(specPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(specPath)).digest('hex');
}

export function readLearnings(): Record<string, string> | null {
  if (!fs.existsSync(LEARNINGS)) return null;
  const facets: Record<string, string> = {};
  for (const f of fs.readdirSync(LEARNINGS)) {
    facets[f] = fs.readFileSync(path.join(LEARNINGS, f), 'utf8');
  }
  return Object.keys(facets).length ? facets : null;
}
