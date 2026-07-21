// The universal `else`. Every situation the coordinator's switch doesn't
// enumerate lands here: a fresh-context agent proposes legal backlog
// mutations or escalates. Every invocation is journaled — the triage log is
// the coordinator's own escaped-bug record: each entry is a case the
// enumeration missed, to be promoted to a real arm or accepted as judgment.

import { backlog, backlogWrite, nextTicketIds } from './backlog.ts';
import { journalTail } from './journal.ts';
import { agent, renderPrompt } from '../agent/agent.ts';
import { MODELS } from './models.ts';
import { TRIAGE, REPAIR } from '../agent/schemas.ts';
import type { TriageAction, TriageVerdict, RepairVerdict, TicketDraft } from '../agent/schemas.ts';
import { escalate } from './escalate.ts';

// Whatever the coordinator couldn't enumerate — `kind` names the case, the
// rest is evidence for the triage agent.
export type Anomaly = { kind: string } & Record<string, unknown>;

export function backlogSummary() {
  const b = backlog();
  return {
    gate: (b.gate ?? []).map(g => g.name),
    outOfScope: b.outOfScope,
    tickets: b.tickets.map(t => ({
      id: t.id, title: t.title, status: t.status,
      depends_on: t.depends_on, files: t.files, attempts: (t.attempts ?? []).length,
    })),
  };
}

export async function triage(anomaly: Anomaly): Promise<TriageVerdict> {
  const res = await agent<TriageVerdict>({
    prompt: renderPrompt('triage', {
      anomaly,
      backlogSummary: backlogSummary(),
      journal: journalTail(60),
    }),
    models: MODELS.triage,
    schema: TRIAGE,
    tools: 'Read,Glob,Grep',
    label: `triage:${anomaly.kind}`,
  });

  if (res.output.escalate) escalate(`triage(${anomaly.kind}): ${res.output.escalate}`, anomaly);

  const applied: string[] = [];
  for (const a of res.output.actions) {
    try {
      applied.push(await execAction(a, anomaly));
    } catch (e: any) {
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

export async function execAction(a: TriageAction, anomaly: Anomaly): Promise<string> {
  switch (a.command) {
    case 'update':
      backlogWrite(['update', a.ticketId!, '-', '--note', a.note ?? 'triage',
        ...(a.resetAttempts ? ['--reset-attempts'] : [])], a.patch ?? {});
      return `update ${a.ticketId}${a.resetAttempts ? ' (attempts reset)' : ''}`;
    case 'set-status':
      backlogWrite(['set-status', a.ticketId!, a.to!, '--note', a.note ?? 'triage']);
      return `set-status ${a.ticketId} ${a.to}`;
    case 'add': {
      const tickets = renumber(a.tickets ?? []);
      backlogWrite(['add', '-'], tickets);
      return `add ${tickets.map(t => t.id).join('+')}`;
    }
    case 'note':
      backlogWrite(['note', '--kind', a.kind ?? 'triage-note', '--subject', a.subject ?? 'campaign', '--body', a.body ?? '']);
      return 'note';
    case 'gate': {
      if (!a.gates?.length) throw new Error('gate requires a non-empty gates array');
      backlogWrite(['gate', '-', '--note', a.note ?? `triage(${anomaly.kind})`], a.gates);
      return `gate [${a.gates.map(g => g.name).join(', ')}]`;
    }
    case 'repair': {
      // Triage's one actuator beyond the backlog: a fresh full-tool agent for
      // machine-level faults (installs, stale ports, wedged git state) — the
      // self-healing hands a session coordinator has and a script doesn't.
      // It fixes the environment, never the work; its report is journaled
      // either way, and an unresolved repair is a refused action, not a shrug.
      if (!a.instruction) throw new Error('repair requires an instruction');
      const r = (await agent<RepairVerdict>({
        prompt: renderPrompt('repair', { instruction: a.instruction, anomaly }),
        models: MODELS.repair,
        schema: REPAIR,
        bypassPermissions: true,
        label: `repair:${anomaly.kind}`,
      })).output;
      backlogWrite(['note', '--kind', 'repair', '--subject', anomaly.kind,
        '--body', `${r.resolved ? 'resolved' : 'NOT resolved'}: ${r.summary}`]);
      if (!r.resolved) throw new Error(`repair did not resolve: ${r.summary.slice(0, 300)}`);
      return 'repair';
    }
    default:
      throw new Error(`illegal triage command ${a.command}`);
  }
}

// Agents propose ids blind to concurrent additions — the coordinator owns
// id allocation.
export function renumber(tickets: TicketDraft[]): TicketDraft[] {
  const ids = nextTicketIds(tickets.length);
  const remap = new Map(tickets.map((t, i) => [t.id, ids[i]!]));
  return tickets.map((t, i) => ({
    ...t,
    id: ids[i]!,
    depends_on: (t.depends_on ?? []).map(d => remap.get(d) ?? d),
  }));
}
