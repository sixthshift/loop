// Amending the campaign gate — the one agent-proposed mutation that edits the
// criteria deciding whether the product is correct. gate-run.ts owns execution;
// this file owns the derived green policy plus who may change the gate and how
// the change is recorded.
//
// The sole writer's `gate` command upserts by name, so one action shape carries
// two different acts. A name not yet in force only ADDS coverage — a green
// campaign stays at least as honest as it was, so any arm may add. An existing
// name REPLACES a command that is right now deciding correctness, and that can
// turn a real escaped bug into a green campaign. Nothing mechanical separates
// the two kinds of replacement: `bun test --filter smoke` and `bun test && bun
// run lint` are both just "the cmd changed". So the split is by name, which IS
// decidable, and the authority to replace belongs to the caller — recover has
// run the corrected command green and self-audited; sweep holds a read-only
// toolset and cannot run anything.
//
// Rejected: parking every replacement for the human. Re-scoping a gate that
// runs the wrong things or contends on shared state is an enumerated recover
// repair (see the GATE_RED instruction), and it is the only path a red gate has
// back to green without a human. Parking it would trade a rare bad narrowing
// for a common dead campaign. A replacement is applied instead — but never
// buried: it lands under its own journal kind, with the command it displaced,
// so the post-mortem reads a narrowed gate as an event rather than as a clause
// inside a `recovered` note.

import { backlog, backlogWrite } from './backlog.ts';
import type { Check } from './agents/schemas.ts';

// The anomaly kind the drive stamps when the merged-tree gate fails. Shared
// because it is the discriminator for gate authority below: it names the one
// recover invocation that arrives holding a gate's own failure, having had the
// chance to re-run a correction green.
export const GATE_RED = 'campaign-gate-red';

// What a caller may do with a command that is already deciding correctness.
export type GateAuthority = 'apply' | 'refuse';

// Replacing a live gate command is granted by the anomaly, not claimed by the
// caller — which is why this derives the authority from the kind rather than
// taking it as an argument. Exactly one invocation may replace: a recover
// answering that gate's own red run, the one caller that held the failure and
// could re-run its correction green. Every other arm reaches a gate amendment
// without having run the gate, so for them a reused name is refused and
// journaled. Asking the caller to self-report its authority would make the rule
// advisory, and the rule is the only thing standing between an escaped bug and a
// gate quietly edited into agreeing with it.
export const gateAuthority = (anomalyKind: string): GateAuthority =>
  anomalyKind === GATE_RED ? 'apply' : 'refuse';

export type GateEdit = {
  added: Check[];
  // `was` is the command in force when the amendment was proposed — the record
  // is worthless without the before.
  replaced: { gate: Check; was: string }[];
};

// A green run only covers the backlog snapshot it measured. Ticket and closed
// counts are monotone, so equality proves no work was added or landed since.
// This is gate-state policy, not drive-loop orchestration; completion and
// retrospective both depend on the same derived fact.
export function gateGreen(): boolean {
  const b = backlog();
  if (!b.gate?.length) return true;
  const run = b.gateState?.lastRun;
  if (run?.result !== 'green') return false;
  return run.tickets === b.tickets.length
    && run.closed === b.tickets.filter(t => t.status === 'closed').length;
}

// Re-proposing a gate exactly as it stands is neither act: it is an idempotent
// no-op, and dignifying it with an audit entry would bury the real ones.
export function classifyGateEdit(proposed: Check[]): GateEdit {
  const inForce = backlog().gate ?? [];
  const edit: GateEdit = { added: [], replaced: [] };
  for (const g of proposed) {
    const existing = inForce.find(x => x.name === g.name);
    if (!existing) edit.added.push(g);
    else if (existing.cmd !== g.cmd) edit.replaced.push({ gate: g, was: existing.cmd });
  }
  return edit;
}

// Apply an amendment under the caller's authority. `replacements` says what may
// happen to a command already deciding correctness — 'apply' for an arm that
// proved the replacement green, 'refuse' for one that could not. Either way the
// replacement is journaled: applied under `gate-replaced` (mechanical name on
// purpose — whether it narrowed is the auditor's call, not the coordinator's),
// refused under `gate-refused`. Additions are applied unconditionally.
export function amendGate(
  proposed: Check[],
  opts: { by: string; note: string; replacements: GateAuthority },
): string {
  const { added, replaced } = classifyGateEdit(proposed);
  const apply = opts.replacements === 'apply';

  // The authority to replace and the authority to answer a park are the same
  // fact about the caller: it is the arm the red gate handed its own failure to.
  // Sweep adding a check while the campaign waits on a human must leave the
  // latch exactly where the human left it.
  const applied = apply ? [...added, ...replaced.map(r => r.gate)] : added;
  if (applied.length) backlogWrite(['gate', '-', '--note', opts.note, ...(apply ? ['--release-latch'] : [])], applied);

  for (const r of replaced) {
    backlogWrite(['note', '--kind', apply ? 'gate-replaced' : 'gate-refused', '--subject', r.gate.name,
      '--body', `${opts.by} ${apply ? 'replaced' : 'proposed replacing'} the gate command — was: ${r.was} — now: ${r.gate.cmd} — ${opts.note}`]);
  }

  const touched = [
    ...added.map(g => `+${g.name}`),
    ...replaced.map(r => `${apply ? '~' : '✗'}${r.gate.name}`),
  ];
  return `gate [${touched.join(', ') || 'no change'}]`;
}
