// Running the campaign gate — the slow suite, over the whole merged tree, once
// every ticket has drained.
//
// This is the measurement half of a verdict the writer has always been willing
// to take on trust. `backlog gate-run green` records a result; it has never run
// anything, so the one claim that ends a campaign — everything works — was the
// only claim in the loop with no measurement under it. Invariant 5 says nothing
// is done on the coordinator's word, and `verify` exists precisely so a ticket's
// checks are never a recollection. The gate had no equivalent, which left the
// most expensive claim the loop makes as the least evidenced.
//
// Two guards, both mechanical, because both failures are silent:
//
//   • HEAD must be on the recorded mainline. A gate run on a ticket branch is a
//     verdict about the wrong tree and reads exactly like a correct one — a
//     settled campaign leaves HEAD on mainline, a stale in-flight does not, and
//     no downstream check can tell afterwards which it measured.
//   • The tree must be clean. The gate's subject is what landed, not what is
//     lying in the checkout; measuring uncommitted work would green a campaign
//     over changes no review ever read.
//
// The scar: a configured-empty gate. Kickoff may legitimately return no gate
// commands when the fast tier and ticket checks settle every requirement, and
// refusing here would strand those campaigns with no path to complete. So an
// empty tier stamps green and says so in the verdict text, loudly, rather than
// letting "green" imply a suite ran. A documented nothing beats a hidden one.

import fs from 'node:fs';
import path from 'node:path';
import { backlog, backlogWrite, mainline } from './backlog.ts';
import { sh, shAsync, SH_TIMEOUT } from './state.ts';
import { EVIDENCE } from './paths.ts';

export type GateRunResult = {
  result: 'green' | 'red';
  failing: string[];
  runs: { name: string; status: number | null; ms: number; timedOut: boolean }[];
  evidence: string;
  note: string;
};

export async function runGate({ dir = '.' }: { dir?: string } = {}): Promise<GateRunResult> {
  const main = mainline();
  const at = sh('git symbolic-ref --short -q HEAD').stdout.trim();
  if (at !== main)
    throw new Error(`gate-run: HEAD is on ${at || '(detached)'}, not ${main} — the gate measures the merged tree, and a run from a ticket branch is a verdict about the wrong one`);

  const dirty = (await shAsync('git status --porcelain', dir)).stdout.split('\n')
    .filter(l => l.trim() && !l.slice(3).startsWith('.ailoop/')).join('\n').trim();
  if (dirty)
    throw new Error(`gate-run: the checkout is dirty, so the gate would measure work no review has read:\n${dirty}`);

  const checks = backlog().gate ?? [];
  const runs: GateRunResult['runs'] = [];
  const log: string[] = [];
  for (const c of checks) {
    const startedAt = Date.now();
    const r = await shAsync(c.cmd, dir, { label: `gate · ${c.name}` });
    const ok = r.status === 0;
    runs.push({ name: c.name, status: r.status, ms: Date.now() - startedAt, timedOut: r.status === SH_TIMEOUT });
    log.push(`### ${c.name} — ${ok ? 'PASS' : `FAIL (exit ${r.status})`}\n$ ${c.cmd}\n${r.stdout + r.stderr}`);
  }

  const failing = runs.filter(r => r.status !== 0).map(r => r.name);
  const result: 'green' | 'red' = failing.length ? 'red' : 'green';

  fs.mkdirSync(EVIDENCE, { recursive: true });
  const evidence = path.join(EVIDENCE, `gate-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  fs.writeFileSync(evidence, log.join('\n\n') || 'no gate commands are configured for this campaign\n');

  // The note becomes `gateState.lastRun.evidence`, so it has to carry what ran
  // rather than merely what was decided — a bare "green" in the record is the
  // state this verb exists to stop the campaign reaching.
  const note = checks.length
    ? `gate ${result}: ran [${runs.map(r => r.name).join(', ')}]${failing.length ? `, failing [${failing.join(', ')}]` : ''} — evidence ${evidence}`
    : `gate green by vacancy: this campaign configured NO gate commands, so nothing was measured on the merged tree — evidence ${evidence}`;

  backlogWrite(['gate-run', result, '--note', note, '--data', JSON.stringify({ runs, failing, evidence })]);
  return { result, failing, runs, evidence, note };
}
