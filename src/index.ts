#!/usr/bin/env bun
// loop — the loop-engineering toolkit. `campaign` is its first verb: the
// script-coordinator (src/campaign/) that drives a locked build spec to green.
// This file is only the CLI shell — verb wiring and arg parsing; the
// coordinator itself lives in campaign/.
//
// Shares the .ailoop/campaign/ state layout with the ailoop skill, but every
// mechanical step is native TS now (src/campaign/), not the copied-in scripts.
// The loop no longer provisions those scripts into the campaign dir, so a
// campaign this coordinator starts is not one the skill can resume, and vice
// versa — each coordinator drives its own campaigns end to end.

import { program } from 'commander';
import { runCampaign } from './campaign/index.ts';
import { renderProgress } from './campaign/progress.ts';
import { runUpdate } from './update.ts';
// package.json is the one place the version lives — the release tag and
// `loop --version` both read it, so they can't drift. The import is bundled
// into the compiled binary, not read from disk at runtime.
import { version } from '../package.json' with { type: 'json' };

program
  .name('loop')
  .version(version)
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
  .description('render the backlog tree')
  .action(() => { console.log(renderProgress()); });

program
  .command('update')
  .description('replace this binary with the latest release')
  .action(() => runUpdate());

await program.parseAsync();
