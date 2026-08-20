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
// The scar: green-here is green-on-the-baseline only. Proving a command on
// mainline says nothing about the same command over a ticket branch's diff —
// which is exactly the campaign's business — so this can seat a command that
// passes at the baseline and fails over a worker's change. That is the same
// exposure kickoff's baseline probe has, and it is why the amendment lands in
// the journal under its own kind rather than inside a `recovered` note.

import { backlog, backlogWrite } from './backlog.ts';
import { assertOnMainline } from './checkout.ts';
import { runChecks } from './checks.ts';
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

// Apply an amendment, admitting only what runs green on the mainline.
//
// The candidates run in the primary checkout, and serial dispatch makes the
// wrong tree an ordinary hazard rather than a scheduling accident: a verify
// red mid-ticket — the very moment amendments get proposed — leaves HEAD on
// the ticket branch, half-built. So the guard is mechanical: refuse to
// measure anywhere but the recorded mainline, rather than asking the seat to
// remember (a conversation cannot hold a lock across verb invocations).
export async function amendFastChecks(
  proposed: Check[],
  opts: { by: string; note: string },
): Promise<string> {
  assertOnMainline('fastcheck-amend', "a candidate proven green here would be measured against a ticket's half-built tree, not the baseline");

  const { added, replaced } = classifyFastCheckEdit(proposed);
  const candidates = [...added, ...replaced.map(r => r.check)];

  const measured = await runChecks(candidates, { label: 'fast-check' });
  // Keyed by name, like the tier itself — classify puts a name in exactly one
  // bucket, so a name is a candidate's identity here as much as anywhere else.
  const green = new Set(measured.filter(r => r.status === 0).map(r => r.name));
  const admitted = candidates.filter(c => green.has(c.name));
  for (const r of measured) {
    if (r.status === 0) continue;
    backlogWrite(['note', '--kind', 'fast-check-refused', '--subject', r.name,
      '--body', `${opts.by} proposed \`${r.cmd}\` for the fast tier and it exited ${r.status} on the mainline — the tier's one invariant is that it is green there. ${opts.note}\n${r.output.slice(-1500)}`]);
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
