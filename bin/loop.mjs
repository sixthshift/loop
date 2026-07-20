#!/usr/bin/env bun
// loop — the loop-engineering toolkit. `campaign` is its first verb: the
// script-coordinator that drives a locked build spec to green.
//
//   loop campaign <spec.md>   start a campaign (or resume it, spec unchanged)
//   loop resume               resume without re-supplying the spec path
//   loop status               render the live backlog tree
//
// Same state protocol as the ailoop skill (.ailoop/run/, the six template
// scripts): either coordinator can resume the other's campaign.

import fs from 'node:fs';
import path from 'node:path';
import { RUN, campaignExists, journalEntries, specSha, sh, lockHolder, acquireLock } from '../run.mjs';
import { intake } from '../intake.mjs';
import { drive } from '../drive.mjs';
import { retrospective } from '../retrospective.mjs';
import { Escalation } from '../escalate.mjs';
import * as tui from '../tui.mjs';

const [verb, specArg] = process.argv.slice(2);
const usage = () => { console.error('usage: loop campaign <spec.md> | loop resume | loop status'); process.exit(2); };

if (!verb || verb === '--help' || verb === '-h') usage();

if (verb === 'status') {
  const r = sh(`node ${path.join(RUN, 'progress.mjs')}`);
  process.stdout.write(r.stdout + r.stderr);
  process.exit(r.status ?? 0);
}
if (verb !== 'campaign' && verb !== 'resume') usage();
if (verb === 'campaign' && !specArg) usage();

try {
  tui.start();
  const ctx = await establishCampaign(verb === 'resume' ? null : specArg);
  const holder = lockHolder();
  if (holder) {
    tui.stop();
    console.error(`another coordinator (pid ${holder}) is already driving this campaign.`);
    console.error('if that process is actually gone (e.g. a different container), remove .ailoop/run/coordinator.pid and retry.');
    process.exit(2);
  }
  acquireLock();
  // Coverage gaps re-open the drive — loop until the retrospective closes clean.
  while (true) {
    await drive(ctx);
    const { resume } = await retrospective(ctx);
    if (!resume) break;
  }
  tui.stop();
  console.log('\ncampaign complete.');
} catch (e) {
  tui.stop();
  if (e instanceof Escalation) {
    console.error('\n════════ ESCALATION — campaign paused, state intact ════════\n');
    console.error(e.message);
    if (e.detail !== undefined) console.error('\ndetail:\n' + JSON.stringify(e.detail, null, 2));
    console.error('\nresolve, then re-run `loop resume`.');
    process.exit(2);
  }
  throw e;
}

async function establishCampaign(spec) {
  if (!campaignExists()) {
    if (!spec) {
      tui.stop();
      console.error('no campaign in flight (.ailoop/run/ absent) — start one with: loop campaign <spec.md>');
      process.exit(2);
    }
    await intake(spec);
    return { specPath: spec, spec: fs.readFileSync(spec, 'utf8') };
  }

  // Resume path: never re-run intake; never drive an old spec to green.
  const intakeEntry = journalEntries().find(j => j.kind === 'intake' && j.data?.sha);
  if (!intakeEntry) {
    tui.stop();
    console.error('campaign state exists but no intake record — refusing to guess; inspect .ailoop/run/journal.jsonl');
    process.exit(2);
  }
  const specPath = spec ?? intakeEntry.data.specPath;
  if (specSha(specPath) !== intakeEntry.data.sha) {
    tui.stop();
    console.error(`spec changed since intake (${specPath}): hash mismatch with the journaled contract.`);
    console.error('reconcile with the human before driving — the loop never builds an old spec to green.');
    process.exit(2);
  }
  tui.log(`resuming campaign (spec unchanged: ${specPath})`);
  return { specPath, spec: fs.readFileSync(specPath, 'utf8') };
}
