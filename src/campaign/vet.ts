// The pre-dispatch vacuity measurement: a check that already passes cannot be
// observing work that does not exist yet.
//
// Every other guard in the loop reads a check's verdict AFTER a worker has built
// against it. Nothing read the check itself, so a command that was green on
// mainline — a suite whose glob never reached the new directory, a script
// asserting only its own exit code — was dispatched, built against, verified
// green, and only then rejected by a judge constructing the variant it could not
// see. That round trip costs a build, a review and a merit attempt to learn
// something that was already true before any code existed.
//
// This is a measurement rather than a judgement, which is why it lives here and
// not in a prompt: "I checked that the check fails first" is a claim, and the
// same claim `fastcheck-amend` refuses to take on trust. It is the inverse of
// that verb — one admits only commands that pass at the root, this one reports
// the ones that do.
//
// It never refuses a dispatch. A check-only ticket claiming a clause the tree
// already satisfies is legitimate and its checks are green by construction; so
// is a ticket whose dependency delivered the behaviour. The fault is a vacuous
// check nobody noticed, not a green one, and only the coordinator can tell them
// apart — so this reports and journals, and the decision stays a seat's.

import { runChecks } from './checks.ts';
import { ticket } from './backlog.ts';
import { appendJournal } from './journal.ts';

export type VetRun = { name: string; status: number | null; ms: number; vacuous: boolean; timedOut: boolean };
export type VetVerdict = { ticket: string; vacuous: string[]; red: string[]; runs: VetRun[] };

export async function vet({ id, dir }: { id: string; dir: string }): Promise<VetVerdict> {
  const t = ticket(id);
  const checks = t.acceptanceChecks ?? [];
  // A check that PASSES here is the finding, which is why this reads the runs
  // itself rather than asking checks.ts for the failing names: vacuity is the
  // inverse of every other caller's question.
  const runs: VetRun[] = (await runChecks(checks, { dir, label: `vet:${id}`, ticketId: id }))
    .map(({ name, status, ms, timedOut }) => ({ name, status, ms, timedOut, vacuous: status === 0 }));
  const vacuous = runs.filter(r => r.vacuous).map(r => r.name);
  const red = runs.filter(r => !r.vacuous).map(r => r.name);

  // Journaled whatever the result: a ticket whose checks were all red before
  // dispatch is the evidence that the later green means something, and that
  // record is worth as much as the warning.
  appendJournal({
    kind: 'vet', subject: id,
    body: vacuous.length
      ? `${vacuous.length}/${checks.length} acceptance check(s) already pass on the base: [${vacuous.join(', ')}]`
      : `all ${checks.length} acceptance check(s) red on the base`,
    data: { vacuous, red, runs },
  });

  return { ticket: id, vacuous, red, runs };
}
