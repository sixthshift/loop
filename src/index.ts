#!/usr/bin/env bun
// loop — the substrate an autonomous build coordinator stands on.
//
// The coordinator itself is the `ailoop` skill: a model that decomposes a locked
// spec, dispatches workers, and drives to a green campaign gate. This program is
// everything underneath that seat — the sole backlog writer, the frontier
// arithmetic, verification and its scope check, the branch lifecycle, the role
// prompts and their schemas — reached as verbs (mechanics.ts), plus `watch`, the
// read-only window onto a campaign it is not driving.
//
// It used to be the coordinator too, with a deterministic drive loop in that
// seat. That version needed an enumerated arm per fault, which is the cost a model
// in the seat doesn't pay, and it is gone. What it left behind is the half worth
// keeping: nothing here asks the coordinator to remember, count, or measure.

import { program } from 'commander';
import { renderProgress } from './campaign/progress.ts';
import { runWatch } from './tui/watch.ts';
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
  .command('watch')
  .description('live read-only dashboard for the campaign in this repository (non-TTY prints the tree once)')
  .action(async () => { await runWatch(); });

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

// The verbs the coordinator drives through — most of this program's surface.
registerMechanics(program);

await program.parseAsync();
