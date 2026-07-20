// The critic pass — how draft tickets get vetted. One agent, five questions,
// patches applied through the sole writer, accepted risks on the record.

import { backlog, backlogWrite } from './backlog.ts';
import { readLearnings } from './state.ts';
import type { JournalEntry } from './journal.ts';
import { agentRetry, renderPrompt } from '../agent/agent.ts';
import { CRITIC } from '../agent/schemas.ts';
import type { CriticVerdict } from '../agent/schemas.ts';
import { triage } from './triage.ts';
import { escalate } from './escalate.ts';

const rounds = new Map<string, number>(); // ticketId -> critic rounds consumed

export async function vetDrafts(): Promise<void> {
  const drafts = backlog().tickets.filter(t => t.status === 'draft');
  if (!drafts.length) return;

  const walled = drafts.filter(t => (rounds.get(t.id) ?? 0) >= 3);
  if (walled.length) escalate(`tickets unvettable after 3 critic rounds: ${walled.map(t => t.id).join(', ')}`);
  for (const t of drafts) rounds.set(t.id, (rounds.get(t.id) ?? 0) + 1);

  const learnings = readLearnings();
  const b = backlog();
  const res = await agentRetry<CriticVerdict>({
    prompt: renderPrompt('critic', {
      tickets: drafts,
      outOfScope: b.outOfScope ?? [],
      gamingLearnings: learnings?.['gaming.md']
        ? `## Cheat shapes observed in past campaigns\n\n${learnings['gaming.md']}`
        : '',
    }),
    model: 'sonnet',
    schema: CRITIC,
    tools: 'Read,Glob,Grep',
    label: 'critic',
  });

  for (const item of res.output.tickets) {
    if (!drafts.some(d => d.id === item.ticketId)) continue; // hallucinated id — drop
    if (item.patch && Object.keys(item.patch).length) {
      try {
        backlogWrite(['update', item.ticketId, '-', '--note', 'critic pass'], item.patch);
      } catch (e: any) {
        await triage({ kind: 'critic-patch-refused', ticketId: item.ticketId, patch: item.patch, refusal: e.message });
        continue; // next critic round re-reads whatever triage decided
      }
    }
    for (const risk of item.acceptedRisks) {
      backlogWrite(['note', '--kind', 'accepted-risk', '--subject', item.ticketId,
        '--body', `[${risk.severity}] ${risk.issue} — accepted: ${risk.why}`]);
    }
    try {
      backlogWrite(['vet', item.ticketId, '--note',
        `critic pass: ${item.findings.length} finding(s), ${item.acceptedRisks.length} accepted risk(s)`]);
      rounds.delete(item.ticketId);
    } catch (e: any) {
      await triage({ kind: 'vet-refused', ticketId: item.ticketId, refusal: e.message });
    }
  }
}

// Accepted risks feed the judge — a green check doesn't clear a blindness the
// critic already flagged.
export function acceptedRisks(journal: JournalEntry[], ticketId: string): string[] {
  return journal.filter(j => j.kind === 'accepted-risk' && j.subject === ticketId).map(j => j.body ?? '');
}
