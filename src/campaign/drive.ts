// Stage 2 — the drive. Deterministic spine, delegated judgment: the loop
// asks the frontier what is true, scripts what has one right answer, and
// spawns a fresh-context agent for every verdict. The coordinator itself
// never judges a diff — context-poisoning is structural, not a discipline.

import { backlog, backlogWrite, ticket } from './backlog.ts';
import type { Ticket } from './backlog.ts';
import { amendGate, GATE_RED } from './gate.ts';
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
import { withMainline } from './mainline.ts';
import { recover, renumber, backlogSummary } from './recover.ts';
import { escalate, park, parkedSummary, gateParked, GATE_SUBJECT, Escalation } from './escalate.ts';
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

// The two channels a pass can wake on. A worker finishing is not the end of the
// ticket — verify, up to four review rounds, a flake probe and the merge all
// come after it — so the settle runs as its own channel rather than inline,
// and the pass that started it goes straight back to dispatching.
type LoopEvent =
  | { kind: 'worker'; done: WorkerDone }
  | { kind: 'settled'; id: string; closed?: boolean; err?: unknown };
type Settles = Map<string, Promise<LoopEvent>>;

// Two predicates the ladder leans on more than once; every other rung reads
// its fact inline off the destructured frontier below.
const hasOpen = () => backlog().tickets.some(t => t.status === 'open');
// A settling ticket is still live work: its diff is unjudged and its branch
// unmerged, so completion and the stall arm must both wait for it.
const isIdle = (workers: Workers, settles: Settles) => workers.size === 0 && settles.size === 0;

// Stage 2 — the drive. One event loop: each pass reads the frontier once into
// named locals, walks the priority ladder those locals feed, takes one action,
// and loops. The one rung that changes state mid-pass (frontier repair) re-reads
// the frontier before the rungs below it run.
// reconcileStale runs once on resume, before the first pass — surviving
// in-flight work is judged like any other result.
//
// A pass ends by waking on either of two channels: a worker returning, or a
// settle finishing. They are separate because the worker is the short half —
// everything that decides whether the ticket closed (verify, up to four review
// rounds, a flake probe, the merge, the integration check) happens after it,
// and running that inline held the whole ladder, so the other workers finished
// into an idle loop. Settling now runs concurrently with dispatch and with
// other settles, which is why the shared checkout needs mainline.ts.
//
// The whole body sits inside the crash membrane — the universal else, error
// edition. An unenumerated throw anywhere in a pass is an anomaly like any
// other: journal it, hand it to a fresh recover agent, keep driving. The same
// error twice is a missing arm, not a flake — that escalates. Escalations pass
// through untouched: they are the honest exit, not a crash.
export async function drive(ctx: CampaignContext): Promise<'complete' | 'awaiting-human'> {
  const workers: Workers = new Map();
  const settles: Settles = new Map();
  let closesSinceSweep = 0;
  let reconciled = false;
  let lastCrash: string | null = null;
  const handledProblemSigs = new Set<string>(); // frontier problem-sets already handed to recover
  const handledStallSigs = new Set<string>();   // wedged frontiers already handed to recover
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
        //
        // This budget is the wall's own, and it also escalates the prompt on the
        // second pass. recover.ts holds a matching campaign-wide budget per
        // anomaly key that survives a resume; the two agree on the number, and
        // this one is reached first because it counts before the call.
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
            instruction: `This ticket failed its own checks repeatedly. Read every attempt hypothesis and find the ROOT cause in the campaign definition — a check that never matched the stated DoD, an acceptance clause that contradicts a delivered/closed dependency, a missing or under-built dependency, or a footprint too small to satisfy the acceptance. Fix it at the source within jurisdiction: amend the ticket contract (with resetAttempts:true, since the prior failures were against the old contract), author a repair ticket for an under-built dependency and rewire this ticket onto it, or add a missing merged-tree gate check (only a red gate's own recovery may replace a gate command in force). Never weaken a named invariant or the acceptance to force green.${spent > 0 ? ' A PRIOR recovery already changed this ticket and it STILL walled — that diagnosis was wrong or incomplete, so find a DIFFERENT root cause; do not repeat the previous fix.' : ''} Park only if the fix is genuinely a human scope/security decision the locked spec does not answer.`,
          }, { ticketId: w.ticket });
        }
        continue; // re-read the frontier — recovered tickets re-dispatch, parked ones are gone
      }

      if (complete && isIdle(workers, settles)) {
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

      if (isIdle(workers, settles)) {
        // No work in flight and nothing dispatched: either the graph is stuck
        // or state is wedged. Never report done over live tickets.
        if (complete) {
          const verdict = await tryComplete();
          if (verdict) return verdict;
          continue;
        }
        if (control.paused) { await idle(); continue; } // operator pause, not a stall
        // One recovery per shape of stall, for the same reason the frontier arm
        // above works that way: a recover that parked changed nothing, so the next
        // pass reads the identical wedged frontier and would hand a fresh agent
        // the same campaign again. Every one of them parks, and the human is paged
        // once per pass for a single decision — which is the opposite of what
        // parking is for. The signature is the whole frontier because the whole
        // frontier is derived from the backlog: if any of it moved, something
        // actually happened and this is a different stall.
        const snapshot = frontier(); // full picture; the locals above omit ready/inFlight/counts
        const sig = JSON.stringify(snapshot);
        if (!handledStallSigs.has(sig)) {
          handledStallSigs.add(sig);
          await recover({ kind: 'stalled', frontier: snapshot });
          const after = frontier();
          if (after.dispatchable.length > 0 || hasOpen() || after.complete) continue;
        }
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

      // Both channels, raced together. Whichever fires, the pass ends and the
      // ladder runs again from the top — so a worker handing off to a settle
      // frees its slot for the next dispatch immediately, instead of the loop
      // sitting inside verify → review → merge with its other workers idle.
      const event = await Promise.race<LoopEvent>([
        ...[...workers.values()].map(w => w.promise.then((done): LoopEvent => ({ kind: 'worker', done }))),
        ...settles.values(),
      ]);

      if (event.kind === 'worker') {
        const { done } = event;
        const meta = workers.get(done.id)!;
        workers.delete(done.id);
        // Never rejects: the error rides the envelope, so the losers of every
        // later race can't become unhandled rejections.
        settles.set(done.id, settle(ctx, done, meta).then(
          (closed): LoopEvent => ({ kind: 'settled', id: done.id, closed }),
          (err): LoopEvent => ({ kind: 'settled', id: done.id, err })));
        continue;
      }

      settles.delete(event.id);
      if (event.err) throw event.err; // back to the crash membrane, as when settle ran inline
      if (event.closed) closesSinceSweep++;
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
  const { dir, branch, baseSha, provisioned } = createWorktree(id);
  backlogWrite(['set-status', id, 'in-flight', '--note', `dispatched on ${branch} — ${provisioned}`,
    '--base-sha', baseSha, '--data', JSON.stringify({ baseSha, branch, provisioned })]);

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
    discardBuild(id);
    backlogWrite(['attempt', id, '--failed', 'worker-channel', '--infra',
      '--hypothesis', done.err.killed
        ? 'killed by the operator from the dashboard'
        : `worker session died: ${done.err.message.slice(0, 300)}`,
      '--fix', done.err.killed
        ? 'not a code failure — redispatches when the frontier next offers it'
        : 'fresh dispatch; investigate if it recurs']);
    return false;
  }

  const reply = done.res.output ?? {};
  const telemetry: Telemetry = { workerTokens: done.res.tokens, workerSeconds: done.res.seconds, workerCostUsd: done.res.costUsd, model: done.res.model };

  if (reply.tooBig) {
    discardBuild(id);
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
    discardBuild(id);
    backlogWrite(['set-status', id, 'parked', '--note', `worker blocked: ${reply.reason}`,
      '--data', JSON.stringify(telemetry)]);
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
        discardBuild(id);
        recordAttempt(id, v, verdict, telemetry);
        return false;

      case 'gamed':
        // Escaped-bug rule: the cheated check gets sharper before re-dispatch.
        discardBuild(id);
        if (verdict.sharpenChecks?.length) amendChecks(id, verdict.sharpenChecks, `gamed: ${verdict.hypothesis ?? ''}`);
        recordAttempt(id, v, verdict, telemetry);
        return false;

      case 'flake-probe': {
        if (probeResult) {
          discardBuild(id);
          park(`judge asked for a second flake probe on ${id}`, { ticketId: id });
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
        discardBuild(id);
        await recover({ kind: 'judge-escalate', ticketId: id, reason: verdict.reason }, { ticketId: id });
        reopenIfStranded(id, 'judge escalated and recover returned without moving the ticket');
        return false;
    }
  }
  discardBuild(id);
  await recover({ kind: 'judge-no-converge', ticketId: id }, { ticketId: id });
  reopenIfStranded(id, 'review did not converge and recover returned without moving the ticket');
  return false;
}

// A settle that isn't closing the ticket throws its build away, and does it
// BEFORE the write that hands the ticket back — never after.
//
// Ordering, not adjacency, is what makes this safe. Settles run concurrently
// with dispatch, so between a ticket going `open` and its worktree being
// destroyed the dispatch rung may run and re-cut a worktree this settle still
// owns. Writing first left a window whose size depended on whether the next
// statement awaited: three arms here hand the ticket back from inside recover,
// which awaits between its own mutations, so that window was real. Discarding
// first leaves no window at all — a ticket is only ever offered for dispatch
// after the build behind it is already gone — and no future arm can reopen one
// by growing an await, because there is no longer an ordering to preserve.
function discardBuild(id: string): void {
  removeWorktree(id);
  deleteBranch(id);
}

// Every handoff to recover that discarded the build has already destroyed the
// ticket's worktree and branch, so an in-flight status afterwards describes a
// worker that no longer exists. Recover normally moves the ticket itself (a
// set-status action, or the park its target implies); this catches the case
// where it resolved the anomaly some other way and never touched the status —
// otherwise the ticket sits in-flight, undispatchable, until a restart's
// reconcileStale notices. A no-op whenever recover did its own bookkeeping.
function reopenIfStranded(id: string, why: string): void {
  if (ticket(id).status !== 'in-flight') return;
  backlogWrite(['set-status', id, 'open', '--note', `${why}; no worker or branch remains`]);
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

// What one landing did to the shared checkout: refused the merge, or took it
// and reported what the integration check saw afterwards.
type Landing =
  | { ok: false; dirty: boolean; conflict: string }
  | { ok: true; integrationRed: string[] };

async function closeTicket(id: string, meta: { dir: string; baseSha: string }, v: VerifyVerdict, verdict: ReviewVerdict, telemetry: Telemetry, workerSummary: string): Promise<boolean> {
  let landed = await withMainline(() => land(id, meta, v, verdict, telemetry, workerSummary));

  if (!landed.ok && landed.dirty) {
    // A dirty mainline blocks every merge identically — repairing it keeps a
    // judged-close branch that the failed-attempt path below would burn. The
    // repair takes the mainline itself, so it runs between two landings rather
    // than inside one; a landing that refused the merge changed nothing, which
    // is what makes the retry safe.
    const conflict = landed.conflict;
    await recover({ kind: 'dirty-mainline', ticketId: id, conflict });
    landed = await withMainline(() => land(id, meta, v, verdict, telemetry, workerSummary));
  }

  if (!landed.ok) {
    // Reject rather than accept-and-revert: a conflicted merge is a failed
    // attempt, and a fresh dispatch starts from the moved mainline.
    // Infra, not merit: the diff was judged closeable and only lost a race with
    // a moved mainline. Rebuilding against HEAD is mechanical, so it must not
    // burn the merit budget — --infra keeps it off the wall.
    discardBuild(id);
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

// The shared-checkout half of closing a ticket, start to finish as one unit:
// merge the branch onto mainline, record the close, and re-run the fast tier if
// mainline moved. It runs under the mainline lock because the integration check
// is a claim about a specific tree — another ticket merging while it runs would
// make it a claim about no tree at all, filed against this one. Repairs belong
// to the caller: they need the lock too, and it is not reentrant.
async function land(id: string, meta: { baseSha: string }, v: VerifyVerdict, verdict: ReviewVerdict, telemetry: Telemetry, workerSummary: string): Promise<Landing> {
  const shaBeforeMerge = mainSha();
  const merged = mergeBranch(id);
  if (!merged.ok) return { ok: false, dirty: merged.dirty, conflict: merged.conflict };

  if (ticket(id).status !== 'in-flight') backlogWrite(['set-status', id, 'in-flight', '--note', 'closing']);
  backlogWrite(['close', id, '--evidence', v.evidence,
    '--note', (verdict.note || workerSummary).slice(0, 500),
    '--data', JSON.stringify(telemetry)]);
  removeWorktree(id); // branch survives until the campaign gate is green — bisection needs it

  // The old batch merge's free integration gate: if mainline moved past this
  // worker's base, the fast tier re-runs on the merged tree.
  if (shaBeforeMerge === meta.baseSha) return { ok: true, integrationRed: [] };
  tui.log(`integration check after ${id} (mainline moved)…`);
  return { ok: true, integrationRed: await runFastChecks() };
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
// added since — coverage/repair work after a green gate must re-clear it. The
// run stamps the backlog counts it measured; comparing them against the
// backlog now is the whole staleness test. No gate configured collapses
// completion to "all tickets drained". Exported so retrospective can assert the
// invariant it depends on (drive never returns 'complete' over an unrun or
// stale gate).
export function gateGreen(): boolean {
  const b = backlog();
  if (!b.gate?.length) return true;
  const run = b.gateState?.lastRun;
  if (run?.result !== 'green') return false;
  return run.tickets === b.tickets.length
    && run.closed === b.tickets.filter(t => t.status === 'closed').length;
}

async function closeCampaignGate(): Promise<void> {
  const b = backlog();
  // The slow suite runs on the shared tree, so it takes the mainline for the
  // duration. Only the run does — the red path below calls recover, which takes
  // the mainline itself.
  const results = await withMainline(async () => {
    const out: { name: string; ok: boolean; tail: string }[] = [];
    for (const g of b.gate ?? []) {
      tui.log(`campaign gate: ${g.name}…`);
      const r = await shAsync(g.cmd, '.', { label: `gate:${g.name}` });
      out.push({ name: g.name, ok: r.status === 0, tail: (r.stdout + r.stderr).slice(-1500) });
    }
    return out;
  });
  const red = results.filter(r => !r.ok);

  if (red.length) {
    backlogWrite(['gate-run', 'red', '--note', `gate red: [${red.map(r => r.name).join(', ')}]`]);
    await recover({
      kind: GATE_RED, results,
      closedTickets: b.tickets.filter(t => t.status === 'closed').map(t => t.id),
      instruction: 'A red campaign gate is one of two things — decide which by reading the failures. (1) A real escaped bug: spawn a repair ticket whose checks also strengthen what let it through. (2) A gate-scoping fault (the gate runs the wrong things, or contends on shared state): narrow/serialise the gate to what it should verify and RUN the corrected gate to confirm it is green before proposing it. Park (resolved=false) only if neither holds — a genuine defect needing a human scope call.',
    }, { subject: GATE_SUBJECT });
    return; // recover spawned repairs (re-runs next drain) or parked it (gateParked drains to human)
  }

  backlogWrite(['gate-run', 'green', '--note', `gate green: [${results.map(r => r.name).join(', ')}]`,
    '--data', JSON.stringify({ gate: results.map(r => r.name) })]);
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
      // Cadence is measured on what's new, but the input is the whole campaign:
      // the patterns this role exists to find (a landmine hitting its third
      // ticket, a check re-sharpened every time) are invisible in a window that
      // holds one instance. Prior sweep summaries are in the log too, so it can
      // see what it already said rather than re-proposing it.
      journal: entries,
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
      // Sweep may add a merged-tree invariant — naming one the per-ticket checks
      // can't hold is exactly what a campaign-level pass is for — but not
      // replace a gate command in force: its toolset is read-only, so it can
      // never have proven the replacement green, and no red gate obliges it to
      // re-scope one. A replacement proposal is refused on the record.
      if (p.type === 'gate' && p.gates?.length) {
        amendGate(p.gates, { by: 'sweep', note: p.note || 'sweep', replacements: 'refuse' });
      }
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
    // Both halves of a resumable dispatch: the worktree on disk, and the base
    // it was cut from (stamped on the ticket at dispatch). Without the base
    // there is nothing to diff the survivor against.
    const wt = attachWorktree(t.id);
    if (!wt || !t.baseSha) {
      discardBuild(t.id); // same order as every other arm, though nothing dispatches yet
      backlogWrite(['set-status', t.id, 'open', '--note', 'stale in-flight on resume; no durable work found']);
      continue;
    }
    // Durable work survived the dead session — verify it like any result.
    await reviewReturn(ctx, t.id, { dir: wt.dir, baseSha: t.baseSha },
      'resumed: worker session lost, branch survived — judge on the evidence alone',
      { workerTokens: 0, workerSeconds: 0, workerCostUsd: 0, model: '' });
  }
}
