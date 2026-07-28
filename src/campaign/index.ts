// The campaign coordinator — the deterministic seat. Establish the campaign's
// Take the single-coordinator lock, establish campaign identity (kickoff, or a
// spec-sha-checked resume), then loop drive → retrospective until the
// retrospective closes clean.
// Escalation is the honest pause; any other throw is a coordinator bug the
// state protocol still makes survivable — both exit with state intact.

import fs from 'node:fs';
import { specSha, acquireLock, LockHeldError } from './state.ts';
import type { CampaignContext } from './state.ts';
import { kickoff } from './kickoff.ts';
import { drive } from './drive.ts';
import { retrospective } from './retrospective.ts';
import { Escalation, parkedSummary } from './escalate.ts';
import { backlog, campaignExists } from './backlog.ts';
import * as tui from '../runtime/reporting.ts';
import * as display from '../tui/app.ts';


export async function runCampaign(specArg: string | null): Promise<void> {
  try {
    // The command owns the repository before it reads or creates campaign
    // state. In particular kickoff runs agents and writes the initial backlog,
    // so taking the lock afterwards would leave the most important write path
    // outside the exclusion boundary.
    acquireLock();
    display.start();
    const ctx = await establishCampaign(specArg);
    // Coverage gaps re-open the drive — loop until the retrospective closes
    // clean OR the drive drains to a graceful human-decision pause. Only a
    // 'complete' drive enters retrospective's close path (coverage, harvest,
    // spec-done, state deletion); an 'awaiting-human' drain is a resumable
    // pause, reported and left intact — never retrospective's ungated-gate throw.
    while (true) {
      const outcome = await drive();
      if (outcome === 'awaiting-human') { reportAwaitingHuman(); return; }
      const { resume } = await retrospective(ctx);
      if (!resume) break;
    }
    display.stop();
    console.log('\ncampaign complete.');
  } catch (e: any) {
    display.stop();
    if (e instanceof LockHeldError) {
      console.error(e.message + '.');
      process.exit(2);
    }
    if (e instanceof Escalation) {
      console.error('\n════════ ESCALATION — campaign paused, state intact ════════\n');
      console.error(e.message);
      if (e.detail !== undefined) console.error('\ndetail:\n' + JSON.stringify(e.detail, null, 2));
      console.error('\nresolve, then re-run `loop resume`.');
      process.exit(2);
    }
    // Not an escalation: a coordinator bug that slipped every membrane. The
    // state protocol makes this survivable — say so instead of a bare stack.
    console.error('\n════════ COORDINATOR CRASH — campaign state intact ════════\n');
    console.error(e.stack ?? String(e));
    console.error('\nre-run `loop resume` to reconcile and continue.');
    process.exit(1);
  }
}

// The graceful drain: the drive resolved everything it could and paused on the
// decisions that are genuinely the human's. NOT an escalation — state is intact
// and `loop resume` continues. Report what shipped and what's deferred, each
// with the reason the loop recorded, so the human fixes exactly what remains.
function reportAwaitingHuman(): void {
  display.stop();
  const b = backlog();
  const closed = b.tickets.filter(t => t.status === 'closed').length;
  const { tickets, gateParked } = parkedSummary();
  const reasonFor = (id: string): string =>
    b.tickets.find(ticket => ticket.id === id)?.parkReason || 'parked (no reason recorded)';
  console.log('\n════════ CAMPAIGN PAUSED — decisions deferred to you ════════\n');
  console.log(`shipped: ${closed}/${b.tickets.length} tickets closed.`);
  if (!tickets.length && !gateParked) {
    console.log('\nnothing parked, yet no autonomous work remained — inspect the journal.');
  } else {
    if (tickets.length) {
      console.log('\ntickets awaiting a decision:');
      for (const id of tickets) console.log(`  • ${id}: ${reasonFor(id).slice(0, 400)}`);
    }
    if (gateParked) {
      console.log('\ncampaign gate awaiting a decision:');
      console.log(`  • ${(b.gateState?.parked?.reason ?? 'parked (no reason recorded)').slice(0, 400)}`);
    }
  }
  console.log('\nresolve these, then `loop resume` — state is intact.');
}

async function establishCampaign(spec: string | null): Promise<CampaignContext> {
  if (!campaignExists()) {
    if (!spec) {
      display.stop();
      console.error('no campaign in flight (.ailoop/campaign/ absent) — start one with: loop campaign <spec.md>');
      process.exit(2);
    }
    await kickoff(spec);
    return { specPath: spec, spec: fs.readFileSync(spec, 'utf8') };
  }

  // Resume path: never re-run kickoff; never drive an old spec to green. The
  // contract is persistent backlog state; the kickoff journal entry only
  // explains how it was established.
  const contract = backlog().contract;
  if (!contract) {
    display.stop();
    console.error('campaign backlog has no locked contract — refusing to infer behavioral state from the audit journal.');
    process.exit(2);
  }
  const specPath = spec ?? contract.specPath;
  if (specSha(specPath) !== contract.sha256) {
    display.stop();
    console.error(`spec changed since kickoff (${specPath}): hash mismatch with the locked backlog contract.`);
    console.error('reconcile with the human before driving — the loop never builds an old spec to green.');
    process.exit(2);
  }
  tui.log(`resuming campaign (spec unchanged: ${specPath})`);
  return { specPath, spec: fs.readFileSync(specPath, 'utf8') };
}
