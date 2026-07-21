// Campaign-level state that is neither the backlog nor the journal: the
// .ailoop paths, shell execution, and the derived or out-of-band state the
// coordinator reads — the frontier, verification verdicts, the single-
// coordinator lock, learnings, and the spec hash. backlog.ts and journal.ts
// build on the paths and shell helpers defined here.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import * as tui from '../tui/tui.ts';

export type ShResult = { status: number | null; stdout: string; stderr: string };

// The frontier gate's verdict — the derived facts the drive branches on,
// computed natively in frontier.ts. The type is the whole contract.
export type Frontier = {
  problems: { ticket: string; issue: string }[];
  cycles: string[][];
  ready: string[];
  dispatchable: string[];
  capped: { ticket: string; attempts: number }[];
  stuck: { ticket: string; window: number }[];
  inFlight: string[];
  complete: boolean;
  counts: Record<string, number>;
};


// The identity a campaign runs under, established at intake and re-checked
// (by spec sha) on every resume.
export type CampaignContext = { specPath: string; spec: string };

export const RUN = '.ailoop/campaign';
export const LEARNINGS = '.ailoop/learnings';
export const WORKTREES = '.ailoop/worktrees';
export function sh(cmd: string, cwd = '.'): ShResult {
  return spawnSync('bash', ['-lc', cmd], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// For measurements that run minutes (verify, gates): keeps the event loop —
// and therefore the live display — breathing while a test suite grinds.
// The hour cap is a hang backstop, not a budget — verify.mjs already caps
// each check at 30m. The child is a process group and the kill targets the
// whole group: a leaked grandchild (a test suite's dev server) holding the
// stdio pipes would otherwise keep `close` from ever firing.
// `label` opts a run into the live display: its output streams to the TUI as a
// script the operator can inspect in real time (same seam agent.ts uses for
// agents). Unlabeled runs stay silent — internal git/probe calls don't belong
// on the dashboard.
export function shAsync(cmd: string, cwd = '.', opts: { label?: string; ticketId?: string } = {}): Promise<ShResult> {
  const { label, ticketId } = opts;
  const timeoutMs = 60 * 60 * 1000;
  return new Promise(resolve => {
    const child = spawn('bash', ['-lc', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (label) { tui.scriptStart(label, cmd, ticketId); tui.scriptPid(label, child.pid); }
    let stdout = '', stderr = '', settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (label) tui.scriptEnd(label, status);
      resolve({ status, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      stderr += `\nshAsync: killed after ${Math.round(timeoutMs / 60000)}m (hang backstop)`;
      finish(124);
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; if (label) tui.scriptData(label, String(d)); });
    child.stderr.on('data', d => { stderr += d; if (label) tui.scriptData(label, String(d)); });
    child.on('close', status => finish(status));
    child.on('error', e => { stderr += String(e); finish(127); });
  });
}


// Single-coordinator lock. backlog-write.mjs validates transitions but has
// no lock — two coordinators interleaving writes on one campaign is silent
// corruption, so the second one must refuse to start.
const PIDFILE = () => path.join(RUN, 'coordinator.pid');

export function lockHolder(): number | null {
  if (!fs.existsSync(PIDFILE())) return null;
  const pid = parseInt(fs.readFileSync(PIDFILE(), 'utf8'), 10);
  if (!pid || pid === process.pid) return null;
  try { process.kill(pid, 0); return pid; }   // alive → held
  catch { return null; }                       // stale → claimable
}

export function acquireLock(): void {
  fs.writeFileSync(PIDFILE(), String(process.pid));
  process.on('exit', () => {
    try {
      if (parseInt(fs.readFileSync(PIDFILE(), 'utf8'), 10) === process.pid) fs.unlinkSync(PIDFILE());
    } catch { /* campaign/ already deleted at campaign close */ }
  });
}

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
