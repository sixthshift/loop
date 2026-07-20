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
export const MODELS = {
  worker: ['codex-gpt-5.6-terra', 'claude-opus'],   // every worker; tickets carry no model of their own
  judge: ['claude-opus', 'codex-gpt-5.6-sol'],
  gaming: ['claude-sonnet', 'codex-gpt-5.6-terra'],
  reintegrate: ['claude-opus', 'codex-gpt-5.6-sol'],
  reviewer: ['claude-opus', 'codex-gpt-5.6-sol'],
  critic: ['claude-sonnet', 'codex-gpt-5.6-terra'],
  triage: ['claude-opus', 'codex-gpt-5.6-sol'],
  resolver: ['claude-opus', 'codex-gpt-5.6-sol'],   // full-tool fixer: decides + RUNS to verify before proposing
  auditor: ['claude-opus', 'codex-gpt-5.6-sol'],    // independent read-only check that the fix didn't weaken meaning
  repair: ['codex-gpt-5.6-terra', 'claude-opus'],   // repair writes code — implementer, like worker
  seed: ['claude-opus', 'codex-gpt-5.6-sol'],
  decompose: ['claude-opus', 'codex-gpt-5.6-sol'],
  coverage: ['claude-opus', 'codex-gpt-5.6-terra'],
  harvest: ['claude-opus', 'codex-gpt-5.6-terra'],
} satisfies Record<string, string[]>;
