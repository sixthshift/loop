// Stage 2 — the deterministic scheduler. Each pass reads the derived frontier,
// walks one priority ladder, starts eligible ticket lifecycles, then wakes when
// either a worker returns or a ticket settlement finishes. The effectful
// lifecycle behind those events lives in ticket-execution.ts.

import { backlog, backlogWrite, ticket } from './backlog.ts';
import { frontier } from './frontier.ts';
import { recover } from './recover.ts';
import {
  escalate,
  park,
  parkedSummary,
  Escalation,
} from './escalate.ts';
import {
  dispatchTicket,
  settleTicket,
} from './ticket-execution.ts';
import type {
  WorkerDone,
  Workers,
} from './ticket-execution.ts';
import { tryComplete } from './gate-run.ts';
import { runSweep, sweepDue } from './sweep.ts';
import { reconcileStale } from './resume.ts';
import * as tui from '../runtime/reporting.ts';
import { control } from '../runtime/control.ts';

const WALL_RECOVER_BUDGET = 2;
const idle = () => new Promise(resolve => setTimeout(resolve, 1500));

type LoopEvent =
  | { kind: 'worker'; done: WorkerDone }
  | { kind: 'settled'; id: string; err?: unknown };

type Settles = Map<string, Promise<LoopEvent>>;

const hasOpen = () => backlog().tickets.some(ticket => ticket.status === 'open');
const isIdle = (workers: Workers, settles: Settles) =>
  workers.size === 0 && settles.size === 0;

export async function drive(): Promise<'complete' | 'awaiting-human'> {
  const workers: Workers = new Map();
  const settles: Settles = new Map();
  let reconciled = false;
  let lastCrash: string | null = null;
  const handledProblemSigs = new Set<string>();
  const handledStallSigs = new Set<string>();
  const wallRecoveries = new Map<string, number>();

  while (true) {
    try {
      if (!reconciled) {
        await reconcileStale();
        reconciled = true;
      }

      if (control.forceSweep) {
        control.forceSweep = false;
        await runSweep(true);
      } else if (sweepDue()) {
        await runSweep();
      }

      let { problems, cycles, capped, stuck, complete, dispatchable } = frontier();

      // Structural contradictions are handed to recover once per exact shape.
      // If the same shape survives, healthy disjoint work still proceeds and
      // the eventual idle path yields the unresolved decision to the human.
      if (problems.length || cycles.length) {
        const signature = JSON.stringify({ problems, cycles });
        if (!handledProblemSigs.has(signature)) {
          handledProblemSigs.add(signature);
          await recover({ kind: 'frontier-problems', problems, cycles });
          ({ problems, cycles, capped, stuck, complete, dispatchable } = frontier());
        }
      }

      if (capped.length || stuck.length) {
        for (const wall of [...capped, ...stuck]) {
          const blocked = ticket(wall.ticket);
          const last = blocked.attempts?.[blocked.attempts.length - 1];
          const detail = `${wall.ticket} "${blocked.title}" — ${blocked.attempts?.length ?? 0} attempts`
            + (last?.hypothesis ? `; last: ${last.hypothesis.slice(0, 200)}` : '');
          const spent = wallRecoveries.get(wall.ticket) ?? 0;

          if (spent >= WALL_RECOVER_BUDGET) {
            park(`attempt wall — ${spent} recovery attempt(s) exhausted: ${detail}`,
              { ticketId: wall.ticket });
            continue;
          }

          wallRecoveries.set(wall.ticket, spent + 1);
          await recover({
            kind: 'attempt-wall',
            ticketId: wall.ticket,
            attempts: blocked.attempts ?? [],
            recoveryAttempt: spent + 1,
            instruction: `This ticket failed its own checks repeatedly. Read every attempt hypothesis and find the ROOT cause in the campaign definition — a check that never matched the DoD, an acceptance clause that contradicts a delivered/closed dependency, a missing or under-built dependency, a footprint too small to satisfy the acceptance, or a campaign-wide fastCheck that is red for a reason this diff cannot reach. Fix it at the source within jurisdiction: amend the ticket contract (with resetAttempts:true, since the prior failures were against the old contract), amend the fast tier when the failing check is one of its commands and the fault is in how it measures rather than in the product, author a repair ticket for an under-built dependency and rewire this ticket onto it, or add a missing merged-tree gate check (only a red gate's own recovery may replace a gate command in force). Never weaken a named invariant or the acceptance to force green.${spent > 0 ? ' A PRIOR recovery already changed this ticket and it STILL walled — that diagnosis was wrong or incomplete, so find a DIFFERENT root cause; do not repeat the previous fix.' : ''} Park only if the fix is genuinely a human scope/security decision the locked spec does not answer.`,
          }, { ticketId: wall.ticket });
        }
        continue;
      }

      if (complete && isIdle(workers, settles)) {
        const verdict = await tryComplete();
        if (verdict) return verdict;
        continue;
      }

      if (!control.paused) {
        for (const id of dispatchable) {
          if (workers.size >= control.workerCap) break;
          if (!workers.has(id)) dispatchTicket(workers, id);
        }
      }

      if (isIdle(workers, settles)) {
        if (complete) {
          const verdict = await tryComplete();
          if (verdict) return verdict;
          continue;
        }
        if (control.paused) {
          await idle();
          continue;
        }

        const snapshot = frontier();
        const signature = JSON.stringify(snapshot);
        if (!handledStallSigs.has(signature)) {
          handledStallSigs.add(signature);
          await recover({ kind: 'stalled', frontier: snapshot });
          const after = frontier();
          if (after.dispatchable.length > 0 || hasOpen() || after.complete) continue;
        }

        const parked = parkedSummary();
        backlogWrite(['note', '--kind', 'awaiting-human', '--subject', 'campaign',
          '--body', `no autonomous work remains — parked tickets [${parked.tickets.join(', ') || 'none'}]${parked.gateParked ? ', campaign gate parked' : ''}. Resolve and \`loop resume\`.`]);
        tui.log(`■ awaiting human — tickets [${parked.tickets.join(', ')}]${parked.gateParked ? ' + campaign gate' : ''}`);
        return 'awaiting-human';
      }

      const event = await Promise.race<LoopEvent>([
        ...[...workers.values()].map(worker =>
          worker.promise.then((done): LoopEvent => ({ kind: 'worker', done }))),
        ...settles.values(),
      ]);

      if (event.kind === 'worker') {
        const metadata = workers.get(event.done.id)!;
        workers.delete(event.done.id);
        settles.set(event.done.id, settleTicket(event.done, metadata).then(
          (): LoopEvent => ({ kind: 'settled', id: event.done.id }),
          (err): LoopEvent => ({ kind: 'settled', id: event.done.id, err }),
        ));
        continue;
      }

      settles.delete(event.id);
      if (event.err) throw event.err;
    } catch (e: any) {
      if (e instanceof Escalation) throw e;
      const signature = String(e.message ?? e).slice(0, 300);
      if (signature === lastCrash) {
        escalate(`coordinator error repeated — needs a real arm: ${signature}`,
          { stack: e.stack });
      }
      lastCrash = signature;
      tui.log(`⚠ coordinator error → recover: ${signature}`);
      try {
        backlogWrite(['note', '--kind', 'coordinator-error', '--subject', 'drive',
          '--body', `${signature}\n${(e.stack ?? '').slice(0, 1500)}`]);
      } catch { /* recover below still receives the fault */ }
      try {
        await recover({
          kind: 'coordinator-error',
          error: signature,
          stack: (e.stack ?? '').slice(0, 1500),
        });
      } catch (recovery: any) {
        if (recovery instanceof Escalation) throw recovery;
        escalate(`coordinator error, and recover on it failed too: ${signature}`,
          { recoverError: recovery.message });
      }
    }
  }
}
