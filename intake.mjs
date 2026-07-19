// Stage 1 — intake. Only runs when .ailoop/run/ is absent. The refuse-to-
// start gate is the ONLY permitted human interruption in a healthy run —
// spend it here, never mid-drive.

import fs from 'node:fs';
import path from 'node:path';
import { RUN, TEMPLATES, backlogWrite, specSha, readLearnings } from './run.mjs';
import { agentRetry, renderPrompt } from './agent.mjs';
import { SEED, DECOMPOSE } from './schemas.mjs';
import { escalate } from './escalate.mjs';
import * as tui from './tui.mjs';

export async function intake(specPath) {
  const spec = fs.readFileSync(specPath, 'utf8');
  const sha = specSha(specPath);
  const learnings = readLearnings();

  tui.log('intake: gate + toolchain detection…');
  const seed = (await agentRetry({
    prompt: renderPrompt('seed', {
      spec, specPath,
      learnings: learnings?.['checks.json']
        ? `## Verified toolchain commands from past campaigns (re-probe before trusting — a prior is a hypothesis)\n\n${learnings['checks.json']}`
        : '',
    }),
    model: 'opus',
    schema: SEED,
    tools: 'Read,Glob,Grep,Bash',
    bypassPermissions: true, // it must RUN candidate check commands to trust them
    label: 'intake-seed',
  })).output;

  if (seed.blockers.length) {
    tui.stop();
    console.error('REFUSED TO START — resolve these and re-run:');
    for (const b of seed.blockers) console.error(`  · ${b.item}\n    needed: ${b.needed}`);
    process.exit(3);
  }

  // State exists only past the gate — a refused intake leaves no residue.
  // Templates land first: backlog-write.mjs must exist in run/ before init
  // can be a command against it.
  const project = path.basename(specPath).replace(/\.[^.]+$/, '');
  fs.mkdirSync(RUN, { recursive: true });
  for (const f of fs.readdirSync(TEMPLATES).filter(f => f.endsWith('.mjs'))) {
    fs.copyFileSync(path.join(TEMPLATES, f), path.join(RUN, f));
  }
  backlogWrite(['init', '--project', project]);
  ensureGitignore();
  backlogWrite(['seed', '-'], { fastChecks: seed.fastChecks, phases: seed.phases, outOfScope: seed.outOfScope });
  backlogWrite(['note', '--kind', 'intake', '--subject', 'spec',
    '--body', `sha256=${sha} coordinator=script`, '--data', JSON.stringify({ specPath, sha })]);
  if (learnings?.['flakes.json']) {
    backlogWrite(['note', '--kind', 'known-flakes', '--subject', 'campaign', '--body', learnings['flakes.json']]);
  }

  tui.log('intake: decomposing spec into tickets…');
  let feedback = '';
  for (let attempt = 0; ; attempt++) {
    const res = (await agentRetry({
      prompt: renderPrompt('decompose', {
        spec,
        phaseIds: seed.phases.map(p => p.id).join(', '),
        config: { fastChecks: seed.fastChecks, phases: seed.phases, outOfScope: seed.outOfScope },
        learnings: learnings?.['sizing.md']
          ? `## Sizing priors from past campaigns (decompose preemptively)\n\n${learnings['sizing.md']}`
          : '',
        feedback,
      }),
      model: 'opus',
      schema: DECOMPOSE,
      tools: 'Read,Glob,Grep',
      label: 'intake-decompose',
    })).output;
    try {
      backlogWrite(['add', '-'], res.tickets);
      // The pre-flight report goes to the journal — it must outlive the screen.
      const preflight = seed.phases.map(p => {
        const n = res.tickets.filter(t => t.phase === p.id).length;
        return `${p.id}: ${n} ticket(s) — ${p.delivers} [gate: ${p.gate.map(g => g.name).join(', ') || 'none'}]`;
      }).join('; ');
      backlogWrite(['note', '--kind', 'preflight', '--subject', 'campaign',
        '--body', `${res.tickets.length} draft ticket(s). ${preflight}${seed.notes ? ` — ${seed.notes}` : ''}`]);
      tui.log(`intake complete: ${res.tickets.length} draft ticket(s)`);
      return;
    } catch (e) {
      if (attempt >= 2) escalate(`intake: decomposition refused twice by backlog-write`, e.message);
      feedback = `## Your previous ticket set was REFUSED by validation — fix and resend the full set\n\n${e.message}`;
    }
  }
}

function ensureGitignore() {
  const lines = ['.ailoop/run/', '.ailoop/worktrees/'];
  const existing = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
  const missing = lines.filter(l => !existing.split('\n').includes(l));
  if (missing.length) fs.appendFileSync('.gitignore', (existing.endsWith('\n') || !existing ? '' : '\n') + missing.join('\n') + '\n');
}
