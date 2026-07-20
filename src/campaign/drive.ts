// Stage 2 — the drive. Deterministic spine, delegated judgment: the loop
// asks the frontier what is true, scripts what has one right answer, and
// spawns a fresh-context agent for every verdict. The coordinator itself
// never judges a diff — context-poisoning is structural, not a discipline.

import { backlog, backlogWrite, ticket } from './backlog.ts';
import { journalEntries, journalTail } from './journal.ts';
import { shAsync, readLearnings } from './state.ts';
import type { CampaignContext } from './state.ts';
import { frontier } from './frontier.ts';
import { verify, flakeProbe } from './verify.ts';
import type { VerifyVerdict, FlakeVerdict } from './verify.ts';
import { agent, renderPrompt, AgentError } from '../agent/agent.ts';
import type { AgentResult } from '../agent/agent.ts';
import { MODELS } from './models.ts';
import { WORKER, GAMING, JUDGE, REVIEWER, REINTEGRATE } from '../agent/schemas.ts';
import type { WorkerVerdict, GamingVerdict, JudgeVerdict, ReviewerVerdict, ReintegrateVerdict, Check } from '../agent/schemas.ts';
import { createWorktree, attachWorktree, removeWorktree, deleteBranch, mergeBranch, mainSha } from './worktree.ts';
import { vetDrafts, acceptedRisks } from './critic.ts';
import { triage, renumber, backlogSummary } from './triage.ts';
import { escalate, Escalation } from './escalate.ts';
import * as tui from '../tui/tui.ts';
import { control } from '../tui/control.ts';

const REVIEW_EVERY = 5;
const WORKER_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const idle = () => new Promise(r => setTimeout(r, 1500));

// A settled worker channel: the verdict envelope, or the error that ended it.
type WorkerDone =
  | { id: string; res: AgentResult<WorkerVerdict>; err?: undefined }
  | { id: string; err: AgentError; res?: undefined };
type WorkerMeta = { promise: Promise<WorkerDone>; dir: string; branch: string; baseSha: string };
type Workers = Map<string, WorkerMeta>;
type Telemetry = { workerTokens: number; workerSeconds: number; workerCostUsd: number; model: string };

// Two predicates the ladder leans on more than once; every other rung reads
// its fact inline off the destructured frontier below.
const hasDrafts = () => backlog().tickets.some(t => t.status === 'draft');
const isIdle = (workers: Workers) => workers.size === 0;

// Stage 2 — the drive. One event loop: each pass reads the frontier once into
// named locals, walks the priority ladder those locals feed, takes one action,
// and loops. The two rungs that change state mid-pass (frontier repair, draft
// vetting) re-read the frontier before the rungs below them run.
// reconcileStale runs once on resume, before the first pass — surviving
// in-flight work is judged like any other result.
//
// The whole body sits inside the crash membrane — the universal else, error
// edition. An unenumerated throw anywhere in a pass is an anomaly like any
// other: journal it, hand it to a fresh triage agent, keep driving. The same
// error twice is a missing arm, not a flake — that escalates. Escalations pass
// through untouched: they are the honest exit, not a crash.
export async function drive(ctx: CampaignContext): Promise<void> {
  const workers: Workers = new Map();
  let closesSinceReview = 0;
  let reconciled = false;
  let lastCrash: string | null = null;

  while (true) {
    try {
      if (!reconciled) { await reconcileStale(ctx, workers); reconciled = true; }

      if (control.forceReview) { // operator asked from the dashboard
        control.forceReview = false;
        await runReview(ctx);
        closesSinceReview = 0;
      }

      let { problems, cycles, capped, stuck, phasesDone, complete, dispatchable } = frontier();

      if (problems.length || cycles.length) {
        await triage({ kind: 'frontier-problems', problems, cycles });
        const repaired = frontier();
        ({ problems, cycles, capped, stuck, phasesDone, complete, dispatchable } = repaired);
        if (problems.length || cycles.length) escalate('frontier problems persist after triage', repaired);
      }

      if (capped.length || stuck.length) {
        escalate('attempt cap / thrash wall', {
          capped, stuck,
          attempts: [...capped, ...stuck].map(x => ({ id: x.ticket, log: ticket(x.ticket).attempts })),
        });
      }

      const toClose = phasesDone.filter(p => !phaseClosed(p));
      if (toClose.length) {
        await closePhase(ctx, toClose[0]!);
        await runReview(ctx); // phase close is a mandatory review checkpoint
        closesSinceReview = 0;
        continue;
      }

      if (complete && isIdle(workers)) return; // → termination

      if (hasDrafts()) {
        await vetDrafts();
        ({ problems, cycles, capped, stuck, phasesDone, complete, dispatchable } = frontier());
      }

      if (!control.paused) {
        for (const id of dispatchable) {
          if (workers.size >= control.workerCap) break;
          if (!workers.has(id)) dispatch(ctx, workers, id);
        }
      }

      if (isIdle(workers)) {
        // No work in flight and nothing dispatched: either the graph is blocked
        // or state is wedged. Never report done over live blocked tickets.
        if (complete) return;
        if (control.paused) { await idle(); continue; } // operator pause, not a stall
        await triage({ kind: 'stalled', frontier: frontier() }); // full snapshot; locals omit ready/inFlight/counts
        const after = frontier();
        const canProgress = after.dispatchable.length > 0 || after.phasesDone.some(p => !phaseClosed(p))
          || hasDrafts() || after.complete;
        if (!canProgress) escalate('stalled: no dispatchable work and triage freed none', after);
        continue;
      }

      const done = await Promise.race([...workers.values()].map(w => w.promise));
      const meta = workers.get(done.id)!;
      workers.delete(done.id);
      if (await settle(ctx, done, meta)) closesSinceReview++;
      if (closesSinceReview >= REVIEW_EVERY) {
        await runReview(ctx);
        closesSinceReview = 0;
      }
    } catch (e: any) {
      if (e instanceof Escalation) throw e;
      const sig = String(e.message ?? e).slice(0, 300);
      if (sig === lastCrash) escalate(`coordinator error repeated — needs a real arm: ${sig}`, { stack: e.stack });
      lastCrash = sig;
      tui.log(`⚠ coordinator error → triage: ${sig}`);
      try {
        backlogWrite(['note', '--kind', 'coordinator-error', '--subject', 'drive',
          '--body', `${sig}\n${(e.stack ?? '').slice(0, 1500)}`]);
      } catch { /* journaling failed; triage below still gets the error */ }
      try {
        await triage({ kind: 'coordinator-error', error: sig, stack: (e.stack ?? '').slice(0, 1500) });
      } catch (t: any) {
        if (t instanceof Escalation) throw t;
        escalate(`coordinator error, and triage on it failed too: ${sig}`, { triageError: t.message });
      }
    }
  }
}

// --- dispatch -------------------------------------------------------------

function dispatch(ctx: CampaignContext, workers: Workers, id: string): void {
  const t = ticket(id);
  const { dir, branch, baseSha } = createWorktree(id);
  backlogWrite(['set-status', id, 'in-flight', '--note', `dispatched on ${branch}`,
    '--data', JSON.stringify({ baseSha, branch })]);

  const b = backlog();
  const learnings = readLearnings();
  const prompt = renderPrompt('worker', {
    id, branch,
    title: t.title,
    context: t.context + (learnings?.['landmines.md'] ? `\n\n## Known landmines in this codebase\n\n${learnings['landmines.md']}` : ''),
    acceptance: t.acceptance,
    acceptanceChecks: t.acceptanceChecks,
    fastChecks: b.fastChecks,
    files: t.files.join(', '),
    attempts: t.attempts?.length
      ? `## Prior attempts on this ticket (all failed — do differently)\n\n${JSON.stringify(t.attempts, null, 2)}`
      : '',
  });

  // Model selection is centralised in models.ts — every role, workers included,
  // draws its chain from there; tickets carry no model of their own.
  const promise: Promise<WorkerDone> = agent<WorkerVerdict>({
    prompt,
    models: MODELS.worker,
    schema: WORKER,
    cwd: dir,
    bypassPermissions: true,
    timeoutMs: WORKER_TIMEOUT_MS,
    label: `worker:${id}`,
  }).then(res => ({ id, res }), (err: AgentError) => ({ id, err }));

  workers.set(id, { promise, dir, branch, baseSha });
  tui.log(`⇢ dispatched ${id} (${MODELS.worker[0]}): ${t.title}`);
}

// --- settle: verify → gaming → judge → apply -------------------------------

async function settle(ctx: CampaignContext, done: WorkerDone, meta: WorkerMeta): Promise<boolean> {
  const { id } = done;

  if (done.err) {
    backlogWrite(['attempt', id, '--failed', 'worker-channel',
      '--hypothesis', done.err.killed
        ? 'killed by the operator from the dashboard'
        : `worker session died: ${done.err.message.slice(0, 300)}`,
      '--fix', done.err.killed
        ? 'not a code failure — redispatches when the frontier next offers it'
        : 'fresh dispatch; investigate if it recurs']);
    removeWorktree(id); deleteBranch(id);
    return false;
  }

  const reply = done.res.output ?? {};
  const telemetry: Telemetry = { workerTokens: done.res.tokens, workerSeconds: done.res.seconds, workerCostUsd: done.res.costUsd, model: done.res.model };

  if (reply.tooBig) {
    const children = renumber((reply.proposedTickets ?? []).map(c => ({
      ...c, origin: `decomposed from ${id}`, phase: c.phase || ticket(id).phase,
    })));
    if (!children.length) {
      await triage({ kind: 'toobig-without-split', ticketId: id });
    } else {
      backlogWrite(['decompose', id, '-', '--note', 'worker declared tooBig'], children);
    }
    removeWorktree(id); deleteBranch(id);
    return false;
  }

  if (reply.blocked) {
    backlogWrite(['set-status', id, 'blocked', '--note', `worker blocked: ${reply.reason}`,
      '--data', JSON.stringify(telemetry)]);
    removeWorktree(id); deleteBranch(id);
    await triage({
      kind: 'worker-blocked', ticketId: id, reason: reply.reason,
      instruction: 'First test whether the block is a defect in a completed dependency: read the cited spec section and the delivered code. If a merged/closed ticket was built wrong or under-built against the locked spec, author a repair ticket (origin "repair: <what> under-built vs spec §…"), scoped to fix it at source, and rewire this ticket onto it — the escaped-bug rule applies, exactly as phase-gate-red does. Escalate only if the block needs a decision the locked spec does not already answer.',
    });
    return false;
  }

  return judgeReturn(ctx, id, meta, reply.summary ?? '(no summary)', telemetry);
}

// The three layers, then the verdict loop. Also the resume path for a
// surviving branch whose worker session is gone.
export async function judgeReturn(ctx: CampaignContext, id: string, meta: { dir: string; baseSha: string }, workerSummary: string, telemetry: Telemetry): Promise<boolean> {
  tui.log(`verifying ${id}…`);
  let v = await verify({ id, dir: meta.dir, base: meta.baseSha });
  let gaming: GamingVerdict = { flags: [] };
  if (v.pass) gaming = await gamingCheck(id, v.diff);

  let probeResult: FlakeVerdict | null = null;
  for (let round = 0; round < 4; round++) {
    const t = ticket(id);
    const verdict = (await agent<JudgeVerdict>({
      prompt: renderPrompt('judge', {
        ticket: t,
        workerSummary,
        verifyResult: v,
        gamingFlags: gaming.flags.length ? gaming.flags : '(none)',
        probeResult: probeResult ?? '(none ran)',
        attempts: t.attempts?.length ? t.attempts : '(first attempt)',
      }) + riskAppendix(id),
      models: MODELS.judge,
      schema: JUDGE,
      tools: 'Read,Glob,Grep',
      label: `judge:${id}`,
    })).output;

    switch (verdict.verdict) {
      case 'close':
        return closeTicket(id, meta, v, verdict, telemetry, workerSummary);

      case 'retry':
        recordAttempt(id, v, verdict, telemetry);
        removeWorktree(id); deleteBranch(id);
        return false;

      case 'gamed':
        // Escaped-bug rule: the cheated check gets sharper before re-dispatch.
        if (verdict.sharpenChecks?.length) amendChecks(id, verdict.sharpenChecks, `gamed: ${verdict.hypothesis ?? ''}`);
        recordAttempt(id, v, verdict, telemetry);
        removeWorktree(id); deleteBranch(id);
        return false;

      case 'flake-probe': {
        if (probeResult) { escalate(`judge asked for a second flake probe on ${id}`, verdict); }
        tui.log(`flake probe on ${id}: ${verdict.probeCmd}`);
        probeResult = await flakeProbe({ cmd: verdict.probeCmd!, dir: meta.dir, id });
        backlogWrite(['note', '--kind', 'flake-probe', '--subject', id,
          '--body', `${verdict.probeCmd} → ${probeResult.verdict}`]);
        continue; // re-judge with the probe facts
      }

      case 'amend-typo': {
        // Letter-level check fix, journaled; then re-measure against the
        // corrected contract.
        amendChecks(id, verdict.fixedChecks, `typo-level amendment: ${verdict.note ?? ''}`);
        backlogWrite(['set-status', id, 'in-flight', '--note', 're-verify after typo amendment']);
        v = await verify({ id, dir: meta.dir, base: meta.baseSha });
        gaming = v.pass ? await gamingCheck(id, v.diff) : { flags: [] };
        continue;
      }

      case 'escalate':
        escalate(`judge(${id}): ${verdict.reason}`, { verify: v, gaming });
    }
  }
  escalate(`judge(${id}) did not converge after 4 rounds`);
}

function riskAppendix(id: string): string {
  const risks = acceptedRisks(journalEntries(), id);
  return risks.length ? `\n\n## Accepted risks on this ticket (from the critic)\n\n- ${risks.join('\n- ')}\n` : '';
}

async function gamingCheck(id: string, diffPath: string): Promise<GamingVerdict> {
  const b = backlog();
  const learnings = readLearnings();
  return (await agent<GamingVerdict>({
    prompt: renderPrompt('gaming', {
      ticket: ticket(id),
      outOfScope: b.outOfScope ?? [],
      diffPath,
      gamingLearnings: learnings?.['gaming.md']
        ? `## Cheat shapes observed in past campaigns\n\n${learnings['gaming.md']}`
        : '',
    }),
    models: MODELS.gaming,
    schema: GAMING,
    tools: 'Read',
    label: `gaming:${id}`,
  })).output;
}

function recordAttempt(id: string, v: VerifyVerdict, verdict: JudgeVerdict, telemetry: Telemetry): void {
  const failing = verdict.failing?.length ? verdict.failing : (v.failing.length ? v.failing : ['judge-rejected']);
  backlogWrite(['attempt', id,
    '--failed', failing.join(','),
    '--hypothesis', verdict.hypothesis ?? verdict.verdict,
    '--fix', verdict.fixNote ?? '',
    '--data', JSON.stringify(telemetry)]);
}

// Check amendments ride backlog-write's legal transitions:
// in-flight → vetted → (update demotes) draft → vet → vetted.
function amendChecks(id: string, checks: Check[] | undefined, note: string): void {
  backlogWrite(['set-status', id, 'vetted', '--note', 'check amendment']);
  backlogWrite(['update', id, '-', '--note', note], { acceptanceChecks: checks });
  backlogWrite(['vet', id, '--note', 'check amendment — prior critic vet carries over']);
}

async function closeTicket(id: string, meta: { dir: string; baseSha: string }, v: VerifyVerdict, verdict: JudgeVerdict, telemetry: Telemetry, workerSummary: string): Promise<boolean> {
  const shaBeforeMerge = mainSha();
  let merged = mergeBranch(id);
  if (!merged.ok && merged.dirty) {
    // A dirty mainline blocks every merge identically — repairing it keeps a
    // judged-close branch that the failed-attempt path below would burn.
    await triage({ kind: 'dirty-mainline', ticketId: id, conflict: merged.conflict });
    merged = mergeBranch(id);
  }
  if (!merged.ok) {
    // Reject rather than accept-and-revert: a conflicted merge is a failed
    // attempt, and a fresh dispatch starts from the moved mainline.
    backlogWrite(['attempt', id, '--failed', 'merge-conflict',
      '--hypothesis', `mainline moved; merge conflict: ${merged.conflict.slice(0, 300)}`,
      '--fix', 'rebuild against current HEAD', '--data', JSON.stringify(telemetry)]);
    removeWorktree(id); deleteBranch(id);
    return false;
  }

  if (ticket(id).status !== 'in-flight') backlogWrite(['set-status', id, 'in-flight', '--note', 'closing']);
  backlogWrite(['close', id, '--evidence', v.evidence,
    '--note', (verdict.note || workerSummary).slice(0, 500),
    '--data', JSON.stringify(telemetry)]);
  removeWorktree(id); // branch survives until phase close — bisection needs it
  tui.log(`✓ closed ${id}`);

  // The old batch merge's free integration gate: if mainline moved past this
  // worker's base, the fast tier re-runs on the merged tree.
  if (shaBeforeMerge !== meta.baseSha) {
    tui.log(`integration check after ${id} (mainline moved)…`);
    const red = await runFastChecks();
    if (red.length) {
      backlogWrite(['note', '--kind', 'integration-red', '--subject', id,
        '--body', `fast tier red after merging ${id}: [${red.join(', ')}]`]);
      await triage({ kind: 'integration-red', ticketId: id, failing: red });
    }
  }
  return true;
}

async function runFastChecks(): Promise<string[]> {
  const red: string[] = [];
  for (const c of backlog().fastChecks ?? []) {
    if ((await shAsync(c.cmd, '.', { label: `fastcheck:${c.name}` })).status !== 0) red.push(c.name);
  }
  return red;
}

// --- phase close ------------------------------------------------------------

function phaseClosed(phaseId: string): boolean {
  return journalEntries().some(j => j.kind === 'phase-close' && j.subject === phaseId);
}

async function closePhase(ctx: CampaignContext, phaseId: string): Promise<void> {
  const b = backlog();
  const phase = b.phases.find(p => p.id === phaseId)!;
  const closed = b.tickets.filter(t => t.phase === phaseId && t.status === 'closed');

  const results: { name: string; ok: boolean; tail: string }[] = [];
  for (const g of phase.gate ?? []) {
    tui.log(`phase ${phaseId} gate: ${g.name}…`);
    const r = await shAsync(g.cmd, '.', { label: `gate:${phaseId}:${g.name}` });
    results.push({ name: g.name, ok: r.status === 0, tail: (r.stdout + r.stderr).slice(-1500) });
  }
  const red = results.filter(r => !r.ok);

  if (red.length) {
    backlogWrite(['note', '--kind', 'gate-red', '--subject', phaseId,
      '--body', `gate red: [${red.map(r => r.name).join(', ')}]`]);
    await triage({
      kind: 'phase-gate-red', phase: phaseId, results,
      closedTickets: closed.map(t => t.id),
      instruction: 'Spawn a repair ticket carrying this evidence (origin "repair: phase gate red after <ids>"). The escaped-bug rule applies: the repair must also strengthen whatever check let this through.',
    });
    if (!backlog().tickets.some(t => t.phase === phaseId && !['closed', 'decomposed'].includes(t.status))) {
      escalate(`phase ${phaseId} gate red and triage produced no repair ticket`, results);
    }
    return;
  }

  const re = (await agent<ReintegrateVerdict>({
    prompt: renderPrompt('reintegrate', {
      phase,
      specSection: ctx.spec,
      tickets: closed.map(t => ({ id: t.id, title: t.title, acceptance: t.acceptance, files: t.files })),
      outOfScope: b.outOfScope ?? [],
    }),
    models: MODELS.reintegrate,
    schema: REINTEGRATE,
    tools: 'Read,Glob,Grep',
    label: `reintegrate:${phaseId}`,
  })).output;

  if (re.tripwire) escalate(`phase ${phaseId} crossed out-of-scope tripwire: ${re.tripwire}`);
  if (!re.composes) {
    const repairs = renumber(re.repairs);
    if (!repairs.length) escalate(`phase ${phaseId} does not compose and reintegration proposed no repairs: ${re.notes}`);
    backlogWrite(['add', '-'], repairs);
    backlogWrite(['note', '--kind', 'reintegration', '--subject', phaseId,
      '--body', `does not compose: ${re.notes}; repairs [${repairs.map(t => t.id).join(', ')}]`]);
    return;
  }

  backlogWrite(['note', '--kind', 'phase-close', '--subject', phaseId,
    '--body', `gate green, composes: ${re.notes}`, '--data', JSON.stringify({ gate: results.map(r => r.name) })]);
  for (const t of closed) deleteBranch(t.id); // green phase — bisection window over
  tui.log(`■ phase ${phaseId} closed`);
}

// --- reviewer: the scheduled substitute for ambient attention ---------------

async function runReview(ctx: CampaignContext): Promise<void> {
  const entries = journalEntries();
  const lastReview = [...entries].reverse().find(j => j.kind === 'review');
  const since = entries.filter(j => (j.seq ?? 0) > (lastReview?.seq ?? 0));
  if (since.length < 3) return;

  const res = (await agent<ReviewerVerdict>({
    prompt: renderPrompt('reviewer', {
      outOfScope: backlog().outOfScope ?? [],
      backlogSummary: backlogSummary(),
      journal: since.slice(-120),
    }),
    models: MODELS.reviewer,
    schema: REVIEWER,
    tools: 'Read,Glob,Grep',
    label: 'reviewer',
  })).output;

  for (const p of res.proposals) {
    if (p.type === 'escalate') escalate(`reviewer: ${p.reason}`);
    try {
      if (p.type === 'note') backlogWrite(['note', '--kind', p.kind ?? 'review-note', '--subject', p.subject ?? 'campaign', '--body', p.body ?? '']);
      if (p.type === 'ticket' && p.ticket) backlogWrite(['add', '-'], renumber([p.ticket]));
      if (p.type === 'sharpen') backlogWrite(['update', p.ticketId!, '-', '--note', p.note ?? 'reviewer'], p.patch ?? {});
    } catch (e: any) {
      backlogWrite(['note', '--kind', 'review-refused', '--subject', p.ticketId ?? p.type, '--body', e.message]);
    }
  }
  backlogWrite(['note', '--kind', 'review', '--subject', 'campaign', '--body', res.summary]);
}

// --- resume: stale in-flight reconciliation ---------------------------------

async function reconcileStale(ctx: CampaignContext, workers: Workers): Promise<void> {
  const stale = backlog().tickets.filter(t => t.status === 'in-flight' && !workers.has(t.id));
  for (const t of stale) {
    const dispatchEntry = [...journalEntries()].reverse()
      .find(j => j.subject === t.id && j.data?.baseSha);
    const wt = attachWorktree(t.id);
    if (!wt || !dispatchEntry) {
      backlogWrite(['set-status', t.id, 'vetted', '--note', 'stale in-flight on resume; no durable work found']);
      if (wt) removeWorktree(t.id);
      deleteBranch(t.id);
      continue;
    }
    // Durable work survived the dead session — verify it like any result.
    await judgeReturn(ctx, t.id, { dir: wt.dir, baseSha: dispatchEntry.data.baseSha },
      'resumed: worker session lost, branch survived — judge on the evidence alone',
      { workerTokens: 0, workerSeconds: 0, workerCostUsd: 0, model: '' });
  }
}
