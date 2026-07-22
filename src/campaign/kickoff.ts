// Stage 1 — kickoff. Only runs when .ailoop/campaign/ is absent. The refuse-to-
// start gate is the ONLY permitted human interruption in a healthy run —
// spend it here, never mid-drive.

import fs from 'node:fs';
import path from 'node:path';
import { backlogWrite } from './backlog.ts';
import { RUN, specSha, readLearnings } from './state.ts';
import { agent, renderPrompt } from '../agent/agent.ts';
import { MODELS } from './models.ts';
import { KICKOFF, DECOMPOSE } from '../agent/schemas.ts';
import type { KickoffVerdict, DecomposeVerdict } from '../agent/schemas.ts';
import { escalate } from './escalate.ts';
import * as tui from '../tui/tui.ts';

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
    tui.stop();
    console.error('REFUSED TO START — resolve these and re-run:');
    for (const b of kv.blockers) console.error(`  · ${b.item}\n    needed: ${b.needed}`);
    process.exit(3);
  }

  // State exists only past the gate — a refused kickoff leaves no residue.
  const project = path.basename(specPath).replace(/\.[^.]+$/, '');
  fs.mkdirSync(RUN, { recursive: true });
  backlogWrite(['init', '--project', project]);
  ensureGitignore();
  backlogWrite(['seed', '-'], { fastChecks: kv.fastChecks, gate: kv.gate, outOfScope: kv.outOfScope });
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
      const gateNames = kv.gate.map(g => g.name).join(', ') || 'none';
      backlogWrite(['note', '--kind', 'preflight', '--subject', 'campaign',
        '--body', `${res.tickets.length} open ticket(s). campaign gate: [${gateNames}]${kv.notes ? ` — ${kv.notes}` : ''}`]);
      tui.log(`kickoff complete: ${res.tickets.length} open ticket(s)`);
      return;
    } catch (e: any) {
      if (attempt >= 2) escalate(`kickoff: decomposition refused twice by backlog-write`, e.message);
      feedback = `## Your previous ticket set was REFUSED by validation — fix and resend the full set\n\n${e.message}`;
    }
  }
}

function ensureGitignore(): void {
  const lines = ['.ailoop/campaign/', '.ailoop/worktrees/'];
  const existing = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
  const missing = lines.filter(l => !existing.split('\n').includes(l));
  if (missing.length) fs.appendFileSync('.gitignore', (existing.endsWith('\n') || !existing ? '' : '\n') + missing.join('\n') + '\n');
}
