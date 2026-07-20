// Stage 2 — the drive. Deterministic spine, delegated judgment: the loop
// asks frontier.mjs what is true, scripts what has one right answer, and
// spawns a fresh-context agent for every verdict. The coordinator itself
// never judges a diff — context-poisoning is structural, not a discipline.

import { backlog, backlogWrite, ticket } from './backlog.ts';
import { journalEntries, journalTail } from './journal.ts';
import { frontier, verify, flakeProbe, sh, shAsync, readLearnings } from './state.ts';
import type { CampaignContext, Frontier, VerifyVerdict, FlakeVerdict } from './state.ts';
import { agentRetry, renderPrompt, AgentError } from '../agent/agent.ts';
import type { AgentResult } from '../agent/agent.ts';
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
type DriveState = { closesSinceReview: number };
type Telemetry = { workerTokens: number; workerSeconds: number; workerCostUsd: number };

export async function drive(ctx: CampaignContext): Promise<void> {
  const workers: Workers = new Map();
  const state: DriveState = { closesSinceReview: 0 };
  let reconciled = false;
  let lastCrash: string | null = null;

  // The crash membrane — the universal else, error edition. An unenumerated
  // throw anywhere in a turn is an anomaly like any other: journal it, hand
  // it to a fresh triage agent, keep driving. The same error twice is a
  // missing arm, not a flake — that escalates. Escalations pass through
  // untouched: they are the honest exit, not a crash.
  while (true) {
    try {
      if (!reconciled) { await reconcileStale(ctx, workers); reconciled = true; }
      if (await turn(ctx, workers, state)) return;
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

// One turn of the decision spine. Returns true when the campaign is complete.
async function turn(ctx: CampaignContext, workers: Workers, state: DriveState): Promise<boolean> {
  if (control.forceReview) { // operator asked from the dashboard
    control.forceReview = false;
    await runReview(ctx);
    state.closesSinceReview = 0;
  }

  let f = frontier();

  if (f.problems.length || f.cycles.length) {
    await triage({ kind: 'frontier-problems', problems: f.problems, cycles: f.cycles });
    f = frontier();
    if (f.problems.length || f.cycles.length) escalate('frontier problems persist after triage', f);
  }

  if (f.capBreaches.length || f.thrashBreaches.length) {
    escalate('attempt cap / thrash wall', {
      capBreaches: f.capBreaches,
      thrashBreaches: f.thrashBreaches,
      attempts: [...f.capBreaches, ...f.thrashBreaches].map(x => ({ id: x.ticket, log: ticket(x.ticket).attempts })),
    });
  }

  const unclosed = f.phasesDrained.filter(p => !phaseClosed(p));
  if (unclosed.length) {
    await closePhase(ctx, unclosed[0]!);
    await runReview(ctx); // phase close is a mandatory review checkpoint
    state.closesSinceReview = 0;
    return false;
  }

  if (f.complete && workers.size === 0) return true; // → termination

  if (backlog().tickets.some(t => t.status === 'draft')) {
    await vetDrafts();
    f = frontier();
  }

  if (!control.paused) {
    for (const id of f.dispatchable) {
      if (workers.size >= control.workerCap) break;
      if (!workers.has(id)) dispatch(ctx, workers, id);
    }
  }

  if (workers.size === 0) {
    // No work in flight and nothing dispatched: either the graph is blocked
    // or state is wedged. Never report done over live blocked tickets.
    if (f.complete) return true;
    if (control.paused) { await idle(); return false; } // operator pause, not a stall
    await triage({ kind: 'stalled', frontier: f });
    const f2 = frontier();
    const canProgress = f2.dispatchable.length || f2.phasesDrained.some(p => !phaseClosed(p))
      || backlog().tickets.some(t => t.status === 'draft') || f2.complete;
    if (!canProgress) escalate('stalled: no dispatchable work and triage freed none', f2);
    return false;
  }

  const done = await Promise.race([...workers.values()].map(w => w.promise));
  const meta = workers.get(done.id)!;
  workers.delete(done.id);
  const closed = await settle(ctx, done, meta);
  if (closed) state.closesSinceReview++;
  if (state.closesSinceReview >= REVIEW_EVERY) {
    await runReview(ctx);
    state.closesSinceReview = 0;
  }
  return false;
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

  const promise: Promise<WorkerDone> = agentRetry<WorkerVerdict>({
    prompt,
    model: t.model || 'opus',
    schema: WORKER,
    cwd: dir,
    bypassPermissions: true,
    timeoutMs: WORKER_TIMEOUT_MS,
    label: `worker:${id}`,
  }).then(res => ({ id, res }), (err: AgentError) => ({ id, err }));

  workers.set(id, { promise, dir, branch, baseSha });
  tui.log(`⇢ dispatched ${id} (${t.model || 'opus'}): ${t.title}`);
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
  const telemetry: Telemetry = { workerTokens: done.res.tokens, workerSeconds: done.res.seconds, workerCostUsd: done.res.costUsd };

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
    await triage({ kind: 'worker-blocked', ticketId: id, reason: reply.reason });
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
    const verdict = (await agentRetry<JudgeVerdict>({
      prompt: renderPrompt('judge', {
        ticket: t,
        workerSummary,
        verifyResult: v,
        gamingFlags: gaming.flags.length ? gaming.flags : '(none)',
        probeResult: probeResult ?? '(none ran)',
        attempts: t.attempts?.length ? t.attempts : '(first attempt)',
      }) + riskAppendix(id),
      model: 'opus',
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
  return (await agentRetry<GamingVerdict>({
    prompt: renderPrompt('gaming', {
      ticket: ticket(id),
      outOfScope: b.outOfScope ?? [],
      diffPath,
      gamingLearnings: learnings?.['gaming.md']
        ? `## Cheat shapes observed in past campaigns\n\n${learnings['gaming.md']}`
        : '',
    }),
    model: 'sonnet',
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

  const re = (await agentRetry<ReintegrateVerdict>({
    prompt: renderPrompt('reintegrate', {
      phase,
      specSection: ctx.spec,
      tickets: closed.map(t => ({ id: t.id, title: t.title, acceptance: t.acceptance, files: t.files })),
      outOfScope: b.outOfScope ?? [],
    }),
    model: 'opus',
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

  const res = (await agentRetry<ReviewerVerdict>({
    prompt: renderPrompt('reviewer', {
      outOfScope: backlog().outOfScope ?? [],
      backlogSummary: backlogSummary(),
      journal: since.slice(-120),
    }),
    model: 'opus',
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
      { workerTokens: 0, workerSeconds: 0, workerCostUsd: 0 });
  }
}
