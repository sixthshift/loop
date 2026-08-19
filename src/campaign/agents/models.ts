// Which campaign role prefers each model. Each list is a preference chain: the
// coordinator takes the first rung whose engine is installed and falls to the
// next on a transient failure, so ordering is "try this, then that". Names are
// engine-prefixed —
// `codex-gpt-5.6-sol`, `claude-opus`; a bare name means claude.
//
// Two axes decide each chain:
//   • difficulty picks the tier — heavy = claude-opus / codex-sol (sol ≈ opus),
//     light = claude-sonnet / codex-terra (terra is the lighter, coding-leaning
//     Codex).
//   • independence picks the order — the diff's author and its judge should be
//     different engines, so no model marks its own homework.
//
// The allocation follows fit, not an even split:
//   • worker leads Codex terra — writing code is its home turf; the chain also
//     doubles as an escalation ladder (see below).
//   • kickoff and decompose lead the strong Codex (sol): kickoff probes the
//     toolchain (tool work), and decompose AUTHORS the acceptance checks — so
//     leading it with Codex keeps the check-author a different engine from the
//     Claude review that judges against them (author ≠ judge, a second time).
//   • critic leads claude-opus for the same reason review does, and it is the
//     same independence fact one stage earlier: decompose AUTHORS the acceptance
//     checks on Codex, and critic's only question is whether those checks can
//     observe their clause. Running it on the authoring family would be the
//     check-author grading its own blind spots — exactly what author ≠ judge
//     exists to prevent. It degrades within Claude before dropping to Codex.
//   • review leads claude-opus and must: it is the sole adversarial gate judging
//     a Codex worker's diff, so it stays Claude for independence. It degrades
//     within Claude (opus → sonnet) before dropping to Codex sol, so a Claude
//     outage doesn't collapse the gate onto the worker's own family.
//   • recover and coverage lead claude-opus — judgment-heavy (recover self-audits
//     definition-of-done; coverage rules done-ness).
//   • sweep leads claude-opus — it is the campaign's only reflective arm, the
//     one pass whose input is campaign-wide (the journal since the last sweep
//     plus every prior sweep's summary) rather than one ticket. The
//     cross-ticket pattern (a systemic fixture problem, a bad decomposition,
//     checks that keep needing the same sharpening) exists in the campaign only
//     if sweep names it, and no per-ticket arm can: review sees one diff,
//     recover sees one anomaly. Its output is still proposals the coordinator
//     applies, so the tier buys judgment, not authority.
//   • harvest leads claude-sonnet — retrospective, post-gate, no correctness
//     impact, economized to the light tier.
// Every chain carries the other family as a fallback, so a provider outage
// degrades gracefully instead of stalling.
//
// The roles:
//   worker      — builds one ticket: writes the code and its tests, runs the
//                 checks, commits on its branch. Every worker uses this chain;
//                 tickets carry no model of their own.
//   critic      — the one read of a ticket's acceptance checks BEFORE a worker
//                 builds against them, asking review's own question: what
//                 contract-violating implementation would these exact checks
//                 accept? Returns a sharpened check array or an accepted risk
//                 carried to the judge. It exists because the answer is usually
//                 derivable from the check text alone, and discovering it after
//                 a build costs a verify, a review, a merit attempt and a
//                 rebuild instead of one read.
//   review      — ticket review: rules on a returned ticket from the verify
//                 evidence AND its own cold read of the diff for cheats (hardcoded
//                 outputs, weakened/deleted tests, special-cased inputs,
//                 out-of-scope features): close / retry / gamed / sharpen /
//                 flake-probe / amend / escalate. The sole post-work authority.
//   sweep       — campaign-level reflection at each milestone: reads the whole
//                 journal and names the pattern no per-ticket verdict can see
//                 — a systemic landmine, a mis-decomposition, a check the
//                 campaign keeps re-sharpening. Proposes; never applies.
//   recover     — the universal else + full-tool fixer: every anomaly the
//                 deterministic spine can't handle (stall, refusal, merit wall,
//                 blocked worker, red gate, dirty mainline, coordinator crash).
//                 Fixes the campaign definition (gates/scope/tickets) and the
//                 environment (installs/ports/git) — never product code, which
//                 becomes a repair ticket. RUNS the check to verify, self-audits;
//                 the coordinator applies its actions, or it parks for the human.
//   kickoff     — reads the locked spec once into the campaign config: the gate,
//                 fast-checks, out-of-scope, blockers. The refuse-to-start gate.
//   decompose   — turns the spec (or a too-big ticket) into the open ticket
//                 backlog.
//   coverage    — final pass at termination: which spec requirements map to no
//                 closed ticket (unmapped = not done).
//   harvest     — retrospective: distils the campaign journal into reusable
//                 learnings (landmines, observed cheat shapes).
// The worker chain is special: it doubles as an escalation ladder. The Nth
// (merit) attempt starts at the Nth rung, so a ticket that keeps failing on its
// own terms climbs terra → sol → opus — light coding model, then heavy codex
// (sol ≈ opus), then claude. A rung whose engine is unavailable or which fails
// on the channel rather than the task is skipped, so a fallback is just taking
// the next rung early. Infra deaths don't advance the ladder.
// Consensus groups: a nested entry (a list inside the list) is not a fallback
// step but a group that DRAFTS in parallel, then has one member reconcile the
// drafts into a single output — diversity without a vote, keeping the best of
// each. `decompose: [['codex-gpt-5.6-sol', 'claude-opus']]` runs both, then
// codex-sol (the first survivor) merges. One reconcile pass, drafts anonymized
// so the reconciler can't favor its own. Worth it only where the schema output
// IS the artifact and the campaign has a later coverage backstop — decompose,
// coverage, harvest, sweep. NEVER worker: its product is a diff on a branch,
// unmergeable from JSON, and it runs per-ticket so the N+1× cost bites hardest.
import { engineFor, available } from './engines.ts';

// A chain with every rung resolved: which CLI runs it, the model name that CLI
// wants (engine prefix stripped), and whether that binary is on the box. The
// coordinator reads this through `loop models` — prefix parsing and the
// availability probe are mechanics, and a coordinator re-deriving them by hand
// picks the wrong rung and then attributes a missing binary to the agent.
export function resolvedChain(role: string): unknown[] {
  const chain = (MODELS as Record<string, (string | string[])[]>)[role];
  if (!chain) throw new Error(`unknown role: ${role} — roles: ${Object.keys(MODELS).sort().join(', ')}`);
  const resolve = (model: string) => {
    const { name, cliModel } = engineFor(model);
    return { model, engine: name, cliModel, available: available(model) };
  };
  // A nested rung is a consensus group: its members draft in parallel and one
  // reconciles. Preserved as a group so a reader can't mistake it for a fallback.
  return chain.map(rung => Array.isArray(rung)
    ? { consensusGroup: rung.map(resolve) }
    : resolve(rung));
}

export const MODELS = {
  worker: ['codex-gpt-5.6-terra', 'codex-gpt-5.6-sol', 'claude-opus'],
  kickoff: ['codex-gpt-5.6-sol', 'claude-opus'],
  decompose: [['codex-gpt-5.6-sol', 'claude-opus']],
  critic: ['claude-opus', 'claude-sonnet', 'codex-gpt-5.6-sol'],
  review: ['claude-opus', 'claude-sonnet', 'codex-gpt-5.6-sol'],
  recover: ['claude-opus', 'codex-gpt-5.6-sol'],
  coverage: ['claude-opus', 'codex-gpt-5.6-sol'],
  sweep: ['claude-opus', 'codex-gpt-5.6-sol'],
  harvest: ['claude-sonnet', 'codex-gpt-5.6-terra'],
} satisfies Record<string, (string | string[])[]>;
