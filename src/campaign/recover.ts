// The recovery arm — one full-tool agent for every anomaly the deterministic
// spine can't handle. It is the universal `else`: every unenumerated situation
// (a stall, a refused mutation, a merit wall, a blocked worker, a red gate, a
// dirty mainline, an uncaught coordinator throw) routes here.
//
// Merged from what were three agents — triage (read-only router), resolver
// (verified campaign-definition fixes), repair (environment fixes) — into a
// single seat with full tools and ONE hard boundary: it fixes the campaign's
// DEFINITION (gates, scope, tickets, deps) and the ENVIRONMENT (installs, stale
// ports, wedged git) — never the product code. A product defect becomes a
// repair TICKET that goes through worker → verify → review, so every change to
// the work stays verified and reviewed; a coordinator-seat agent silently
// editing source would bypass the whole gate. It runs the check to prove its
// fix green and self-audits (no separate auditor); the coordinator applies the
// backlog mutations it returns. If it can't fix within jurisdiction it parks —
// a graceful defer to the human, not a stop. The only hard stop is the drive's
// crash membrane escalating on a repeated coordinator fault.

import { backlog, backlogWrite, nextTicketIds } from './backlog.ts';
import { journalTail } from './journal.ts';
import { agent, renderPrompt } from '../agent/agent.ts';
import { MODELS } from './models.ts';
import { RECOVER } from '../agent/schemas.ts';
import type { RecoverAction, RecoverVerdict, TicketDraft } from '../agent/schemas.ts';
import { park } from './escalate.ts';
import * as tui from '../tui/tui.ts';

// Whatever the coordinator couldn't enumerate — `kind` names the case, the
// rest is evidence for the recover agent.
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

// One anomaly, one attempt to recover it. Full tools: the agent reproduces the
// fault, fixes the environment directly with its tools if that's the problem,
// verifies any campaign-definition change by running the check, and returns the
// backlog mutations it proved green. Resolved with no actions is legitimate — an
// environment-only fix. Unresolved parks (optionally against `target`).
export async function recover(anomaly: Anomaly, target?: { ticketId?: string; subject?: string }): Promise<void> {
  const res = (await agent<RecoverVerdict>({
    prompt: renderPrompt('recover', {
      anomaly,
      backlogSummary: backlogSummary(),
      journal: journalTail(60),
    }),
    models: MODELS.recover,
    bypassPermissions: true, // full tools: run checks, reproduce, fix the box
    schema: RECOVER,
    label: `recover:${anomaly.kind}`,
  })).output;

  if (!res.resolved) {
    return park(res.reason || `recover could not resolve ${anomaly.kind} within jurisdiction`, target);
  }

  // Self-audited by the agent → the coordinator applies its backlog mutations.
  // A refused mutation is journaled, never silently dropped.
  const applied: string[] = [];
  for (const a of res.actions) {
    try {
      applied.push(await execAction(a, anomaly));
    } catch (e: any) {
      backlogWrite(['note', '--kind', 'recover-refused', '--subject', a.ticketId ?? a.command,
        '--body', `${a.command}: ${e.message}`]);
    }
  }
  backlogWrite(['note', '--kind', 'recovered', '--subject', anomaly.kind,
    '--body', `${res.evidence} — applied [${applied.join(', ') || '(env fix only)'}]`]);
  tui.log(`✓ recovered ${anomaly.kind}: [${applied.join(', ') || 'env fix'}]`);
}

// Apply one backlog mutation. Environment fixes are NOT actions — the agent
// performs those with its own tools during the run; only lawful backlog
// mutations come back here for the coordinator to execute.
export async function execAction(a: RecoverAction, anomaly: Anomaly): Promise<string> {
  switch (a.command) {
    case 'update':
      backlogWrite(['update', a.ticketId!, '-', '--note', a.note ?? 'recover',
        ...(a.resetAttempts ? ['--reset-attempts'] : [])], a.patch ?? {});
      return `update ${a.ticketId}${a.resetAttempts ? ' (attempts reset)' : ''}`;
    case 'set-status':
      backlogWrite(['set-status', a.ticketId!, a.to!, '--note', a.note ?? 'recover']);
      return `set-status ${a.ticketId} ${a.to}`;
    case 'add': {
      const tickets = renumber(a.tickets ?? []);
      backlogWrite(['add', '-'], tickets);
      return `add ${tickets.map(t => t.id).join('+')}`;
    }
    case 'note':
      backlogWrite(['note', '--kind', a.kind ?? 'recover-note', '--subject', a.subject ?? 'campaign', '--body', a.body ?? '']);
      return 'note';
    case 'gate': {
      if (!a.gates?.length) throw new Error('gate requires a non-empty gates array');
      backlogWrite(['gate', '-', '--note', a.note ?? `recover(${anomaly.kind})`], a.gates);
      return `gate [${a.gates.map(g => g.name).join(', ')}]`;
    }
    default:
      throw new Error(`illegal recover command ${a.command}`);
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
