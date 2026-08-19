// The measurement. No model — exit codes and a git scope check decide.
//
// Ticket mode: refuse a dirty tree (only committed work verifies), run every
// fastCheck + the ticket's acceptanceChecks in the checkout, then require the
// committed diff to stay inside the ticket's declared modules (∪ a manifest/
// lockfile allowlist). Writes the evidence log + the diff patch, journals the
// timing, returns a verdict. Flake mode: run one command N times and classify
// real-red vs flaky.
//
// The only measurement either coordinator seat has: the skill reaches it through
// `loop verify` (mechanics.ts). Checks run through shAsync so the live display
// keeps breathing while a suite grinds, each streaming under its own label.

import fs from 'node:fs';
import path from 'node:path';
import { shAsync, SH_TIMEOUT } from './state.ts';
import { RUN } from './paths.ts';
import { backlog, backlogWrite, ticket } from './backlog.ts';
import { appendJournal } from './journal.ts';
import { isInside, isManifest, normalizeModule } from './footprint.ts';

export type VerifyVerdict = { pass: boolean; failing: string[]; scopeOverflow: string[]; evidence: string; diff: string };
export type FlakeVerdict = { passes: number; fails: number; verdict: string; evidence: string };

const evidenceDir = () => {
  const dir = path.join(RUN, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export async function verify({ id, dir, base }: { id: string; dir: string; base: string }): Promise<VerifyVerdict> {
  const evid = evidenceDir();
  const t = ticket(id);

  // 1. dirty-tree refusal — only committed work verifies (our own .ailoop/ aside).
  const dirty = (await shAsync('git status --porcelain', dir)).stdout.split('\n')
    .filter(l => l.trim() && !l.slice(3).startsWith('.ailoop/')).join('\n').trim();
  if (dirty) return { pass: false, failing: ['dirty-tree'], scopeOverflow: [], evidence: '', diff: '' };

  // 2. run every fast check + the ticket's acceptance checks in the checkout.
  const startedAt = Date.now();
  const checks = [...(backlog().fastChecks ?? []), ...(t.acceptanceChecks ?? [])];
  const failing: string[] = [];
  const log: string[] = [];
  // Per-check status and duration, journaled alongside the verdict. The evidence
  // log has always carried the exit code, but evidence is deleted with the
  // campaign — so a check killed by shAsync's hang backstop (124) was
  // indistinguishable, forever after, from a suite that is merely slow. Which of
  // those it was decides whether the answer is a flake probe, a scoped check, or
  // a hung command nobody has noticed.
  const runs: { name: string; status: number | null; ms: number; timedOut: boolean }[] = [];
  for (const c of checks) {
    const at = Date.now();
    const r = await shAsync(c.cmd, dir, { label: `verify:${id} · ${c.name}`, ticketId: id });
    const ok = r.status === 0;
    if (!ok) failing.push(c.name);
    runs.push({ name: c.name, status: r.status, ms: Date.now() - at, timedOut: r.status === SH_TIMEOUT });
    log.push(`### ${c.name} — ${ok ? 'PASS' : `FAIL (exit ${r.status})`}\n$ ${c.cmd}\n${r.stdout + r.stderr}`);
  }

  // 3. scope check: every committed path must live inside a declared module (∪
  //    the manifest allowlist). A file the decomposer never foresaw is in scope
  //    as long as the worker wrote it where the ticket said it lives.
  const diffNames = (await shAsync(`git diff --name-only ${base}..HEAD`, dir)).stdout.trim().split('\n').filter(Boolean);
  const declared = (t.modules ?? []).map(normalizeModule);
  const scopeOverflow = diffNames.filter(f => !isManifest(f) && !declared.some(m => isInside(f, m)));
  if (scopeOverflow.length) failing.push('scope');
  log.push(`### scope — ${scopeOverflow.length ? 'FAIL' : 'PASS'}\ndeclared modules: ${declared.map(m => m || '(repo root)').join(', ') || '(none)'}\ndiff files: ${diffNames.join(', ') || '(none)'}\noverflow: ${scopeOverflow.join(', ') || '(none)'}`);

  // 4. evidence log + diff patch.
  const pass = failing.length === 0;
  const attemptN = (t.attempts ?? []).length + 1;
  const evidence = path.join(evid, pass ? `${id}.txt` : `${id}-a${attemptN}.txt`);
  fs.writeFileSync(evidence, log.join('\n\n'));
  const diff = path.join(evid, `${id}-diff.patch`);
  fs.writeFileSync(diff, (await shAsync(`git diff ${base}..HEAD`, dir)).stdout || '');

  // 5. journal the timing — telemetry, not backlog state.
  appendJournal({
    kind: 'verify', subject: id,
    body: `${pass ? 'pass' : `fail [${failing.join(', ')}]`} in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    data: { durationMs: Date.now() - startedAt, pass, failing, runs,
      ...(runs.some(r => r.timedOut) ? { timedOut: runs.filter(r => r.timedOut).map(r => r.name) } : {}) },
  });

  return { pass, failing, scopeOverflow, evidence, diff };
}

// Naming a ticket is what makes this THE ticket's probe rather than a diagnostic
// run, so it is also what spends invariant 4's one allowance. The second is
// refused here: a judge asking for another probe on a fixed diff and fixed
// evidence is stalling, and the coordinator that would have to remember the
// first has had its context compacted since. An unlabelled probe (recover
// diagnosing an environment) spends nothing, which is the escape hatch.
export async function flakeProbe(
  { cmd, dir, repeat = 5, id }: { cmd: string; dir: string; repeat?: number; id?: string },
): Promise<FlakeVerdict> {
  if (id) {
    const spent = ticket(id).amendments?.probe ?? 0;
    if (spent >= 1)
      throw new Error(`${id} already spent its flake probe — a second request on the same ticket is the judge stalling, which parks: discard and park`);
    backlogWrite(['probe-spent', id]);
  }
  const evid = evidenceDir();
  let passes = 0;
  const outputs: string[] = [];
  for (let i = 0; i < repeat; i++) {
    const r = await shAsync(cmd, dir, { label: id ? `flake:${id}` : undefined, ticketId: id });
    if (r.status === 0) passes++;
    outputs.push(`--- run ${i + 1} exit=${r.status}\n${r.stdout + r.stderr}`);
  }
  const verdict = passes === 0 ? 'real-red' : (passes < repeat ? 'flaky' : 'flaky-under-full-run-only');
  const evidence = path.join(evid, `flake-probe-${Date.now()}.txt`);
  fs.writeFileSync(evidence, outputs.join('\n'));
  return { passes, fails: repeat - passes, verdict, evidence };
}
