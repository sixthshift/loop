// Amending the fast tier — the per-ticket baseline handed to every worker and run
// by every verify. Kickoff seeds it, and it used to be fixed for the campaign's
// life: recover could reach a ticket's own checks and the merged-tree gate, but
// nothing could reach a fastCheck. A fast check that turns out to measure the
// environment rather than the product therefore reds every ticket identically,
// each dispatch burns on a fault no ticket owns, and the loop's only remaining
// move is to page a human. This file is the actuator that was missing.
//
// Authority here is MEASURED, not granted. gate.ts splits by anomaly kind because
// nothing can prove a merged-tree gate command is honest without running it, and
// only one arm ever holds a red gate. The fast tier has a property the gate does
// not: it must be green on the mainline as it stands — kickoff refuses to start
// over a red baseline. So the coordinator runs each proposed command in the
// primary checkout and refuses every one that doesn't exit 0. A replacement that
// passes has demonstrated the one invariant the tier claims; a replacement that
// fails is rejected on the record whoever proposed it.
//
// Rejected: mirroring gate.ts's add/replace authority split. It would admit an
// unmeasured replacement because a privileged anomaly kind proposed it, and
// refuse a measured one because an ordinary kind did — trading a fact for a label
// when the fact is two seconds away.
//
// The scar: green-here is not green-everywhere. Proving a command on the mainline
// says nothing about a worktree that a diff has changed, which is exactly the
// campaign's business — so this can seat a command that passes at the root and
// fails in a worker. That is the same exposure kickoff's baseline probe has, and
// it is why the amendment lands in the journal under its own kind rather than
// inside a `recovered` note.

import { backlog, backlogWrite } from './backlog.ts';
import { shAsync } from './state.ts';
import type { Check } from './agents/schemas.ts';

export type FastCheckEdit = {
  added: Check[];
  // `was` is the command in force when the amendment was proposed — the record is
  // worthless without the before.
  replaced: { check: Check; was: string }[];
};

// Re-proposing the tier exactly as it stands is neither act: an idempotent no-op,
// which must not cost a measurement run or an audit entry.
export function classifyFastCheckEdit(proposed: Check[]): FastCheckEdit {
  const inForce = backlog().fastChecks ?? [];
  const edit: FastCheckEdit = { added: [], replaced: [] };
  for (const c of proposed) {
    const existing = inForce.find(x => x.name === c.name);
    if (!existing) edit.added.push(c);
    else if (existing.cmd !== c.cmd) edit.replaced.push({ check: c, was: existing.cmd });
  }
  return edit;
}

// Apply an amendment, admitting only what runs green in the primary checkout.
//
// These commands run at the repo root, so the caller must not have other tickets
// landing while they do — a candidate measured against a tree that is being merged
// into proves nothing about the baseline. Nothing enforces that here: the
// coordinator serializes it (SKILL.md invariant 3), because a lock held across
// separate verb invocations is not available to a seat that is a conversation.
export async function amendFastChecks(
  proposed: Check[],
  opts: { by: string; note: string },
): Promise<string> {
  const { added, replaced } = classifyFastCheckEdit(proposed);
  const candidates = [...added, ...replaced.map(r => r.check)];

  const admitted: Check[] = [];
  for (const c of candidates) {
    const r = await shAsync(c.cmd, '.', { label: `fast-check:${c.name}` });
    if (r.status === 0) { admitted.push(c); continue; }
    backlogWrite(['note', '--kind', 'fast-check-refused', '--subject', c.name,
      '--body', `${opts.by} proposed \`${c.cmd}\` for the fast tier and it exited ${r.status} on the mainline — the tier's one invariant is that it is green there. ${opts.note}\n${(r.stdout + r.stderr).slice(-1500)}`]);
  }

  if (admitted.length) backlogWrite(['fast-checks', '-', '--note', opts.note], admitted);

  // The persistent tier lands before its replacement audit. A missing audit
  // must never leave the backlog claiming the old command is still in force.
  for (const r of replaced) {
    if (!admitted.includes(r.check)) continue;
    backlogWrite(['note', '--kind', 'fast-check-replaced', '--subject', r.check.name,
      '--body', `${opts.by} replaced the fast-tier command — was: ${r.was} — now: ${r.check.cmd} — ${opts.note}`]);
  }

  const touched = candidates.map(c => {
    const mark = !admitted.includes(c) ? '✗' : replaced.some(r => r.check === c) ? '~' : '+';
    return `${mark}${c.name}`;
  });
  return `fast tier [${touched.join(', ') || 'no change'}]`;
}
