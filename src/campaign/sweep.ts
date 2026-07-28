// Campaign-wide reflection. Cadence is durable backlog state; the journal is
// supplied as the audit evidence the sweep exists to inspect, never replayed to
// decide current ticket or gate state.

import { backlog, backlogWrite } from './backlog.ts';
import { journalEntries } from './journal.ts';
import { agent, renderPrompt } from './agents/run.ts';
import { MODELS } from './agents/models.ts';
import { SWEEP } from './agents/schemas.ts';
import type { SweepVerdict } from './agents/schemas.ts';
import { recover, renumber, backlogSummary } from './recover.ts';
import { amendGate } from './gate.ts';
import { park } from './escalate.ts';

const SWEEP_EVERY = 5;

export function sweepDue(): boolean {
  const b = backlog();
  const closed = b.tickets.filter(ticket => ticket.status === 'closed').length;
  return closed - (b.sweep?.closed ?? 0) >= SWEEP_EVERY;
}

export async function runSweep(force = false): Promise<void> {
  if (!force && !sweepDue()) return;
  // Settlements can close while the sweep agent is reading. The baseline is
  // the snapshot the sweep was asked to inspect, not whatever count happens to
  // exist when that minutes-long read returns.
  const closedAtStart = backlog().tickets.filter(ticket => ticket.status === 'closed').length;
  const entries = journalEntries();
  if (entries.length < 3) return;

  const result = (await agent<SweepVerdict>({
    prompt: renderPrompt('sweep', {
      outOfScope: backlog().outOfScope ?? [],
      backlogSummary: backlogSummary(),
      journal: entries,
    }),
    models: MODELS.sweep,
    schema: SWEEP,
    tools: 'Read,Glob,Grep',
    label: 'sweep',
  })).output;

  for (const proposal of result.proposals) {
    if (proposal.type === 'escalate') {
      park(`sweep: ${proposal.reason}`);
      continue;
    }
    try {
      if (proposal.type === 'note')
        backlogWrite(['note', '--kind', proposal.kind ?? 'sweep-note',
          '--subject', proposal.subject ?? 'campaign', '--body', proposal.body ?? '']);
      if (proposal.type === 'ticket' && proposal.ticket)
        backlogWrite(['add', '-'], renumber([proposal.ticket]));
      if (proposal.type === 'sharpen')
        backlogWrite(['update', proposal.ticketId!, '-', '--note', proposal.note ?? 'sweep'],
          proposal.patch ?? {});
      if (proposal.type === 'gate' && proposal.gates?.length) {
        amendGate(proposal.gates, {
          by: 'sweep',
          note: proposal.note || 'sweep',
          replacements: 'refuse',
        });
      }
    } catch (e: any) {
      backlogWrite(['note', '--kind', 'sweep-refused',
        '--subject', proposal.ticketId ?? proposal.type, '--body', e.message]);
    }
  }
  backlogWrite(['sweep-run', '--closed', String(closedAtStart), '--body', result.summary]);
}
