// One ticket's runtime lifecycle: provision an isolated worktree, run its
// worker, verify and independently review the committed diff, then serialize
// landing onto the shared mainline. Campaign scheduling belongs in drive.ts;
// this module starts when that scheduler admits a ticket and ends when the
// ticket closes or returns to the backlog.

import { backlog, backlogWrite, ticket } from './backlog.ts';
import type { Ticket } from './backlog.ts';
import { shAsync, readLearnings } from './state.ts';
import { isInfraAttempt } from './frontier.ts';
import { verify, flakeProbe } from './verify.ts';
import type { VerifyVerdict, FlakeVerdict } from './verify.ts';
import { agent, renderPrompt, AgentError } from './agents/run.ts';
import { available } from '../agent/engine.ts';
import type { AgentResult } from './agents/run.ts';
import { MODELS } from './agents/models.ts';
import { WORKER, REVIEW } from './agents/schemas.ts';
import type { WorkerVerdict, ReviewVerdict, Check } from './agents/schemas.ts';
import { createWorktree, removeWorktree, deleteBranch, mergeBranch, mainSha } from './worktree.ts';
import { provision } from './provision.ts';
import { withMainline } from './mainline.ts';
import { recover, renumber } from './recover.ts';
import { park } from './escalate.ts';
import * as tui from '../runtime/reporting.ts';

const WORKER_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export type WorkerDone =
  | { id: string; res: AgentResult<WorkerVerdict>; err?: undefined }
  | { id: string; err: AgentError; res?: undefined };

export type WorkerMeta = {
  promise: Promise<WorkerDone>;
  dir: string;
  baseSha: string;
};

export type Workers = Map<string, WorkerMeta>;

type Telemetry = {
  workerTokens: number;
  workerSeconds: number;
  workerCostUsd: number;
  model: string;
};

// A provisioning failure ends the worker channel before an agent ran. Wrap it
// in the same honest envelope rather than pretending it was a model verdict.
const asAgentError = (e: Error): AgentError =>
  e instanceof AgentError ? e : new AgentError(e.message);

export function dispatchTicket(workers: Workers, id: string): void {
  const t = ticket(id);
  const { dir, branch, baseSha } = createWorktree(id);
  backlogWrite(['set-status', id, 'in-flight', '--note', `dispatched on ${branch}`,
    '--base-sha', baseSha, '--data', JSON.stringify({ baseSha, branch })]);

  const b = backlog();
  const learnings = readLearnings();
  const prompt = renderPrompt('worker', {
    id, branch,
    title: t.title,
    context: t.context + (learnings?.['landmines.md'] ? `\n\n## Known landmines in this codebase\n\n${learnings['landmines.md']}` : ''),
    acceptance: t.acceptance,
    acceptanceChecks: t.acceptanceChecks,
    fastChecks: b.fastChecks,
    modules: t.modules.join(', '),
    attempts: t.attempts?.length
      ? `## Prior attempts on this ticket (all failed — do differently)\n\n${JSON.stringify(t.attempts, null, 2)}`
      : '',
  });

  // Provisioning can copy hundreds of megabytes, so it lives inside the
  // channel rather than blocking the scheduler's next dispatch.
  const promise: Promise<WorkerDone> = provision(id, dir)
    .then(summary => {
      backlogWrite(['note', '--kind', 'provisioned', '--subject', id, '--body', summary]);
      return agent<WorkerVerdict>({
        prompt,
        models: workerChain(t),
        schema: WORKER,
        cwd: dir,
        bypassPermissions: true,
        timeoutMs: WORKER_TIMEOUT_MS,
        label: `worker:${id}`,
      });
    })
    .then(res => ({ id, res }), (err: Error) => ({ id, err: asAgentError(err) }));

  workers.set(id, { promise, dir, baseSha });
  const chain = workerChain(t);
  const lead = chain.filter(available)[0] ?? chain[0];
  tui.log(`⇢ dispatched ${id} (${lead}): ${t.title}`);
}

function workerChain(t: Ticket): string[] {
  const merit = (t.attempts ?? []).filter(a => !isInfraAttempt(a)).length;
  return MODELS.worker.slice(Math.min(merit, MODELS.worker.length - 1));
}

export async function settleTicket(done: WorkerDone, meta: WorkerMeta): Promise<boolean> {
  const { id } = done;

  if (done.err) {
    discardTicketBuild(id);
    backlogWrite(['attempt', id, '--failed', 'worker-channel', '--infra',
      '--hypothesis', done.err.killed
        ? 'killed by the operator from the dashboard'
        : `worker channel ended with no verdict: ${done.err.message.slice(0, 300)}`,
      '--fix', done.err.killed
        ? 'not a code failure — redispatches when the frontier next offers it'
        : 'fresh dispatch; investigate if it recurs']);
    return false;
  }

  const reply = done.res.output ?? {};
  const telemetry: Telemetry = {
    workerTokens: done.res.tokens,
    workerSeconds: done.res.seconds,
    workerCostUsd: done.res.costUsd,
    model: done.res.model,
  };

  if (reply.tooBig) {
    discardTicketBuild(id);
    const children = renumber((reply.proposedTickets ?? []).map(c => ({
      ...c, origin: `decomposed from ${id}`,
    })));
    if (!children.length) {
      await recover({ kind: 'toobig-without-split', ticketId: id });
      reopenIfStranded(id, 'worker declared tooBig with no split and recover returned without moving the ticket');
    } else {
      backlogWrite(['decompose', id, '-', '--note', 'worker declared tooBig'], children);
    }
    return false;
  }

  if (reply.blocked) {
    discardTicketBuild(id);
    backlogWrite(['set-status', id, 'parked', '--note', `worker blocked: ${reply.reason}`,
      '--data', JSON.stringify(telemetry)]);
    await recover({
      kind: 'worker-blocked', ticketId: id, reason: reply.reason,
      instruction: 'First test whether the block is a defect in a completed dependency: read the cited spec section and the delivered code. If a merged/closed ticket was built wrong or under-built against the locked spec, author a repair ticket (origin "repair: <what> under-built vs spec §…"), scoped to fix it at source, and rewire this ticket onto it — the escaped-bug rule applies, exactly as campaign-gate-red does. Escalate only if the block needs a decision the locked spec does not already answer.',
    }, { ticketId: id });
    return false;
  }

  return reviewTicket(id, meta, reply.summary ?? '(no summary)', telemetry);
}

// Scripted verification followed by the independent verdict loop. Also used by
// resume when a branch survived but its worker process did not.
export async function reviewTicket(
  id: string,
  meta: { dir: string; baseSha: string },
  workerSummary: string,
  telemetry: Telemetry,
): Promise<boolean> {
  tui.log(`verifying ${id}…`);
  let verification = await verify({ id, dir: meta.dir, base: meta.baseSha });
  const b = backlog();
  const learnings = readLearnings();

  let probeResult: FlakeVerdict | null = null;
  for (let round = 0; round < 4; round++) {
    const t = ticket(id);
    const verdict = (await agent<ReviewVerdict>({
      prompt: renderPrompt('review', {
        ticket: t,
        workerSummary,
        verifyResult: verification,
        diffPath: verification.diff,
        outOfScope: b.outOfScope ?? [],
        gamingLearnings: learnings?.['gaming.md']
          ? `## Cheat shapes observed in past campaigns\n\n${learnings['gaming.md']}`
          : '(none recorded)',
        probeResult: probeResult ?? '(none ran)',
        attempts: t.attempts?.length ? t.attempts : '(first attempt)',
      }),
      models: MODELS.review,
      schema: REVIEW,
      tools: 'Read,Glob,Grep',
      label: `review:${id}`,
    })).output;

    switch (verdict.verdict) {
      case 'close':
        return closeTicket(id, meta, verification, verdict, telemetry, workerSummary);

      case 'retry':
        discardTicketBuild(id);
        recordAttempt(id, verification, verdict, telemetry);
        return false;

      case 'gamed':
        discardTicketBuild(id);
        if (verdict.sharpenChecks?.length)
          amendChecks(id, verdict.sharpenChecks, `gamed: ${verdict.hypothesis ?? ''}`);
        recordAttempt(id, verification, verdict, telemetry);
        return false;

      case 'flake-probe':
        if (probeResult) {
          discardTicketBuild(id);
          park(`judge asked for a second flake probe on ${id}`, { ticketId: id });
          return false;
        }
        tui.log(`flake probe on ${id}: ${verdict.probeCmd}`);
        probeResult = await flakeProbe({ cmd: verdict.probeCmd!, dir: meta.dir, id });
        backlogWrite(['note', '--kind', 'flake-probe', '--subject', id,
          '--body', `${verdict.probeCmd} → ${probeResult.verdict}`]);
        continue;

      case 'amend-typo':
        amendChecks(id, verdict.fixedChecks, `typo-level amendment: ${verdict.note ?? ''}`);
        backlogWrite(['set-status', id, 'in-flight', '--note', 're-verify after typo amendment']);
        verification = await verify({ id, dir: meta.dir, base: meta.baseSha });
        continue;

      case 'escalate':
        discardTicketBuild(id);
        await recover({ kind: 'judge-escalate', ticketId: id, reason: verdict.reason }, { ticketId: id });
        reopenIfStranded(id, 'judge escalated and recover returned without moving the ticket');
        return false;
    }
  }

  discardTicketBuild(id);
  await recover({ kind: 'judge-no-converge', ticketId: id }, { ticketId: id });
  reopenIfStranded(id, 'review did not converge and recover returned without moving the ticket');
  return false;
}

export function discardTicketBuild(id: string): void {
  removeWorktree(id);
  deleteBranch(id);
}

function reopenIfStranded(id: string, why: string): void {
  if (ticket(id).status !== 'in-flight') return;
  backlogWrite(['set-status', id, 'open', '--note', `${why}; no worker or branch remains`]);
}

function recordAttempt(
  id: string,
  verification: VerifyVerdict,
  verdict: ReviewVerdict,
  telemetry: Telemetry,
): void {
  const failing = verdict.failing?.length
    ? verdict.failing
    : (verification.failing.length ? verification.failing : ['judge-rejected']);
  backlogWrite(['attempt', id,
    '--failed', failing.join(','),
    '--hypothesis', verdict.hypothesis ?? verdict.verdict,
    '--fix', verdict.fixNote ?? '',
    '--data', JSON.stringify(telemetry)]);
}

function amendChecks(id: string, checks: Check[] | undefined, note: string): void {
  backlogWrite(['set-status', id, 'open', '--note', 'check amendment']);
  backlogWrite(['update', id, '-', '--note', note], { acceptanceChecks: checks });
}

type Landing =
  | { ok: false; dirty: boolean; conflict: string }
  | { ok: true; integrationRed: string[] };

async function closeTicket(
  id: string,
  meta: { dir: string; baseSha: string },
  verification: VerifyVerdict,
  verdict: ReviewVerdict,
  telemetry: Telemetry,
  workerSummary: string,
): Promise<boolean> {
  let landed = await withMainline(() =>
    land(id, meta, verification, verdict, telemetry, workerSummary));

  if (!landed.ok && landed.dirty) {
    const conflict = landed.conflict;
    await recover({ kind: 'dirty-mainline', ticketId: id, conflict });
    landed = await withMainline(() =>
      land(id, meta, verification, verdict, telemetry, workerSummary));
  }

  if (!landed.ok) {
    discardTicketBuild(id);
    backlogWrite(['attempt', id, '--failed', 'merge-conflict', '--infra',
      '--hypothesis', `mainline moved; merge conflict: ${landed.conflict.slice(0, 300)}`,
      '--fix', 'rebuild against current HEAD', '--data', JSON.stringify(telemetry)]);
    return false;
  }

  tui.log(`✓ closed ${id}`);
  if (landed.integrationRed.length) {
    backlogWrite(['note', '--kind', 'integration-red', '--subject', id,
      '--body', `fast tier red after merging ${id}: [${landed.integrationRed.join(', ')}]`]);
    await recover({ kind: 'integration-red', ticketId: id, failing: landed.integrationRed });
  }
  return true;
}

async function land(
  id: string,
  meta: { baseSha: string },
  verification: VerifyVerdict,
  verdict: ReviewVerdict,
  telemetry: Telemetry,
  workerSummary: string,
): Promise<Landing> {
  const shaBeforeMerge = mainSha();
  const merged = mergeBranch(id);
  if (!merged.ok) return { ok: false, dirty: merged.dirty, conflict: merged.conflict };

  if (ticket(id).status !== 'in-flight')
    backlogWrite(['set-status', id, 'in-flight', '--note', 'closing']);
  backlogWrite(['close', id, '--evidence', verification.evidence,
    '--note', (verdict.note || workerSummary).slice(0, 500),
    '--data', JSON.stringify(telemetry)]);
  removeWorktree(id);

  if (shaBeforeMerge === meta.baseSha) return { ok: true, integrationRed: [] };
  tui.log(`integration check after ${id} (mainline moved)…`);
  return { ok: true, integrationRed: await runFastChecks() };
}

async function runFastChecks(): Promise<string[]> {
  const red: string[] = [];
  for (const check of backlog().fastChecks ?? []) {
    if ((await shAsync(check.cmd, '.', { label: `fastcheck:${check.name}` })).status !== 0)
      red.push(check.name);
  }
  return red;
}
