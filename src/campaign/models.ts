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
// So the roles that write code (worker, repair) lead with Codex terra; the roles
// that grade, critique, or plan that work lead with Claude and fall back to the
// strong Codex (sol). The cheap, frequent roles (gaming, critic) and the
// once-per-campaign retrospective roles (coverage, harvest) stay on the light
// tier both ways. Every chain carries the other engine as fallback, so a role
// still runs when its preferred engine is down or absent.
//
// The roles:
//   worker      — builds one ticket: writes the code and its tests, runs the
//                 checks, commits on its branch. Every worker uses this chain;
//                 tickets carry no model of their own.
//   judge       — rules on a returned ticket from the verify + gaming evidence:
//                 close / retry / gamed / flake-probe / amend / park.
//   gaming      — reads the diff for cheats: hardcoded outputs, weakened or
//                 deleted tests, special-cased inputs, out-of-scope features.
//   reintegrate — at phase close, judges whether the phase's tickets actually
//                 compose into what the phase promised (green parts ≠ whole).
//   reviewer    — periodic pass over the journal for the cross-ticket patterns
//                 no single per-ticket verdict can see.
//   critic      — vets a draft ticket before dispatch across five questions:
//                 gaming, blindness, coverage, dependency, scope.
//   triage      — the universal else: read-only, proposes lawful backlog
//                 mutations for anomalies the deterministic spine didn't enumerate.
//   resolver    — full-tool fixer: reproduces a fault, fixes the campaign
//                 definition (gates/scope/tickets, never product code), and RUNS
//                 the check to verify before proposing — the coordinator applies
//                 only what the auditor clears.
//   auditor     — independent, read-only check that a resolver's proposed fix
//                 didn't weaken an invariant or widen scope (advocate ≠ auditor).
//   repair      — environment / machine-fault fixer (installs, stale ports,
//                 wedged git): full tools, the box only, never the work.
//   seed        — reads the locked spec once at intake into the campaign config:
//                 phases, gates, fast-checks, out-of-scope, blockers.
//   decompose   — turns the spec (or a too-big ticket) into the draft ticket
//                 backlog.
//   coverage    — final pass at termination: which spec requirements map to no
//                 closed ticket (unmapped = not done).
//   harvest     — retrospective: distils the campaign journal into reusable
//                 learnings (landmines, observed cheat shapes).
export const MODELS = {
  worker: ['codex-gpt-5.6-terra', 'claude-opus'],
  judge: ['claude-opus', 'codex-gpt-5.6-sol'],
  gaming: ['claude-sonnet', 'codex-gpt-5.6-terra'],
  reintegrate: ['claude-opus', 'codex-gpt-5.6-sol'],
  reviewer: ['claude-opus', 'codex-gpt-5.6-sol'],
  critic: ['claude-sonnet', 'codex-gpt-5.6-terra'],
  triage: ['claude-opus', 'codex-gpt-5.6-sol'],
  resolver: ['claude-opus', 'codex-gpt-5.6-sol'],
  auditor: ['claude-opus', 'codex-gpt-5.6-sol'],
  repair: ['codex-gpt-5.6-terra', 'claude-opus'],
  seed: ['claude-opus', 'codex-gpt-5.6-sol'],
  decompose: ['claude-opus', 'codex-gpt-5.6-sol'],
  coverage: ['claude-opus', 'codex-gpt-5.6-terra'],
  harvest: ['claude-opus', 'codex-gpt-5.6-terra'],
} satisfies Record<string, string[]>;
