// Stage 2 — the drive. Deterministic spine, delegated judgment: the loop
// asks the frontier what is true, scripts what has one right answer, and
// spawns a fresh-context agent for every verdict. The coordinator itself
// never judges a diff — context-poisoning is structural, not a discipline.

import { backlog, backlogWrite, ticket } from './backlog.ts';
import type { Ticket } from './backlog.ts';
import { journalEntries, journalTail } from './journal.ts';
import { shAsync, readLearnings } from './state.ts';
import type { CampaignContext } from './state.ts';
import { frontier, isInfraAttempt } from './frontier.ts';
import { verify, flakeProbe } from './verify.ts';
import type { VerifyVerdict, FlakeVerdict } from './verify.ts';
import { agent, renderPrompt, AgentError } from '../agent/agent.ts';
import { available } from '../agent/engine.ts';
import type { AgentResult } from '../agent/agent.ts';
import { MODELS } from './models.ts';
import { WORKER, REVIEW, SWEEP } from '../agent/schemas.ts';
import type { WorkerVerdict, ReviewVerdict, SweepVerdict, Check } from '../agent/schemas.ts';
import { createWorktree, attachWorktree, removeWorktree, deleteBranch, mergeBranch, mainSha } from './worktree.ts';
import { recover, renumber, backlogSummary } from './recover.ts';
import { escalate, park, parkedSummary, gateParked, Escalation } from './escalate.ts';
import * as tui from '../tui/tui.ts';
import { control } from '../tui/control.ts';

const SWEEP_EVERY = 5;
const WORKER_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const WALL_RECOVER_BUDGET = 2; // distinct recover attempts on a ticket's merit wall before it parks to the human
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
const hasOpen = () => backlog().tickets.some(t => t.status === 'open');
const isIdle = (workers: Workers) => workers.size === 0;

// Stage 2 — the drive. One event loop: each pass reads the frontier once into
// named locals, walks the priority ladder those locals feed, takes one action,
// and loops. The one rung that changes state mid-pass (frontier repair) re-reads
// the frontier before the rungs below it run.
// reconcileStale runs once on resume, before the first pass — surviving
// in-flight work is judged like any other result.
//
// The whole body sits inside the crash membrane — the universal else, error
// edition. An unenumerated throw anywhere in a pass is an anomaly like any
// other: journal it, hand it to a fresh recover agent, keep driving. The same
// error twice is a missing arm, not a flake — that escalates. Escalations pass
// through untouched: they are the honest exit, not a crash.
export async function drive(ctx: CampaignContext): Promise<'complete' | 'awaiting-human'> {
  const workers: Workers = new Map();
  let closesSinceSweep = 0;
  let reconciled = false;
  let lastCrash: string | null = null;
  const handledProblemSigs = new Set<string>(); // frontier problem-sets already handed to recover
  const wallRecoveries = new Map<string, number>(); // ticket → recover interventions spent on its merit wall

  while (true) {
    try {
      if (!reconciled) { await reconcileStale(ctx, workers); reconciled = true; }

      if (control.forceSweep) { // operator asked from the dashboard
        control.forceSweep = false;
        await runSweep(ctx);
        closesSinceSweep = 0;
      }

      let { problems, cycles, capped, stuck, complete, dispatchable } = frontier();

      if (problems.length || cycles.length) {
        // Try to resolve a given problem-set once; if it survives, it's parked —
        // don't re-attempt it every pass. Healthy tickets still dispatch below;
        // the graceful-stop check surfaces the residue when nothing else remains.
        const sig = JSON.stringify({ problems, cycles });
        if (!handledProblemSigs.has(sig)) {
          handledProblemSigs.add(sig);
          await recover({ kind: 'frontier-problems', problems, cycles });
          ({ problems, cycles, capped, stuck, complete, dispatchable } = frontier());
        }
      }

      if (capped.length || stuck.length) {
        // A merit wall is a decision, not a dead end: hand it to recover, which
        // reads the attempt hypotheses and fixes the campaign's definition at the
        // root — a check that never matched the DoD, a contract that contradicts
        // the delivered schema, an under-built dependency (repair ticket +
        // rewire) — then resets the stale wall so the corrected contract gets a
        // fresh run. Recover gets WALL_RECOVER_BUDGET distinct attempts (a fix
        // that doesn't hold means the diagnosis was wrong — try a different one)
        // before the wall is conceded to the human as a park. Either way the
        // ticket leaves `ready`, so the loop keeps driving everything disjoint.
        for (const w of [...capped, ...stuck]) {
          const t = ticket(w.ticket);
          const last = t.attempts?.[t.attempts.length - 1];
          const detail = `${w.ticket} "${t.title}" — ${t.attempts?.length ?? 0} attempts`
            + (last?.hypothesis ? `; last: ${last.hypothesis.slice(0, 200)}` : '');
          const spent = wallRecoveries.get(w.ticket) ?? 0;
          if (spent >= WALL_RECOVER_BUDGET) {
            // recover spent its budget of distinct fixes and it still walls —
            // genuinely the human's now. Park it (graceful drain reports it).
            park(`attempt wall — ${spent} recovery attempt(s) exhausted: ${detail}`, { ticketId: w.ticket });
            continue;
          }
          wallRecoveries.set(w.ticket, spent + 1);
          await recover({
            kind: 'attempt-wall', ticketId: w.ticket, attempts: t.attempts ?? [], recoveryAttempt: spent + 1,
            instruction: `This ticket failed its own checks repeatedly. Read every attempt hypothesis and find the ROOT cause in the campaign definition — a check that never matched the stated DoD, an acceptance clause that contradicts a delivered/closed dependency, a missing or under-built dependency, or a footprint too small to satisfy the acceptance. Fix it at the source within jurisdiction: amend the ticket contract (with resetAttempts:true, since the prior failures were against the old contract), author a repair ticket for an under-built dependency and rewire this ticket onto it, or correct the gate. Never weaken a named invariant or the acceptance to force green.${spent > 0 ? ' A PRIOR recovery already changed this ticket and it STILL walled — that diagnosis was wrong or incomplete, so find a DIFFERENT root cause; do not repeat the previous fix.' : ''} Park only if the fix is genuinely a human scope/security decision the locked spec does not answer.`,
          }, { ticketId: w.ticket });
        }
        continue; // re-read the frontier — recovered tickets re-dispatch, parked ones are gone
      }

      if (complete && isIdle(workers)) {
        const verdict = await tryComplete();
        if (verdict) return verdict; // gate green → retrospective, or parked → human
        continue; // gate just ran (repairs spawned, or newly green) — re-read
      }

      if (!control.paused) {
        for (const id of dispatchable) {
          if (workers.size >= control.workerCap) break;
          if (!workers.has(id)) dispatch(ctx, workers, id);
        }
      }

      if (isIdle(workers)) {
        // No work in flight and nothing dispatched: either the graph is stuck
        // or state is wedged. Never report done over live tickets.
        if (complete) {
          const verdict = await tryComplete();
          if (verdict) return verdict;
          continue;
        }
        if (control.paused) { await idle(); continue; } // operator pause, not a stall
        await recover({ kind: 'stalled', frontier: frontier() }); // full snapshot; locals omit ready/inFlight/counts
        const after = frontier();
        const canProgress = after.dispatchable.length > 0 || hasOpen() || after.complete;
        if (canProgress) continue;
        // Nothing autonomous left, and it's not completion — everything the loop
        // could resolve has run; what remains is a decision genuinely the
        // human's. This is a graceful PAUSE, not a stop: state is intact and
        // `loop resume` continues. `index` renders the deferred-decision report;
        // returning 'awaiting-human' keeps it out of retrospective's close path.
        const parked = parkedSummary();
        backlogWrite(['note', '--kind', 'awaiting-human', '--subject', 'campaign',
          '--body', `no autonomous work remains — parked tickets [${parked.tickets.join(', ') || 'none'}]${parked.gateParked ? ', campaign gate parked' : ''}. Resolve and \`loop resume\`.`]);
        tui.log(`■ awaiting human — tickets [${parked.tickets.join(', ')}]${parked.gateParked ? ' + campaign gate' : ''}`);
        return 'awaiting-human';
      }

      const done = await Promise.race([...workers.values()].map(w => w.promise));
      const meta = workers.get(done.id)!;
      workers.delete(done.id);
      if (await settle(ctx, done, meta)) closesSinceSweep++;
      if (closesSinceSweep >= SWEEP_EVERY) {
        await runSweep(ctx);
        closesSinceSweep = 0;
      }
    } catch (e: any) {
      if (e instanceof Escalation) throw e;
      const sig = String(e.message ?? e).slice(0, 300);
      if (sig === lastCrash) escalate(`coordinator error repeated — needs a real arm: ${sig}`, { stack: e.stack });
      lastCrash = sig;
      tui.log(`⚠ coordinator error → recover: ${sig}`);
      try {
        backlogWrite(['note', '--kind', 'coordinator-error', '--subject', 'drive',
          '--body', `${sig}\n${(e.stack ?? '').slice(0, 1500)}`]);
      } catch { /* journaling failed; recover below still gets the error */ }
      try {
        await recover({ kind: 'coordinator-error', error: sig, stack: (e.stack ?? '').slice(0, 1500) });
      } catch (t: any) {
        if (t instanceof Escalation) throw t;
        escalate(`coordinator error, and recover on it failed too: ${sig}`, { recoverError: t.message });
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

  // Model selection is centralised in models.ts. The worker chain doubles as an
  // escalation ladder: this ticket's Nth merit failure starts it at the Nth rung
  // (workerChain), so a proven-hard ticket climbs terra → sol → opus.
  const promise: Promise<WorkerDone> = agent<WorkerVerdict>({
    prompt,
    models: workerChain(t),
    schema: WORKER,
    cwd: dir,
    bypassPermissions: true,
    timeoutMs: WORKER_TIMEOUT_MS,
    label: `worker:${id}`,
  }).then(res => ({ id, res }), (err: AgentError) => ({ id, err }));

  workers.set(id, { promise, dir, branch, baseSha });
  // Name the model that will actually be tried first — the preference head is a
  // lie when its engine isn't installed; agent() logs any later fall-through.
  const chain = workerChain(t);
  const lead = chain.filter(available)[0] ?? chain[0];
  tui.log(`⇢ dispatched ${id} (${lead}): ${t.title}`);
}

// The worker chain is an escalation ladder (models.ts): a ticket's Nth *merit*
// failure starts it one rung deeper, so a proven-hard ticket climbs the tiers
// instead of retrying the light model forever. Infra deaths (worker-channel,
// merge-conflict) don't advance it — a dead session isn't evidence the work is
// hard. Derived, not stored: the rung is just the merit-attempt count, clamped
// to the strongest. Within an attempt agent() still walks the remaining rungs
// on an engine failure, so a fallback is taking the next rung early.
//
// Accepted scar: the top rung (opus) puts the worker on the same engine as the
// judge (judge leads opus), so a thrice-failed ticket loses author≠judge engine
// independence on that last attempt. Deliberate — by the strongest rung, getting
// the ticket built outweighs an independent grader, and it's the final autonomous
// try regardless.
function workerChain(t: Ticket): string[] {
  const merit = (t.attempts ?? []).filter(a => !isInfraAttempt(a)).length;
  return MODELS.worker.slice(Math.min(merit, MODELS.worker.length - 1));
}

// --- settle: verify → ticket-review → apply --------------------------------

async function settle(ctx: CampaignContext, done: WorkerDone, meta: WorkerMeta): Promise<boolean> {
  const { id } = done;

  if (done.err) {
    // Infra, not merit: the worker never rendered a verdict on the ticket — its
    // session died or the operator killed it. --infra keeps it off the merit
    // wall so a flaky engine (or a usage-limit stretch) can't exhaust the
    // ticket's real budget; the separate infraCap still bounds a dead engine.
    backlogWrite(['attempt', id, '--failed', 'worker-channel', '--infra',
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
      ...c, origin: `decomposed from ${id}`,
    })));
    if (!children.length) {
      await recover({ kind: 'toobig-without-split', ticketId: id });
    } else {
      backlogWrite(['decompose', id, '-', '--note', 'worker declared tooBig'], children);
    }
    removeWorktree(id); deleteBranch(id);
    return false;
  }

  if (reply.blocked) {
    backlogWrite(['set-status', id, 'parked', '--note', `worker blocked: ${reply.reason}`,
      '--data', JSON.stringify(telemetry)]);
    removeWorktree(id); deleteBranch(id);
    await recover({
      kind: 'worker-blocked', ticketId: id, reason: reply.reason,
      instruction: 'First test whether the block is a defect in a completed dependency: read the cited spec section and the delivered code. If a merged/closed ticket was built wrong or under-built against the locked spec, author a repair ticket (origin "repair: <what> under-built vs spec §…"), scoped to fix it at source, and rewire this ticket onto it — the escaped-bug rule applies, exactly as campaign-gate-red does. Escalate only if the block needs a decision the locked spec does not already answer.',
    }, { ticketId: id });
    return false;
  }

  return reviewReturn(ctx, id, meta, reply.summary ?? '(no summary)', telemetry);
}

// Scripted verification, then the ticket-review verdict loop. The review reads
// the diff cold for cheats itself — there is no separate gaming pre-screen.
// Also the resume path for a surviving branch whose worker session is gone.
export async function reviewReturn(ctx: CampaignContext, id: string, meta: { dir: string; baseSha: string }, workerSummary: string, telemetry: Telemetry): Promise<boolean> {
  tui.log(`verifying ${id}…`);
  let v = await verify({ id, dir: meta.dir, base: meta.baseSha });
  const b = backlog();
  const learnings = readLearnings();

  let probeResult: FlakeVerdict | null = null;
  for (let round = 0; round < 4; round++) {
    const t = ticket(id);
    const verdict = (await agent<ReviewVerdict>({
      prompt: renderPrompt('review', {
        ticket: t,
        workerSummary,
        verifyResult: v,
        diffPath: v.diff,
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
        if (probeResult) {
          park(`judge asked for a second flake probe on ${id}`, { ticketId: id });
          removeWorktree(id); deleteBranch(id);
          return false;
        }
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
        continue; // re-review against the corrected contract; the diff re-read happens next round
      }

      case 'escalate':
        await recover({ kind: 'judge-escalate', ticketId: id, reason: verdict.reason }, { ticketId: id });
        removeWorktree(id); deleteBranch(id);
        return false;
    }
  }
  await recover({ kind: 'judge-no-converge', ticketId: id }, { ticketId: id });
  removeWorktree(id); deleteBranch(id);
  return false;
}

function recordAttempt(id: string, v: VerifyVerdict, verdict: ReviewVerdict, telemetry: Telemetry): void {
  const failing = verdict.failing?.length ? verdict.failing : (v.failing.length ? v.failing : ['judge-rejected']);
  backlogWrite(['attempt', id,
    '--failed', failing.join(','),
    '--hypothesis', verdict.hypothesis ?? verdict.verdict,
    '--fix', verdict.fixNote ?? '',
    '--data', JSON.stringify(telemetry)]);
}

// Check amendments ride backlog-write's legal transitions: in-flight → open
// (update only touches an open ticket), then patch the checks — the ticket is
// back in the dispatch queue against its corrected contract.
function amendChecks(id: string, checks: Check[] | undefined, note: string): void {
  backlogWrite(['set-status', id, 'open', '--note', 'check amendment']);
  backlogWrite(['update', id, '-', '--note', note], { acceptanceChecks: checks });
}

async function closeTicket(id: string, meta: { dir: string; baseSha: string }, v: VerifyVerdict, verdict: ReviewVerdict, telemetry: Telemetry, workerSummary: string): Promise<boolean> {
  const shaBeforeMerge = mainSha();
  let merged = mergeBranch(id);
  if (!merged.ok && merged.dirty) {
    // A dirty mainline blocks every merge identically — repairing it keeps a
    // judged-close branch that the failed-attempt path below would burn.
    await recover({ kind: 'dirty-mainline', ticketId: id, conflict: merged.conflict });
    merged = mergeBranch(id);
  }
  if (!merged.ok) {
    // Reject rather than accept-and-revert: a conflicted merge is a failed
    // attempt, and a fresh dispatch starts from the moved mainline.
    // Infra, not merit: the diff was judged closeable and only lost a race with
    // a moved mainline. Rebuilding against HEAD is mechanical, so it must not
    // burn the merit budget — --infra keeps it off the wall.
    backlogWrite(['attempt', id, '--failed', 'merge-conflict', '--infra',
      '--hypothesis', `mainline moved; merge conflict: ${merged.conflict.slice(0, 300)}`,
      '--fix', 'rebuild against current HEAD', '--data', JSON.stringify(telemetry)]);
    removeWorktree(id); deleteBranch(id);
    return false;
  }

  if (ticket(id).status !== 'in-flight') backlogWrite(['set-status', id, 'in-flight', '--note', 'closing']);
  backlogWrite(['close', id, '--evidence', v.evidence,
    '--note', (verdict.note || workerSummary).slice(0, 500),
    '--data', JSON.stringify(telemetry)]);
  removeWorktree(id); // branch survives until the campaign gate is green — bisection needs it
  tui.log(`✓ closed ${id}`);

  // The old batch merge's free integration gate: if mainline moved past this
  // worker's base, the fast tier re-runs on the merged tree.
  if (shaBeforeMerge !== meta.baseSha) {
    tui.log(`integration check after ${id} (mainline moved)…`);
    const red = await runFastChecks();
    if (red.length) {
      backlogWrite(['note', '--kind', 'integration-red', '--subject', id,
        '--body', `fast tier red after merging ${id}: [${red.join(', ')}]`]);
      await recover({ kind: 'integration-red', ticketId: id, failing: red });
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

// --- campaign gate: the slow suite, run once when all ticket work drains -----

// The terminal verdict, or null to keep driving. Called only when the frontier
// is complete and idle. The gate (e2e / anything needing a live server) runs
// once here on the whole merged tree — not per ticket. A red gate is an escaped
// bug: recover spawns a repair ticket (loop keeps driving) or parks it
// (drains to the human). Green — or no gate defined — is completion.
async function tryComplete(): Promise<'complete' | 'awaiting-human' | null> {
  if (gateParked()) return 'awaiting-human'; // gate red, recover couldn't fix it
  if (gateGreen()) return 'complete';        // green, or no slow suite to run
  await closeCampaignGate();                 // run it: green journals close, red spawns repairs / parks
  return null;                               // re-read the frontier next pass
}

// The gate is green when it last ran green and no ticket has closed or been
// added since — coverage/repair work after a green gate must re-clear it. No
// gate configured collapses completion to "all tickets drained". Exported so
// retrospective can assert the invariant it depends on (drive never returns
// 'complete' over an unrun or stale gate).
export function gateGreen(): boolean {
  const b = backlog();
  if (!b.gate?.length) return true;
  const entries = journalEntries();
  const lastClose = [...entries].reverse().find(j => j.kind === 'campaign-gate-close');
  if (!lastClose) return false;
  return !entries.some(j => (j.seq ?? 0) > (lastClose.seq ?? 0) && (j.kind === 'close' || j.kind === 'add'));
}

async function closeCampaignGate(): Promise<void> {
  const b = backlog();
  const results: { name: string; ok: boolean; tail: string }[] = [];
  for (const g of b.gate ?? []) {
    tui.log(`campaign gate: ${g.name}…`);
    const r = await shAsync(g.cmd, '.', { label: `gate:${g.name}` });
    results.push({ name: g.name, ok: r.status === 0, tail: (r.stdout + r.stderr).slice(-1500) });
  }
  const red = results.filter(r => !r.ok);

  if (red.length) {
    backlogWrite(['note', '--kind', 'gate-red', '--subject', 'campaign-gate',
      '--body', `gate red: [${red.map(r => r.name).join(', ')}]`]);
    await recover({
      kind: 'campaign-gate-red', results,
      closedTickets: b.tickets.filter(t => t.status === 'closed').map(t => t.id),
      instruction: 'A red campaign gate is one of two things — decide which by reading the failures. (1) A real escaped bug: spawn a repair ticket whose checks also strengthen what let it through. (2) A gate-scoping fault (the gate runs the wrong things, or contends on shared state): narrow/serialise the gate to what it should verify and RUN the corrected gate to confirm it is green before proposing it. Park (resolved=false) only if neither holds — a genuine defect needing a human scope call.',
    }, { subject: 'campaign-gate' });
    return; // recover spawned repairs (re-runs next drain) or parked it (gateParked drains to human)
  }

  backlogWrite(['note', '--kind', 'campaign-gate-close', '--subject', 'campaign-gate',
    '--body', `gate green: [${results.map(r => r.name).join(', ')}]`, '--data', JSON.stringify({ gate: results.map(r => r.name) })]);
  tui.log('■ campaign gate green');
}

// --- sweep: the scheduled substitute for ambient attention ------------------

async function runSweep(ctx: CampaignContext): Promise<void> {
  const entries = journalEntries();
  const lastSweep = [...entries].reverse().find(j => j.kind === 'sweep');
  const since = entries.filter(j => (j.seq ?? 0) > (lastSweep?.seq ?? 0));
  if (since.length < 3) return;

  const res = (await agent<SweepVerdict>({
    prompt: renderPrompt('sweep', {
      outOfScope: backlog().outOfScope ?? [],
      backlogSummary: backlogSummary(),
      journal: since.slice(-120),
    }),
    models: MODELS.sweep,
    schema: SWEEP,
    tools: 'Read,Glob,Grep',
    label: 'sweep',
  })).output;

  for (const p of res.proposals) {
    if (p.type === 'escalate') { park(`sweep: ${p.reason}`); continue; }
    try {
      if (p.type === 'note') backlogWrite(['note', '--kind', p.kind ?? 'sweep-note', '--subject', p.subject ?? 'campaign', '--body', p.body ?? '']);
      if (p.type === 'ticket' && p.ticket) backlogWrite(['add', '-'], renumber([p.ticket]));
      if (p.type === 'sharpen') backlogWrite(['update', p.ticketId!, '-', '--note', p.note ?? 'sweep'], p.patch ?? {});
      if (p.type === 'gate' && p.gates?.length) backlogWrite(['gate', '-', '--note', p.note ?? 'sweep'], p.gates);
    } catch (e: any) {
      backlogWrite(['note', '--kind', 'sweep-refused', '--subject', p.ticketId ?? p.type, '--body', e.message]);
    }
  }
  backlogWrite(['note', '--kind', 'sweep', '--subject', 'campaign', '--body', res.summary]);
}

// --- resume: stale in-flight reconciliation ---------------------------------

async function reconcileStale(ctx: CampaignContext, workers: Workers): Promise<void> {
  const stale = backlog().tickets.filter(t => t.status === 'in-flight' && !workers.has(t.id));
  for (const t of stale) {
    const dispatchEntry = [...journalEntries()].reverse()
      .find(j => j.subject === t.id && j.data?.baseSha);
    const wt = attachWorktree(t.id);
    if (!wt || !dispatchEntry) {
      backlogWrite(['set-status', t.id, 'open', '--note', 'stale in-flight on resume; no durable work found']);
      if (wt) removeWorktree(t.id);
      deleteBranch(t.id);
      continue;
    }
    // Durable work survived the dead session — verify it like any result.
    await reviewReturn(ctx, t.id, { dir: wt.dir, baseSha: dispatchEntry.data.baseSha },
      'resumed: worker session lost, branch survived — judge on the evidence alone',
      { workerTokens: 0, workerSeconds: 0, workerCostUsd: 0, model: '' });
  }
}
