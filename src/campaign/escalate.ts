// How the loop yields to the human — two grades, and only one of them stops.
//
// `park` is the ordinary yield: a decision the loop genuinely can't make (or a
// fault recover couldn't fix within jurisdiction) is journaled and, if it
// names a ticket, that ticket is set `parked` so the frontier stops offering it. Park
// does NOT throw — the drive loop keeps driving every other ticket, and only
// halts (gracefully, with a summary) once nothing autonomous is left. A single
// parked decision never again kills a campaign with other work to do.
//
// `escalate` is the hard stop, reserved for a coordinator FAULT (a repeated
// internal crash) — continuing there risks an infinite loop or corrupt state,
// so it throws and the process exits. It is the only remaining hard exit.

import { backlog, backlogWrite, ticket } from './backlog.ts';
import { campaignExists } from './index.ts';

// The one non-ticket subject a park can name and have it stick: the campaign
// gate keeps a latch on the backlog, so `park` routes it to `gate-park` rather
// than the journal-note path.
export const GATE_SUBJECT = 'campaign-gate';

export class Escalation extends Error {
  detail: unknown;
  constructor(reason: string, detail?: unknown) {
    super(reason);
    this.detail = detail;
  }
}

export function escalate(reason: string, detail?: unknown): never {
  // The journal entry is bookkeeping around the escalation, not the
  // escalation itself — it must never mask the throw.
  if (campaignExists()) {
    try {
      backlogWrite(['note', '--kind', 'escalation', '--subject', 'campaign', '--body', reason]);
    } catch { /* journaling failed; the throw below still surfaces the reason */ }
  }
  throw new Escalation(reason, detail);
}

// Park a decision for the human without stopping the campaign. Two subjects
// carry a durable flag on the backlog — a ticket (its `parked` status) and the
// campaign gate (its latch); everything else parks as a journal note alone,
// surfaced in the drain report. Best-effort: the record is written first, so a
// refused status write still leaves the reason on file.
export function park(reason: string, opts?: { ticketId?: string; subject?: string; detail?: unknown }): void {
  if (!campaignExists()) return;
  const subject = opts?.ticketId ?? opts?.subject ?? 'campaign';
  if (subject === GATE_SUBJECT) {
    try { backlogWrite(['gate-park', '--reason', reason]); } catch { /* the drive re-runs the gate; a failed latch is not fatal */ }
    return;
  }
  try {
    backlogWrite(['note', '--kind', 'parked', '--subject', subject, '--body', reason]);
    if (opts?.ticketId) {
      const t = ticket(opts.ticketId);
      // Only park what's in play — an open or in-flight ticket.
      // (closed/decomposed/already-parked stay as they are.)
      if (t.status === 'in-flight' || t.status === 'open') {
        backlogWrite(['set-status', opts.ticketId, 'parked', '--note', 'parked for human decision']);
      }
    }
  } catch { /* the parked note above is the record; a failed status write is not fatal */ }
}

// What currently awaits the human: tickets held out of dispatch, plus the
// campaign gate if it went red and the loop couldn't fix it. Drives the
// graceful-stop summary.
export function parkedSummary(): { tickets: string[]; gateParked: boolean } {
  const b = backlog();
  const tickets = b.tickets.filter(t => t.status === 'parked').map(t => t.id);
  return { tickets, gateParked: gateParked() };
}

// The campaign gate went red and recover couldn't get it green within
// jurisdiction — parked, so the completion path stops retrying it and drains to
// a human decision. The latch lives on the backlog: `gate-park` sets it, and
// the `gate` amendment command is the only thing that clears it.
export function gateParked(): boolean {
  return backlog().gateState?.parked !== undefined;
}
