// Running a list of checks and reporting what each one did.
//
// Four callers measure a tier of commands — verify (fast tier + a ticket's
// acceptance checks), gate-run (the slow suite), vet (a ticket's checks against
// the base), fastcheck-amend (candidates against the mainline) — and each had
// its own copy of the same loop: spawn under a live label, time it, notice the
// hang backstop's exit code, format an evidence block. Four copies of one
// mechanism is four places for the backstop's status to be read as an ordinary
// failure, which is the one distinction only the runner can draw.
//
// What stays with the callers is the part that is theirs: what a non-zero exit
// MEANS. A red check is a failing ticket to verify, a vacuous check to vet, a
// rejected candidate to fastcheck-amend, and an escaped bug to gate-run. This
// module has no opinion about any of that — it runs commands and says what
// happened.

import { shAsync, SH_TIMEOUT } from './state.ts';
import type { Check } from './agents/schemas.ts';

export type CheckRun = {
  name: string;
  cmd: string;
  status: number | null;
  ms: number;
  // The backstop killed it rather than the command choosing an exit code: a
  // hang nobody has noticed, not the check doing its job.
  timedOut: boolean;
  // stdout and stderr interleaved, as the evidence log and the refusal notes
  // both want them.
  output: string;
};

// `label` is the live-window prefix (state.ts): each check publishes itself as
// `<label> · <name>` so a dashboard in another process can watch a suite grind.
export async function runChecks(
  checks: Check[],
  { dir = '.', label, ticketId }: { dir?: string; label: string; ticketId?: string },
): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  for (const c of checks) {
    const at = Date.now();
    const r = await shAsync(c.cmd, dir, { label: `${label} · ${c.name}`, ...(ticketId ? { ticketId } : {}) });
    runs.push({
      name: c.name, cmd: c.cmd, status: r.status, ms: Date.now() - at,
      timedOut: r.status === SH_TIMEOUT, output: r.stdout + r.stderr,
    });
  }
  return runs;
}

export const failedNames = (runs: CheckRun[]): string[] =>
  runs.filter(r => r.status !== 0).map(r => r.name);

// The per-check evidence block. Written to a file that outlives the run and is
// read by a human or a judge, so it carries the command and the whole output —
// a name and an exit code are not evidence of anything.
export const evidenceLog = (runs: CheckRun[]): string[] =>
  runs.map(r => `### ${r.name} — ${r.status === 0 ? 'PASS' : `FAIL (exit ${r.status})`}\n$ ${r.cmd}\n${r.output}`);

// What the journal and the returned verdicts carry: the shape without the
// output, which belongs in the evidence file rather than in every record that
// mentions the run.
export const runFacts = (runs: CheckRun[]): { name: string; status: number | null; ms: number; timedOut: boolean }[] =>
  runs.map(({ name, status, ms, timedOut }) => ({ name, status, ms, timedOut }));
