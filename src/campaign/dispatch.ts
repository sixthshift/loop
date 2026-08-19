// Everything a worker dispatch needs, in one call.
//
// The steps have not changed — vet the checks against the base, cut the branch,
// stamp the ticket in-flight, resolve the ladder rung, render the prompt. What
// changed is how many times the coordinator has to stop and think between them.
// Seven verbs meant up to seven model turns per ticket, and a model turn is tens
// of seconds whose only product is deciding to run the next obvious command.
// Measured across past campaigns that gap — the loop's own latency, not the
// worker's — was four times what the entire adversarial review cost.
//
// The split is the same one the whole system draws: this fills every variable
// derivable from state, and the caller supplies only `context`, the one field
// that is a judgement about what THIS worker needs to know. A verb cannot write
// that and should not try.
//
// Order is load-bearing. `vet` measures the base, so it must run while HEAD is
// still on mainline — before the branch is cut, not after.

import fs from 'node:fs';
import { backlog, backlogWrite, ticket } from './backlog.ts';
import { createBranch } from './branch.ts';
import { vet, type VetVerdict } from './vet.ts';
import { renderPrompt } from './agents/prompt.ts';
import { SCHEMAS } from './agents/schemas.ts';
import { resolvedChain } from './agents/models.ts';
import { isInfraAttempt } from './frontier.ts';

export type DispatchPlan = {
  ticket: string;
  branch: string;
  baseSha: string;
  rung: { n: number; model: string; engine: string; cliModel: string };
  vet: VetVerdict;
  prompt: string;
  schema: object;
};

const sentinel = (v: string, empty: string) => (v.trim() ? v : empty);

export async function dispatch(
  { id, context, dir = '.', acceptVacuous = false }:
  { id: string; context: string; dir?: string; acceptVacuous?: boolean },
): Promise<DispatchPlan> {
  const t = ticket(id);
  if (t.status !== 'open') throw new Error(`dispatch: ${id} is ${t.status} — only an open ticket dispatches`);
  if (!context.trim()) throw new Error('dispatch: --context is required — it is the one variable no verb can derive');

  // 1. Measure the base first: after `create` there is no base left to measure.
  const vetted = await vet({ id, dir });
  if (vetted.vacuous.length && !acceptVacuous)
    throw new Error(
      `dispatch: ${vetted.vacuous.length} acceptance check(s) already pass on the base — [${vetted.vacuous.join(', ')}]. ` +
      `A check green before the work exists is observing something else: sharpen it, or pass --accept-vacuous if this ticket ` +
      `legitimately only adds proof for behaviour that already ships.`);

  // 2. The ladder rung is arithmetic over the merit attempts, not a number to
  //    carry in a coordinator's head across a compaction.
  const meritAttempts = (t.attempts ?? []).filter(a => !isInfraAttempt(a)).length;
  const chain = resolvedChain('worker') as { model: string; engine: string; cliModel: string; available: boolean }[];
  const usable = chain.filter(r => r.available);
  if (!usable.length) throw new Error('dispatch: no worker engine is available — every rung of the chain failed its availability probe');
  const picked = usable[Math.min(meritAttempts, usable.length - 1)]!;
  const rung = { n: meritAttempts + 1, model: picked.model, engine: picked.engine, cliModel: picked.cliModel };

  // 3. Cut and stamp. Both are writes, so nothing above them may fail after.
  const cut = createBranch(id);
  if (!cut.ok) throw new Error(`dispatch: ${cut.reason}`);
  backlogWrite(['set-status', id, 'in-flight', '--base-sha', cut.baseSha, '--model', rung.model, '--rung', String(rung.n)]);

  const b = backlog();
  const fresh = ticket(id);
  const prompt = renderPrompt('worker', {
    id, title: fresh.title, branch: cut.branch, context,
    modules: (fresh.modules ?? []).join(', '),
    acceptance: fresh.acceptance,
    acceptanceChecks: (fresh.acceptanceChecks ?? []).map(c => `- ${c.name}: ${c.cmd}`).join('\n'),
    fastChecks: sentinel((b.fastChecks ?? []).map(c => `- ${c.name}: ${c.cmd}`).join('\n'), '(none configured)'),
    outOfScope: sentinel((b.outOfScope ?? []).map(o => `- ${o}`).join('\n'), '(none declared)'),
    satisfies: sentinel(
      (b.requirements ?? []).filter(r => (fresh.satisfies ?? []).includes(r.id)).map(r => `${r.id}: ${r.clause}`).join('\n'),
      '(this ticket claims no requirement directly)'),
    alreadyGreen: sentinel(vetted.vacuous.map(n => `- ${n}`).join('\n'), '(none — every acceptance check was red on the base)'),
    attempts: sentinel(
      (fresh.attempts ?? []).map((a, i) => {
        const failed = Array.isArray(a.failed) ? a.failed.join(', ') : (a.failed ?? '');
        return `- attempt ${i + 1} failed [${failed}]: ${a.hypothesis ?? '(no hypothesis recorded)'}${a.fix ? ` — fix: ${a.fix}` : ''}`;
      }).join('\n'),
      '(first attempt)'),
  });

  return { ticket: id, branch: cut.branch, baseSha: cut.baseSha, rung, vet: vetted, prompt, schema: SCHEMAS.worker! };
}

// Writing the schema out is the caller's next step for codex either way, so the
// verb offers it rather than making every coordinator reinvent a temp path.
export function writeSchema(schema: object, out: string): string {
  fs.writeFileSync(out, JSON.stringify(schema, null, 2) + '\n');
  return out;
}
