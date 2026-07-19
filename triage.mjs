// The universal `else`. Every situation the coordinator's switch doesn't
// enumerate lands here: a fresh-context agent proposes legal backlog
// mutations or escalates. Every invocation is journaled — the triage log is
// the coordinator's own escaped-bug record: each entry is a case the
// enumeration missed, to be promoted to a real arm or accepted as judgment.

import { backlog, backlogWrite, journalTail, nextTicketIds } from './run.mjs';
import { agentRetry, renderPrompt } from './agent.mjs';
import { TRIAGE } from './schemas.mjs';
import { escalate } from './escalate.mjs';

export function backlogSummary() {
  const b = backlog();
  return {
    phases: b.phases.map(p => p.id),
    outOfScope: b.outOfScope,
    tickets: b.tickets.map(t => ({
      id: t.id, title: t.title, status: t.status, phase: t.phase,
      depends_on: t.depends_on, files: t.files, attempts: (t.attempts ?? []).length,
    })),
  };
}

export async function triage(anomaly) {
  const res = await agentRetry({
    prompt: renderPrompt('triage', {
      anomaly,
      backlogSummary: backlogSummary(),
      journal: journalTail(60),
    }),
    model: 'opus',
    schema: TRIAGE,
    tools: 'Read,Glob,Grep',
    label: `triage:${anomaly.kind}`,
  });

  if (res.output.escalate) escalate(`triage(${anomaly.kind}): ${res.output.escalate}`, anomaly);

  const applied = [];
  for (const a of res.output.actions) {
    try {
      applied.push(execAction(a));
    } catch (e) {
      // A refused mutation is journaled, never silently dropped; if the
      // anomaly persists, the drive's stall guard escalates with this trail.
      backlogWrite(['note', '--kind', 'triage-refused', '--subject', a.ticketId ?? a.command,
        '--body', `${a.command}: ${e.message}`]);
    }
  }
  backlogWrite(['note', '--kind', 'triage', '--subject', anomaly.kind,
    '--body', `${res.output.summary} — applied [${applied.join(', ')}]`]);
  return res.output;
}

function execAction(a) {
  switch (a.command) {
    case 'update':
      backlogWrite(['update', a.ticketId, '-', '--note', a.note ?? 'triage'], a.patch ?? {});
      return `update ${a.ticketId}`;
    case 'set-status':
      backlogWrite(['set-status', a.ticketId, a.to, '--note', a.note ?? 'triage']);
      return `set-status ${a.ticketId} ${a.to}`;
    case 'add': {
      const tickets = renumber(a.tickets ?? []);
      backlogWrite(['add', '-'], tickets);
      return `add ${tickets.map(t => t.id).join('+')}`;
    }
    case 'note':
      backlogWrite(['note', '--kind', a.kind ?? 'triage-note', '--subject', a.subject ?? 'campaign', '--body', a.body ?? '']);
      return 'note';
    default:
      throw new Error(`illegal triage command ${a.command}`);
  }
}

// Agents propose ids blind to concurrent additions — the coordinator owns
// id allocation.
export function renumber(tickets) {
  const ids = nextTicketIds(tickets.length);
  const remap = new Map(tickets.map((t, i) => [t.id, ids[i]]));
  return tickets.map((t, i) => ({
    ...t,
    id: ids[i],
    depends_on: (t.depends_on ?? []).map(d => remap.get(d) ?? d),
  }));
}
