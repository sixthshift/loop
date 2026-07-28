// Running the campaign-level slow suite once ticket work drains. Gate amendment
// authority lives in gate.ts; this module owns the effectful terminal run and
// the escaped-bug recovery it can trigger.

import { backlog, backlogWrite } from './backlog.ts';
import { gateGreen, GATE_RED } from './gate.ts';
import { shAsync } from './state.ts';
import { withMainline } from './mainline.ts';
import { recover } from './recover.ts';
import { gateParked, GATE_SUBJECT } from './escalate.ts';
import * as tui from '../runtime/reporting.ts';

export async function tryComplete(): Promise<'complete' | 'awaiting-human' | null> {
  if (gateParked()) return 'awaiting-human';
  if (gateGreen()) return 'complete';
  await closeCampaignGate();
  return null;
}

async function closeCampaignGate(): Promise<void> {
  const b = backlog();
  const results = await withMainline(async () => {
    const out: { name: string; ok: boolean; tail: string }[] = [];
    for (const gate of b.gate ?? []) {
      tui.log(`campaign gate: ${gate.name}…`);
      const result = await shAsync(gate.cmd, '.', { label: `gate:${gate.name}` });
      out.push({
        name: gate.name,
        ok: result.status === 0,
        tail: (result.stdout + result.stderr).slice(-1500),
      });
    }
    return out;
  });
  const red = results.filter(result => !result.ok);

  if (red.length) {
    backlogWrite(['gate-run', 'red', '--note', `gate red: [${red.map(result => result.name).join(', ')}]`]);
    await recover({
      kind: GATE_RED,
      results,
      closedTickets: b.tickets.filter(ticket => ticket.status === 'closed').map(ticket => ticket.id),
      instruction: 'A red campaign gate is one of two things — decide which by reading the failures. (1) A real escaped bug: spawn a repair ticket whose checks also strengthen what let it through. (2) A gate-scoping fault (the gate runs the wrong things, or contends on shared state): narrow/serialise the gate to what it should verify and RUN the corrected gate to confirm it is green before proposing it. Park (resolved=false) only if neither holds — a genuine defect needing a human scope call.',
    }, { subject: GATE_SUBJECT });
    return;
  }

  backlogWrite(['gate-run', 'green', '--note',
    `gate green: [${results.map(result => result.name).join(', ')}]`,
    '--data', JSON.stringify({ gate: results.map(result => result.name) })]);
  tui.log('■ campaign gate green');
}
