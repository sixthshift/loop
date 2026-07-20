// The measurement. No model — exit codes and a git scope check decide.
//
// Ticket mode: refuse a dirty tree (only committed work verifies), run every
// fastCheck + the ticket's acceptanceChecks in the worktree, then require the
// committed diff to stay within the ticket's declared files (∪ a manifest/
// lockfile allowlist). Writes the evidence log + the diff patch, journals the
// timing, returns a verdict. Flake mode: run one command N times and classify
// real-red vs flaky.
//
// Native twin of the ailoop skill's verify.mjs — same rules, no shared code.
// Checks run through shAsync so the live display keeps breathing while a suite
// grinds, and each streams to the dashboard under its own label.

import fs from 'node:fs';
import path from 'node:path';
import { RUN, shAsync } from './state.ts';
import { backlog, ticket } from './backlog.ts';
import { appendJournal } from './journal.ts';

export type VerifyVerdict = { pass: boolean; failing: string[]; scopeOverflow: string[]; evidence: string; diff: string };
export type FlakeVerdict = { passes: number; fails: number; verdict: string; evidence: string };

// Manifest/lockfiles are allowlisted: many tickets legitimately touch them, so
// a diff into one is never a scope overflow.
const ALLOW = new Set(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']);

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

  // 2. run every fast check + the ticket's acceptance checks in the worktree.
  const startedAt = Date.now();
  const checks = [...(backlog().fastChecks ?? []), ...(t.acceptanceChecks ?? [])];
  const failing: string[] = [];
  const log: string[] = [];
  for (const c of checks) {
    const r = await shAsync(c.cmd, dir, { label: `verify:${id} · ${c.name}`, ticketId: id });
    const ok = r.status === 0;
    if (!ok) failing.push(c.name);
    log.push(`### ${c.name} — ${ok ? 'PASS' : `FAIL (exit ${r.status})`}\n$ ${c.cmd}\n${r.stdout + r.stderr}`);
  }

  // 3. scope check: the committed diff must stay within declared files ∪ allowlist.
  const diffNames = (await shAsync(`git diff --name-only ${base}..HEAD`, dir)).stdout.trim().split('\n').filter(Boolean);
  const declared = new Set(t.files ?? []);
  const scopeOverflow = diffNames.filter(f => !declared.has(f) && !ALLOW.has(path.basename(f)));
  if (scopeOverflow.length) failing.push('scope');
  log.push(`### scope — ${scopeOverflow.length ? 'FAIL' : 'PASS'}\ndiff files: ${diffNames.join(', ') || '(none)'}\noverflow: ${scopeOverflow.join(', ') || '(none)'}`);

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
    data: { durationMs: Date.now() - startedAt, pass, failing },
  });

  return { pass, failing, scopeOverflow, evidence, diff };
}

export async function flakeProbe(
  { cmd, dir, repeat = 5, id }: { cmd: string; dir: string; repeat?: number; id?: string },
): Promise<FlakeVerdict> {
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
