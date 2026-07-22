// Which model each agent role prefers. Each list is a preference chain: agent()
// skips engines that aren't installed and falls back on transient failure, so
// ordering is "try this, then that". Names are engine-prefixed —
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
//   • review leads claude-opus and must: it is the sole adversarial gate judging
//     a Codex worker's diff, so it stays Claude for independence. It degrades
//     within Claude (opus → sonnet) before dropping to Codex sol, so a Claude
//     outage doesn't collapse the gate onto the worker's own family.
//   • recover and coverage lead claude-opus — judgment-heavy (recover self-audits
//     definition-of-done; coverage rules done-ness).
//   • sweep and harvest lead claude-sonnet — advisory / no-correctness-impact,
//     economized to the light tier.
// Every chain carries the other family as a fallback, so a provider outage
// degrades gracefully instead of stalling.
//
// The roles:
//   worker      — builds one ticket: writes the code and its tests, runs the
//                 checks, commits on its branch. Every worker uses this chain;
//                 tickets carry no model of their own.
//   review      — ticket review: rules on a returned ticket from the verify
//                 evidence AND its own cold read of the diff for cheats (hardcoded
//                 outputs, weakened/deleted tests, special-cased inputs,
//                 out-of-scope features): close / retry / gamed / flake-probe /
//                 amend / escalate. The sole post-work authority.
//   sweep       — periodic pass over the journal for the cross-ticket patterns
//                 no single per-ticket verdict can see.
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
// The worker chain is special: it doubles as an escalation ladder. dispatch
// starts the Nth (merit) attempt at the Nth rung, so a ticket that keeps
// failing on its own terms climbs terra → sol → opus — light coding model, then
// heavy codex (sol ≈ opus), then claude. Within one attempt agent() still walks
// the remaining rungs on an engine failure, so a fallback is just taking the
// next rung early. Infra deaths don't advance the ladder (see drive.workerChain).
export const MODELS = {
  worker: ['codex-gpt-5.6-terra', 'codex-gpt-5.6-sol', 'claude-opus'],
  kickoff: ['codex-gpt-5.6-sol', 'claude-opus'],
  decompose: ['codex-gpt-5.6-sol', 'claude-opus'],
  review: ['claude-opus', 'claude-sonnet', 'codex-gpt-5.6-sol'],
  recover: ['claude-opus', 'codex-gpt-5.6-sol'],
  coverage: ['claude-opus', 'codex-gpt-5.6-sol'],
  sweep: ['claude-sonnet', 'codex-gpt-5.6-sol'],
  harvest: ['claude-sonnet', 'codex-gpt-5.6-terra'],
} satisfies Record<string, string[]>;
