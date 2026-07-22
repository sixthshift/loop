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
import { journalEntries } from './journal.ts';
import { campaignExists } from './index.ts';

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

// Park a decision for the human without stopping the campaign. Journals a
// `parked` note keyed to the ticket/subject, and blocks a live ticket so the
// frontier skips it. Best-effort: the note is the durable record even if the
// status write is illegal for the ticket's current state.
export function park(reason: string, opts?: { ticketId?: string; subject?: string; detail?: unknown }): void {
  if (!campaignExists()) return;
  const subject = opts?.ticketId ?? opts?.subject ?? 'campaign';
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
  const tickets = b.tickets.filter(t => t.status === 'parked' || t.status === 'failed-wall').map(t => t.id);
  return { tickets, gateParked: gateParked() };
}

// The campaign gate went red and recover couldn't get it green within
// jurisdiction — parked, so the completion path stops retrying it and drains to
// a human decision. Parked once and unparked only by the human editing the gate
// and resuming, so a later `gate-amendment` clears an earlier `parked`.
export function gateParked(): boolean {
  let parked = false;
  for (const e of journalEntries()) {
    if (e.subject !== 'campaign-gate') continue;
    if (e.kind === 'parked') parked = true;
    else if (e.kind === 'gate-amendment') parked = false;
  }
  return parked;
}
