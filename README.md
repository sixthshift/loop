# loop campaign — the script coordinator

The build-loop coordinator as a Node program. Same campaign in spirit as the
`claude/skills/ailoop` skill — decompose a locked spec into a ticket backlog,
dispatch parallel workers in git worktrees, independently verify every result,
review, repeat until the campaign gate is green — but the coordinator seat is
deterministic code instead of a model reading prose.

**Divergence from the skill (deliberate):** this coordinator has no *phase*
concept. Dependencies sequence the backlog; the slow suite (e2e) is a single
campaign-level `gate` that runs once, on the whole merged tree, when every
ticket has drained — not per phase. The skill keeps per-phase gating. The two
no longer share `backlog.json` shape, so a campaign is bound to the coordinator
that started it — they cannot resume each other.

## Why this exists (the rejected alternative)

The skill's own design rule is "judgment lives with you; everything with one
right answer lives in a script," and every revision moved more of the
coordinator into scripts — backlog writes, frontier arithmetic, verification,
and finally the cheat check, forcibly outsourced because a coordinator that
dispatched a ticket is the builder's advocate, not its auditor. That argument
generalizes: the long-lived coordinator is context-poisoned for *every*
verdict. This program is the fixed point of that trajectory — the control
flow is code, and **every judgment is a fresh-context agent**: kickoff, decompose,
the ticket review, sweep, coverage, harvest. There is one adversarial gate — the
ticket review, after build — which reads the diff cold for cheats and blind
spots. The earlier pre-dispatch gate (ticket preflight check) and the separate
gaming pre-screen were both removed; open tickets now dispatch straight to a
worker and the ticket review carries the whole adversarial load.

The skill remains the better vehicle while the loop's process is still being
redesigned (editing prose is cheaper than editing code). This coordinator is
the end state: no compaction risk, no idle coordinator tokens while workers
run, deterministic resume, campaigns that outlive a session.

## The two gaps a script must close, and how

- **Unenumerated situations** → `recover.ts`, the universal `else` and
  full-tool fixer. Every unhandled frontier problem, refused mutation, merit
  wall, blocked worker, red gate, dirty mainline, or stall routes to a fresh
  agent — and so does every unenumerated *throw*: the drive loop is wrapped in
  a crash membrane that journals the error and hands it to recover rather than
  dying (the same error twice escalates — a repeated crash is a missing arm,
  not a flake). Recover has full tools: it reproduces the fault, fixes the
  campaign **definition** (gates, scope, ticket contracts, deps) via legal
  `backlog-write` mutations, fixes the **environment** directly (installs,
  stale ports, a wedged git checkout), RUNS the check to prove its fix green,
  and self-audits — but it never touches **product code**: a genuine code
  defect becomes a repair *ticket* that a worker builds and the ticket review
  checks, so every change to the work stays verified and reviewed. If it can't
  fix within jurisdiction it parks (defers to the human); it never hard-stops.
  Every invocation is journaled: the recover log is the coordinator's own
  escaped-bug record, and a recurring kind should be promoted to a real arm in
  `drive.ts`. (Recover is the merge of what were three agents — triage, the
  resolver, and repair.)
- **Opportunistic noticing** → the sweep (`prompts/sweep.md`), run
  every 5 closes: one agent over the journal since the last sweep, asking
  what no individual verdict sees.

## Shared state protocol

`.ailoop/campaign/` is scaffolded at kickoff and `.ailoop/learnings/` is shared
with the skill verbatim — a campaign feeds its harvested learnings back to
whichever coordinator runs next. The `backlog.json` shape has diverged (no
phases here), so a *campaign in flight* belongs to the coordinator that started
it; cross-coordinator resume is no longer supported. Learnings, which are
schema-free prose and keyed facets, still cross freely.

## Usage

```
loop campaign <spec.md>   start a campaign (refuses if "done" isn't machine-checkable)
loop resume               resume after an escalation or a dead session
loop status               render the live backlog tree (progress.mjs)
```

`loop` is the family name — the loop-engineering toolkit; `campaign` is its
first verb, and future artifacts of the discipline get their own verbs
rather than their own naming debates. `install.sh` links `src/index.ts` to
`~/.local/bin/loop` and runs `bun install` in `loop/` (the dashboard is
Ink/JSX, so the runtime is bun — it transpiles `.tsx` natively, no build
step; deps resolve from the symlink's realpath). Env: `AILOOP_WORKERS`
(initial worker cap, default 3 — adjustable live from the dashboard).

Escalations exit 2 with the reason and leave `.ailoop/campaign/` intact; resolve
and `loop resume`. A refused kickoff (exit 3) leaves no state at all.

## Dashboard

On a TTY, `loop campaign` runs an interactive dashboard for the life of the
run (`dashboard.tsx`, mounted by the `tui.ts` bridge). The main screen is the
**active work**: the campaign progress bar with gate state, the spend tally, and
a live list of every process running right now — both agents (`⚙`) and scripts
(`$`, e.g. `verify:T007`, `gate:e2e`), each with a one-line tail of what
it's doing. The **journal** lives one `tab` away as a scrollable, filterable
feed. Reading is free-roam: `t` browses tickets (enter: acceptance, checks,
attempt history), and enter on any process in the active list tails its live
output — an agent's transcript (workers stream over `--output-format
stream-json --include-partial-messages`) or a script's stdout/stderr as it
runs. Both per-process rings are windows, not records — the journal stays the
record. An agent tail's bottom region is the model's raw token stream —
thinking and text as they generate, cleared when the finished message lands as
a transcript line; a script tail's bottom region is the current unterminated
line (a progress bar, a prompt). While a process is mid-output its main-screen
row shows the newest text (`✍ …` / the live line) instead of a stale event.
Delta re-renders are throttled to ~7fps and the journal parse is mtime-cached,
so the firehose stays cheap. Each row carries its last event's age plus a
measured liveness cell (`liveness.ts` samples the process-subtree CPU from
/proc): output silence is a false hang signal — a long e2e run is silent by
design — so ▶ means the subtree burned CPU in the last 30s, and "no cpu" ages
toward red. Linux/devcontainer only; elsewhere the cell stays blank rather
than guess. Acting is deliberately narrow: `p` pauses dispatch, `+`/`-` moves
the worker cap, `r` queues a sweep pass, `x` kills a worker (journaled as a
failed attempt; the ticket redispatches fresh — scripts and verdict agents
settle on their own), `q` quits with state intact. Every mutation is a
`control.ts` flag the drive loop honors at its next decision point, or a
child-process kill that settles through the ordinary failed-attempt path —
the dashboard never writes campaign state: kill it, `loop resume`, and the
picture rebuilds from the journal. `?` lists the keys.

When stdout isn't a TTY (piped, CI, devcontainer logs) the same events fall
back to plain timestamped lines and ink is never loaded.

## Model tiering

The ticket review, recover, sweep, kickoff, decompose, coverage, and harvest
lead with opus. Workers climb a ladder (terra → sol → opus) as a ticket keeps
failing. `verify.mjs` costs no model. See `campaign/models.ts` for the full
per-role chains.

## Known limits

- **Workers run `--dangerously-skip-permissions`** (and the kickoff gate agent
  does too, to probe toolchain commands). This coordinator is built for the
  devcontainer workflow; running it on a host shell hands headless agents
  unrestricted tool access.
- **Not yet exercised on a real campaign.** The mechanical spine
  (init → seed → add → frontier → dispatch → verify → scope-fail →
  merge → resume-journal) and the live agent layer (prompt → `claude -p`
  → schema → verdict) are smoke-tested; a full spec-to-green run is not.
  First campaign should be a small spec, watched.
- **Gate bisection is delegated, not scripted.** On a red campaign gate the
  recover agent gets the evidence and the branches (all kept until the gate is
  green) and decides — a scripted bisect arm is the obvious first promotion
  out of the recover log. The bisection surface is the whole campaign, not a
  phase: the cost of running e2e once instead of per phase.
