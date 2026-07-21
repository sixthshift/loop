// The campaign coordinator — the deterministic seat. Establish the campaign's
// identity (intake, or a spec-sha-checked resume), take the single-coordinator
// lock, then loop drive → retrospective until the retrospective closes clean.
// Escalation is the honest pause; any other throw is a coordinator bug the
// state protocol still makes survivable — both exit with state intact.

import fs from 'node:fs';
import path from 'node:path';
import { journalEntries } from './journal.ts';
import { specSha, lockHolder, acquireLock, RUN } from './state.ts';
import type { CampaignContext } from './state.ts';
import { intake } from './intake.ts';
import { drive } from './drive.ts';
import { retrospective } from './retrospective.ts';
import { Escalation, parkedSummary } from './escalate.ts';
import { backlog } from './backlog.ts';
import * as tui from '../tui/tui.ts';


export async function runCampaign(specArg: string | null): Promise<void> {
  try {
    tui.start();
    const ctx = await establishCampaign(specArg);
    const holder = lockHolder();
    if (holder) {
      tui.stop();
      console.error(`another coordinator (pid ${holder}) is already driving this campaign.`);
      console.error('if that process is actually gone (e.g. a different container), remove .ailoop/campaign/coordinator.pid and retry.');
      process.exit(2);
    }
    acquireLock();
    // Coverage gaps re-open the drive — loop until the retrospective closes
    // clean OR the drive drains to a graceful human-decision pause. Only a
    // 'complete' drive enters retrospective's close path (coverage, harvest,
    // spec-done, state deletion); an 'awaiting-human' drain is a resumable
    // pause, reported and left intact — never retrospective's ungated-gate throw.
    while (true) {
      const outcome = await drive(ctx);
      if (outcome === 'awaiting-human') { reportAwaitingHuman(); return; }
      const { resume } = await retrospective(ctx);
      if (!resume) break;
    }
    tui.stop();
    console.log('\ncampaign complete.');
  } catch (e: any) {
    tui.stop();
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
  tui.stop();
  const b = backlog();
  const closed = b.tickets.filter(t => t.status === 'closed').length;
  const { tickets, phases } = parkedSummary();
  const reasonFor = (subject: string): string => {
    const notes = journalEntries().filter(e => e.kind === 'parked' && e.subject === subject);
    return notes[notes.length - 1]?.body || 'parked (no reason recorded)';
  };
  console.log('\n════════ CAMPAIGN PAUSED — decisions deferred to you ════════\n');
  console.log(`shipped: ${closed}/${b.tickets.length} tickets closed.`);
  if (!tickets.length && !phases.length) {
    console.log('\nnothing parked, yet no autonomous work remained — inspect the journal.');
  } else {
    if (tickets.length) {
      console.log('\ntickets awaiting a decision:');
      for (const id of tickets) console.log(`  • ${id}: ${reasonFor(id).slice(0, 400)}`);
    }
    if (phases.length) {
      console.log('\nphase gates awaiting a decision:');
      for (const p of phases) console.log(`  • phase ${p}: ${reasonFor(p).slice(0, 400)}`);
    }
  }
  console.log('\nresolve these, then `loop resume` — state is intact.');
}

async function establishCampaign(spec: string | null): Promise<CampaignContext> {
  if (!campaignExists()) {
    if (!spec) {
      tui.stop();
      console.error('no campaign in flight (.ailoop/campaign/ absent) — start one with: loop campaign <spec.md>');
      process.exit(2);
    }
    await intake(spec);
    return { specPath: spec, spec: fs.readFileSync(spec, 'utf8') };
  }

  // Resume path: never re-run intake; never drive an old spec to green.
  const intakeEntry = journalEntries().find(j => j.kind === 'intake' && j.data?.sha);
  if (!intakeEntry) {
    tui.stop();
    console.error('campaign state exists but no intake record — refusing to guess; inspect .ailoop/campaign/journal.jsonl');
    process.exit(2);
  }
  const specPath: string = spec ?? intakeEntry.data.specPath;
  if (specSha(specPath) !== intakeEntry.data.sha) {
    tui.stop();
    console.error(`spec changed since intake (${specPath}): hash mismatch with the journaled contract.`);
    console.error('reconcile with the human before driving — the loop never builds an old spec to green.');
    process.exit(2);
  }
  tui.log(`resuming campaign (spec unchanged: ${specPath})`);
  return { specPath, spec: fs.readFileSync(specPath, 'utf8') };
}// A campaign exists once its backlog is on disk — the marker the coordinator
// checks before intake or resume.

export function campaignExists(): boolean {
  return fs.existsSync(path.join(RUN, 'backlog.json'));
}

