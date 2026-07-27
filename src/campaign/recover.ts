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
//
// Two of those boundaries are enforced here rather than asked for in the prompt,
// because this seat is the one with nothing above it: jurisdiction.ts reverts
// any product-code edit the run leaves behind (routeBreach turns it into a
// repair ticket), and the budget below stops calling a fresh agent about an
// anomaly it has already resolved twice. Both exist for the same reason — recover
// cannot audit itself across invocations, since every invocation is its first.

import { backlog, backlogWrite, nextTicketIds } from './backlog.ts';
import { amendGate, GATE_RED } from './gate.ts';
import type { GateAuthority } from './gate.ts';
import { breachedModules, revertOutOfBounds, snapshotTree } from './jurisdiction.ts';
import type { Breach } from './jurisdiction.ts';
import { journalEntries, journalTail } from './journal.ts';
import type { JournalEntry } from './journal.ts';
import { withMainline } from './mainline.ts';
import { agent, renderPrompt } from '../agent/agent.ts';
import { MODELS } from './models.ts';
import { RECOVER } from '../agent/schemas.ts';
import type { RecoverAction, RecoverVerdict, TicketDraft } from '../agent/schemas.ts';
import { park } from './escalate.ts';
import * as tui from '../tui/tui.ts';

// Whatever the coordinator couldn't enumerate — `kind` names the case, the
// rest is evidence for the recover agent.
export type Anomaly = { kind: string } & Record<string, unknown>;

// How many times recover may RESOLVE the same anomaly before the campaign stops
// believing it. Matched to the drive's per-ticket merit-wall budget: the
// reasoning is identical one level up.
const RECOVER_BUDGET = 2;

// What counts as "the same anomaly". A ticket-scoped kind budgets per ticket —
// two different tickets each walling once is ordinary campaign life, not a
// pattern — while a campaign-scoped kind budgets per campaign.
export const recoverKey = (a: Anomaly): string =>
  typeof a.ticketId === 'string' ? `${a.kind}:${a.ticketId}` : a.kind;

// Prior RESOLVED recoveries of the same key. Resolution is what makes a repeat
// damning: recover said it fixed the campaign definition and the same anomaly
// came back, which is what a spine bug looks like from inside the loop — a real
// defect papered over one journal note at a time, each note reading like a
// success. An unresolved recover parked instead, and nothing re-arms a park.
//
// Counted off the journal rather than a coordinator map so the budget survives
// `loop resume`: a counter that resets on restart cannot see a loop that spans
// one, and a gate-red → repair → gate-red cycle easily does.
//
// Total, not consecutive. A kind that returns after an apparent success is the
// signal, whether or not something else went green in between — which is also
// what bounds the campaign-gate red loop, since every round of it resolves.
export function priorRecoveries(key: string): JournalEntry[] {
  return journalEntries().filter(e => e.kind === 'recovered' && e.data?.key === key);
}

export function backlogSummary() {
  const b = backlog();
  return {
    gate: (b.gate ?? []).map(g => g.name),
    outOfScope: b.outOfScope,
    tickets: b.tickets.map(t => ({
      id: t.id, title: t.title, status: t.status,
      depends_on: t.depends_on, modules: t.modules, attempts: (t.attempts ?? []).length,
    })),
  };
}

// One anomaly, one attempt to recover it. Full tools: the agent reproduces the
// fault, fixes the environment directly with its tools if that's the problem,
// verifies any campaign-definition change by running the check, and returns the
// backlog mutations it proved green. Resolved with no actions is legitimate — an
// environment-only fix. Unresolved parks (optionally against `target`).
//
// It runs holding the mainline: full tools on the repo root for minutes, while
// other tickets are settling, is exactly the contention mainline.ts exists for.
// The lock is not reentrant, so no caller may invoke this from inside its own
// mainline section — the two repairs that arise while landing a ticket are
// hoisted out of that section for this reason.
export async function recover(anomaly: Anomaly, target?: { ticketId?: string; subject?: string }): Promise<void> {
  const key = recoverKey(anomaly);
  const prior = priorRecoveries(key);
  if (prior.length >= RECOVER_BUDGET) {
    // Not a fresh anomaly: the same one, returning. Invoking a fresh-context
    // agent again would produce a third confident fix and a third success note.
    // The accumulated prior fixes are the evidence the human needs, so they ride
    // the park reason rather than staying scattered down the journal.
    tui.log(`⏸ ${key}: ${prior.length} recoveries already resolved this — parking`);
    return park(
      `recover has resolved ${key} ${prior.length}× and it came back — a recurring anomaly is a spine bug, not a fresh fault. Prior fixes: ${prior.map(e => e.body ?? '').join(' | ').slice(0, 1000)}`,
      target,
    );
  }
  return withMainline(() => recoverHoldingMainline(anomaly, target));
}

async function recoverHoldingMainline(anomaly: Anomaly, target?: { ticketId?: string; subject?: string }): Promise<void> {
  const before = snapshotTree();
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

  // Before the verdict is read, and whether or not it claims success: an
  // out-of-bounds edit is a fact about the tree, not a claim in the reply.
  routeBreach(revertOutOfBounds(before), anomaly, target);

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
  // `key` on the data, not just the kind on the subject: the budget above counts
  // ticket-scoped kinds per ticket, and the subject is what the dashboard and
  // the post-mortem group by.
  backlogWrite(['note', '--kind', 'recovered', '--subject', anomaly.kind,
    '--body', `${res.evidence} — applied [${applied.join(', ') || '(env fix only)'}]`,
    '--data', JSON.stringify({ key: recoverKey(anomaly) })]);
  tui.log(`✓ recovered ${anomaly.kind}: [${applied.join(', ') || 'env fix'}]`);
}

// Replacing a live gate command is justified by one thing: this seat is
// answering that gate's own red run, and had the failing command, the branches,
// and full tools to re-run a correction green. Every other anomaly — a stall, a
// dirty mainline, a walled ticket, a coordinator crash — reaches recover without
// having run the gate at all, so it may only ADD coverage. The kind is stamped
// by the coordinator at the call site, so it is a fact about the invocation, not
// a claim the agent can make about itself.
export const gateAuthority = (anomaly: Anomaly): GateAuthority =>
  anomaly.kind === GATE_RED ? 'apply' : 'refuse';

// A reverted breach still has to go somewhere: recover touched product code
// because it believed something there was broken, and throwing that belief away
// is as wrong as letting the edit stand. It becomes a repair ticket — a worker
// builds it, the review judges it, the gate measures it, which is the whole
// point of keeping recover out of the file.
//
// The ticket hangs its acceptance on the campaign's fast tier. Without one there
// is no check to hold a repair to, and inventing a green-by-construction check
// would be worse than the breach; that case parks with the diff instead.
function routeBreach(breach: Breach, anomaly: Anomaly, target?: { ticketId?: string; subject?: string }): void {
  if (!breach.paths.length) return;

  const where = breach.paths.join(', ');
  tui.log(`⚠ recover(${anomaly.kind}) edited product code — ${breach.reverted ? 'reverted' : 'STANDING'} [${where}]`);
  backlogWrite(['note', '--kind', 'recover-out-of-bounds', '--subject', anomaly.kind,
    '--body', `${breach.reverted ? 'reverted' : 'COULD NOT REVERT'} tracked product-code changes outside recover's jurisdiction: [${where}]`]);

  // A breach that could not be undone is not a repair-ticket situation: the
  // unreviewed edit is on the mainline the gate will measure, and only a human
  // can decide whether to keep or unwind it.
  // A park reason is read in a dashboard pane and a drain report, so it carries
  // the head of the diff; the full capture goes to a repair ticket's context
  // when there is one, and to the reverted tree's reflog when there isn't.
  const excerpt = breach.diff.slice(0, 2000);

  if (!breach.reverted) {
    return park(`recover(${anomaly.kind}) committed product-code changes [${where}] that could not be safely undone — the campaign's own state is tracked in this repository, so resetting the mainline would have rolled back the backlog and journal too. The mainline is carrying an unreviewed change. Diff (head):\n${excerpt}`, target);
  }

  const checks = backlog().fastChecks ?? [];
  if (!checks.length) {
    return park(`recover(${anomaly.kind}) changed product code [${where}], which was reverted. No fast check exists to hold a repair ticket to, so the intent needs a human. Reverted diff (head):\n${excerpt}`, target);
  }

  const [repair] = renumber([{
    id: 'R1',
    title: `repair: the product-code change recover made outside its jurisdiction`,
    modules: breachedModules(breach.paths),
    origin: `repair: recover(${anomaly.kind}) edited tracked product code`,
    context: `While recovering \`${anomaly.kind}\`, recover changed tracked product code at [${where}]. That is outside its jurisdiction — it may fix the campaign definition and the environment, never the product — so the change was reverted before it could reach the gate. Recover is not authoritative here and may have been wrong; treat the diff as a hypothesis to verify against the locked spec, not a patch to re-apply. If the defect is real, fix it at source and add the check that should have caught it. If it is not, close this out by explaining why in the summary rather than making an unrelated change.\n\nReverted diff:\n${breach.diff}`,
    acceptance: 'The defect recover was reaching for is fixed at source with a check that fails without the fix, or the ticket reports that no defect exists.',
    acceptanceChecks: checks,
  }]);
  backlogWrite(['add', '-'], [repair]);
  backlogWrite(['note', '--kind', 'recover-out-of-bounds', '--subject', repair!.id,
    '--body', `repair ticket ${repair!.id} carries the reverted intent`]);
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
      return amendGate(a.gates, {
        by: `recover(${anomaly.kind})`,
        // `||`, not `??`: an empty note is refused by the sole writer, and the
        // refusal would land after gate.ts had already journaled the amendment.
        note: a.note || `recover(${anomaly.kind})`,
        replacements: gateAuthority(anomaly),
      });
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
