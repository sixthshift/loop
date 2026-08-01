// When the campaign stops believing its own recoveries.
//
// Recover is the coordinator's universal else: any anomaly nothing enumerated
// gets a fresh full-tool agent that diagnoses it, fixes the campaign definition
// or the environment, proves the fix, and reports success. The failure mode this
// file exists for is that report being wrong. A fault that returns after an
// apparent repair is a defect in the loop, not a fresh fault, and a third
// fresh-context agent will write a third confident success note — so past two
// resolutions of the same anomaly the campaign parks with the prior fixes
// attached instead of calling again.
//
// Two things make that a mechanic rather than a habit:
//
//   • What counts as "the same anomaly" is a scoping rule, not a judgment. Get it
//     wrong in the loose direction and the budget never trips, which is
//     indistinguishable from having no budget: the loop recovers the same fault
//     forever, reporting progress each time. A coordinator reasoning about the key
//     in prose is exactly how that happens.
//   • The count is durable state, in backlog.json, not a number reconstructed
//     from audit events. It has to survive a resume, and it has to survive the
//     coordinator's context being compacted — which is the other reason it is not
//     the model's to remember.

import { backlog } from './backlog.ts';

// Whatever nothing enumerated — `kind` names the case, the rest is evidence for
// the recover agent.
export type Anomaly = { kind: string } & Record<string, unknown>;

// How many times recover may RESOLVE the same anomaly before the campaign stops
// believing it. Matched to a ticket's merit-wall budget: the reasoning is
// identical one level up.
export const RECOVER_BUDGET = 2;

// What counts as "the same anomaly". A ticket-scoped kind budgets per ticket —
// two different tickets each walling once is ordinary campaign life, not a
// pattern — while a campaign-scoped kind budgets per campaign.
export const recoverKey = (a: Anomaly): string =>
  typeof a.ticketId === 'string' ? `${a.kind}:${a.ticketId}` : a.kind;

// Prior RESOLVED recoveries of the same key. Resolution is what makes a repeat
// damning: recover said it fixed the campaign definition and the same anomaly
// came back.
//
// Total, not consecutive. A kind that returns after an apparent success is the
// signal, whether or not something else went green in between.
export function priorRecoveries(key: string): string[] {
  return backlog().recoveries?.[key]?.summaries ?? [];
}

// The whole verdict in one read, because the question is never "what is the key"
// on its own — it is "may I spend a recover here, and if not, what do I attach to
// the park". Served as `loop recovery-budget` (mechanics.ts).
export type BudgetVerdict = {
  key: string;
  spent: number;
  budget: number;
  exhausted: boolean;
  // The prior fixes, verbatim. These are the evidence a park cites: "recover
  // believed it fixed this twice, here is what it said both times" is what makes
  // the handoff to the human actionable rather than just a stop.
  priorFixes: string[];
};

export function recoveryBudget(anomaly: Anomaly): BudgetVerdict {
  const key = recoverKey(anomaly);
  const priorFixes = priorRecoveries(key);
  return {
    key,
    spent: priorFixes.length,
    budget: RECOVER_BUDGET,
    exhausted: priorFixes.length >= RECOVER_BUDGET,
    priorFixes,
  };
}
