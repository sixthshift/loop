// Stage 1 — kickoff. Only runs when .ailoop/campaign/ is absent. The refuse-to-
// start gate is the ONLY permitted human interruption in a healthy run —
// spend it here, never mid-drive.

import fs from 'node:fs';
import path from 'node:path';
import { backlog, backlogWrite } from './backlog.ts';
import { coverage } from './frontier.ts';
import { RUN, specSha, readLearnings } from './state.ts';
import { agent, renderPrompt } from './agents/run.ts';
import { MODELS } from './agents/models.ts';
import { KICKOFF, DECOMPOSE } from './agents/schemas.ts';
import type { KickoffVerdict, DecomposeVerdict } from './agents/schemas.ts';
import { escalate } from './escalate.ts';
import * as tui from '../runtime/reporting.ts';
import { stop as stopDisplay } from '../tui/app.ts';

export async function kickoff(specPath: string): Promise<void> {
  const spec = fs.readFileSync(specPath, 'utf8');
  const sha = specSha(specPath);
  const learnings = readLearnings();

  tui.log('kickoff: refuse-to-start gate + toolchain detection…');
  const kv = (await agent<KickoffVerdict>({
    prompt: renderPrompt('kickoff', {
      spec, specPath,
      learnings: learnings?.['checks.json']
        ? `## Verified toolchain commands from past campaigns (re-probe before trusting — a prior is a hypothesis)\n\n${learnings['checks.json']}`
        : '',
    }),
    models: MODELS.kickoff,
    schema: KICKOFF,
    tools: 'Read,Glob,Grep,Bash',
    bypassPermissions: true, // it must RUN candidate check commands to trust them
    label: 'kickoff',
  })).output;

  if (kv.blockers.length) {
    stopDisplay();
    console.error('REFUSED TO START — resolve these and re-run:');
    for (const b of kv.blockers) console.error(`  · ${b.item}\n    needed: ${b.needed}`);
    process.exit(3);
  }

  // State exists only past the gate — a refused kickoff leaves no residue.
  const project = path.basename(specPath).replace(/\.[^.]+$/, '');
  fs.mkdirSync(RUN, { recursive: true });
  backlogWrite(['init', '--project', project, '--spec-path', specPath, '--spec-sha', sha]);
  ensureGitignore();
  backlogWrite(['seed', '-'], {
    fastChecks: kv.fastChecks, gate: kv.gate, outOfScope: kv.outOfScope, requirements: kv.requirements,
  });
  // The enumeration is load-bearing from here on: every later reading of "how
  // much of the spec is done" joins against these ids, and a clause missing here
  // is a clause the frontier can never report as unmapped. Kickoff is the one
  // moment a human is present, so the list is put in front of them and into the
  // journal — a contract nobody was shown is not a contract they reviewed.
  backlogWrite(['note', '--kind', 'requirements', '--subject', 'spec',
    '--body', kv.requirements.map(r => `${r.id}: ${r.clause}`).join('\n') || '(none enumerated)',
    '--data', JSON.stringify({ requirements: kv.requirements })]);
  tui.showRequirements(kv.requirements);
  tui.log(`kickoff: ${kv.requirements.length} spec requirement(s) enumerated`);
  backlogWrite(['note', '--kind', 'kickoff', '--subject', 'spec',
    '--body', `sha256=${sha} coordinator=script`, '--data', JSON.stringify({ specPath, sha })]);
  if (learnings?.['flakes.json']) {
    backlogWrite(['note', '--kind', 'known-flakes', '--subject', 'campaign', '--body', learnings['flakes.json']]);
  }

  tui.log('kickoff: decomposing spec into tickets…');
  let feedback = '';
  for (let attempt = 0; ; attempt++) {
    const res = (await agent<DecomposeVerdict>({
      prompt: renderPrompt('decompose', {
        spec,
        requirements: kv.requirements,
        config: { fastChecks: kv.fastChecks, gate: kv.gate, outOfScope: kv.outOfScope },
        learnings: learnings?.['sizing.md']
          ? `## Sizing priors from past campaigns (decompose preemptively)\n\n${learnings['sizing.md']}`
          : '',
        feedback,
      }),
      models: MODELS.decompose,
      schema: DECOMPOSE,
      tools: 'Read,Glob,Grep',
      label: 'decompose',
    })).output;
    try {
      backlogWrite(['add', '-'], res.tickets);
      // The pre-flight report goes to the journal — it must outlive the screen.
      // It carries the unmapped clauses because this is the last point before
      // the loop runs unattended: a requirement no ticket claims will otherwise
      // surface as a coverage gap only at termination, after the whole tree has
      // been built around its absence.
      const gateNames = kv.gate.map(g => g.name).join(', ') || 'none';
      const { unmapped, requirements } = coverage(backlog());
      const cover = requirements
        ? ` requirements: ${requirements - unmapped.length}/${requirements} claimed${unmapped.length ? ` — UNCLAIMED [${unmapped.join(', ')}]` : ''}.`
        : '';
      backlogWrite(['note', '--kind', 'preflight', '--subject', 'campaign',
        '--body', `${res.tickets.length} open ticket(s). campaign gate: [${gateNames}].${cover}${kv.notes ? ` — ${kv.notes}` : ''}`]);
      tui.log(`kickoff complete: ${res.tickets.length} open ticket(s)${unmapped.length ? `; ${unmapped.length} spec requirement(s) unclaimed` : ''}`);
      return;
    } catch (e: any) {
      if (attempt >= 2) escalate(`kickoff: decomposition refused twice by backlog-write`, e.message);
      feedback = `## Your previous ticket set was REFUSED by validation — fix and resend the full set\n\n${e.message}`;
    }
  }
}

function ensureGitignore(): void {
  // Worker worktrees are not listed: they live outside the repository entirely
  // (see worktree.ts), so there is nothing here for git to ignore.
  const lines = ['.ailoop/campaign/'];
  const existing = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
  const missing = lines.filter(l => !existing.split('\n').includes(l));
  if (missing.length) fs.appendFileSync('.gitignore', (existing.endsWith('\n') || !existing ? '' : '\n') + missing.join('\n') + '\n');
}
