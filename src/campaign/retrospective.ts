// Termination — coverage pass, report, post-mortem, learnings harvest,
// campaign close. Runs only when frontier reports complete and every phase
// gate is journaled green.

import fs from 'node:fs';
import path from 'node:path';
import { backlog, backlogWrite } from './backlog.ts';
import { journalEntries } from './journal.ts';
import { RUN, LEARNINGS, WORKTREES, sh } from './state.ts';
import type { CampaignContext } from './state.ts';
import { agentRetry, renderPrompt } from '../agent/agent.ts';
import { COVERAGE, HARVEST } from '../agent/schemas.ts';
import type { CoverageVerdict, HarvestVerdict } from '../agent/schemas.ts';
import { renumber } from './triage.ts';
import { escalate } from './escalate.ts';
import * as tui from '../tui/tui.ts';

// Returns { resume: true } when coverage found unmapped requirements —
// the drive picks the new tickets up and the campaign continues.
export async function retrospective(ctx: CampaignContext): Promise<{ resume: boolean }> {
  const b = backlog();
  const phaseCloses = journalEntries().filter(j => j.kind === 'phase-close');
  const unGated = b.phases.filter(p => !phaseCloses.some(j => j.subject === p.id));
  if (unGated.length) escalate(`termination reached with unrun phase gates: ${unGated.map(p => p.id).join(', ')}`);

  tui.log('retrospective: coverage pass…');
  const closed = b.tickets.filter(t => t.status === 'closed');
  const cov = (await agentRetry<CoverageVerdict>({
    prompt: renderPrompt('coverage', {
      spec: ctx.spec,
      tickets: closed.map(t => ({ id: t.id, title: t.title, acceptance: t.acceptance, evidence: t.evidence })),
      phaseCloses,
    }),
    model: 'opus',
    schema: COVERAGE,
    tools: 'Read,Glob,Grep',
    label: 'coverage',
  })).output;

  if (!cov.done && cov.missing.length) {
    const tickets = renumber(cov.missing);
    backlogWrite(['add', '-'], tickets);
    backlogWrite(['note', '--kind', 'coverage-gap', '--subject', 'campaign',
      '--body', `${cov.summary} — spawned [${tickets.map(t => t.id).join(', ')}]`]);
    tui.log(`coverage found gaps — resuming drive with ${tickets.length} new ticket(s)`);
    return { resume: true };
  }

  tui.log('retrospective: harvest…');
  const prose: Record<string, string> = {};
  for (const f of ['sizing.md', 'gaming.md', 'landmines.md']) {
    const p = path.join(LEARNINGS, f);
    prose[f] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '(empty — first campaign)';
  }
  const h = (await agentRetry<HarvestVerdict>({
    prompt: renderPrompt('harvest', {
      campaign: b.project,
      proseFacets: prose,
      journal: journalEntries(),
    }),
    model: 'opus',
    schema: HARVEST,
    tools: 'Read',
    label: 'harvest',
  })).output;

  // Keyed facets merge mechanically; prose facets land as the agent's merged text.
  fs.mkdirSync(LEARNINGS, { recursive: true });
  const harvestFile = path.join(RUN, 'harvest.json');
  fs.writeFileSync(harvestFile, JSON.stringify({ checks: h.checks, flakes: h.flakes }, null, 2));
  const merge = sh(`node ${path.join(RUN, 'learn.mjs')} merge --in ${harvestFile} --campaign ${b.project}`);
  if (merge.status !== 0) console.error(`learn.mjs merge failed (non-fatal): ${merge.stderr}`);
  fs.writeFileSync(path.join(LEARNINGS, 'sizing.md'), h.sizingMd);
  fs.writeFileSync(path.join(LEARNINGS, 'gaming.md'), h.gamingMd);
  fs.writeFileSync(path.join(LEARNINGS, 'landmines.md'), h.landminesMd);

  // Post-mortem BEFORE campaign/ deletion — the HTML is the journal's survival.
  const postmortem = ctx.specPath.replace(/\.md$/, '') + '.postmortem.html';
  const pm = sh(`node ${path.join(RUN, 'postmortem.mjs')} --out ${postmortem}`);
  if (pm.status !== 0) escalate(`postmortem.mjs failed — refusing to delete campaign/ without the archive: ${pm.stderr}`);

  flipSpecDone(ctx.specPath);
  backlogWrite(['note', '--kind', 'campaign-close', '--subject', 'campaign', '--body', 'complete; all gates green']);

  tui.stop(); // the report is for a scrollback reader, not a live pane
  console.log('\n════════ CAMPAIGN REPORT ════════\n');
  console.log(h.report);
  console.log(`\npost-mortem: ${postmortem}`);

  fs.rmSync(RUN, { recursive: true, force: true });
  fs.rmSync(WORKTREES, { recursive: true, force: true });
  sh('git worktree prune');
  return { resume: false };
}

function flipSpecDone(specPath: string): void {
  const text = fs.readFileSync(specPath, 'utf8');
  if (!text.startsWith('---')) return; // no frontmatter — nothing to flip
  const updated = text.replace(/^(---[\s\S]*?)status:\s*\S+([\s\S]*?---)/, '$1status: done$2');
  if (updated !== text) fs.writeFileSync(specPath, updated);
}
