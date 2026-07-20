#!/usr/bin/env bun
// loop — the loop-engineering toolkit. `campaign` is its first verb: the
// script-coordinator (src/campaign/) that drives a locked build spec to green.
// This file is only the CLI shell — verb wiring and arg parsing; the
// coordinator itself lives in campaign/.
//
// Same state protocol as the ailoop skill (.ailoop/campaign/, the six template
// scripts): either coordinator can resume the other's campaign.

import path from 'node:path';
import { program } from 'commander';
import { RUN, sh } from './campaign/state.ts';
import { runCampaign } from './campaign/index.ts';

program
  .name('loop')
  .description('the loop-engineering toolkit — drive a locked build spec to green');

program
  .command('campaign')
  .description('start a campaign (or resume it, spec unchanged)')
  .argument('<spec.md>', 'path to the locked build spec')
  .action((spec: string) => runCampaign(spec));

program
  .command('resume')
  .description('resume without re-supplying the spec path')
  .action(() => runCampaign(null));

program
  .command('status')
  .description('render the live backlog tree')
  .action(() => {
    const r = sh(`node ${path.join(RUN, 'progress.mjs')}`);
    process.stdout.write(r.stdout + r.stderr);
    process.exit(r.status ?? 0);
  });

await program.parseAsync();
