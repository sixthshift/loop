#!/usr/bin/env bun
// loop — the loop-engineering toolkit. `campaign` is its first verb: the
// script-coordinator (src/campaign/) that drives a locked build spec to green.
// This file is only the CLI shell — verb wiring and arg parsing; the
// coordinator itself lives in campaign/.
//
// Two coordinators drive this architecture: the drive loop below, and the
// `ailoop` skill's model in the same seat. They share the .ailoop/campaign/
// layout AND the mechanics — the skill reaches every measurement and bookkeeping
// step through the verbs in mechanics.ts, so the seat is the only difference
// between the two. A campaign in flight still belongs to whoever opened it
// (backlog.coordinator), because neither seat can hold the other's lock.

import { program } from 'commander';
import { runCampaign } from './campaign/index.ts';
import { renderProgress } from './campaign/progress.ts';
import { registerMechanics } from './mechanics.ts';
import { installSkills, uninstallSkills } from './skills.ts';
import { runUpdate } from './update.ts';
// package.json is the one place the version lives — the release tag and
// `loop --version` both read it, so they can't drift. The import is bundled
// into the compiled binary, not read from disk at runtime.
import { version } from '../package.json' with { type: 'json' };

program
  .name('loop')
  .version(version)
  .description('the loop-engineering toolkit — drive a locked build spec to green')
  // The mechanics verbs pass their own flags straight through to the campaign
  // modules, which needs commander to stop claiming options after a verb name.
  .enablePositionalOptions();

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

const skills = program
  .command('skills')
  .description('install the ailoop / aispec skills where the agent CLIs look for them');

skills
  .command('install')
  .description('write (binary) or symlink (source checkout) the skills into ~/.claude/skills and ~/.agents/skills')
  .option('--force', 'replace a skill directory loop did not install')
  .action((opts: { force?: boolean }) => installSkills({ force: opts.force === true }));

skills
  .command('uninstall')
  .description('remove only the skills loop installed')
  .action(() => uninstallSkills());

program
  .command('update')
  .description('replace this binary with the latest release, and refresh the skills it owns')
  .action(async () => {
    await runUpdate();
    // The reason the skills live here: prose and CLI move in one step. A binary
    // that upgraded its verbs while leaving stale instructions behind is the exact
    // skew this arrangement exists to make impossible.
    installSkills({ force: false });
  });

// The same mechanics this program drives with, as verbs for the other seat.
registerMechanics(program);

await program.parseAsync();
