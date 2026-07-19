# loop campaign — the script coordinator

The build-loop coordinator as a Node program. Same campaign in spirit and in
state as the `claude/skills/ailoop` skill — decompose a locked spec into a
ticket backlog, dispatch parallel workers in git worktrees, independently
verify every result, judge, repeat until every phase gate is green — but the
coordinator seat is deterministic code instead of a model reading prose.

## Why this exists (the rejected alternative)

The skill's own design rule is "judgment lives with you; everything with one
right answer lives in a script," and every revision moved more of the
coordinator into scripts — backlog writes, frontier arithmetic, verification,
and finally the gaming check, forcibly outsourced because a coordinator that
dispatched a ticket is the builder's advocate, not its auditor. That argument
generalizes: the long-lived coordinator is context-poisoned for *every*
verdict. This program is the fixed point of that trajectory — the control
flow is code, and **every judgment is a fresh-context agent**: seed, decompose,
critic, gaming, judge, reintegrate, coverage, harvest.

The skill remains the better vehicle while the loop's process is still being
redesigned (editing prose is cheaper than editing code). This coordinator is
the end state: no compaction risk, no idle coordinator tokens while workers
run, deterministic resume, campaigns that outlive a session.

## The two gaps a script must close, and how

- **Unenumerated situations** → `triage.mjs`, the universal `else`. Every
  unhandled frontier problem, refused mutation, blocked worker, or stall
  routes to a fresh agent whose only actuators are legal `backlog-write.mjs`
  commands — it can propose any lawful mutation but cannot corrupt state —
  and whose exit is escalation. Every invocation is journaled: the triage log
  is the coordinator's own escaped-bug record. A recurring triage kind should
  be promoted to a real arm in `drive.mjs`.
- **Opportunistic noticing** → the reviewer (`prompts/reviewer.md`), run
  every 5 closes and at every phase close: one agent over the journal since
  the last review, asking what no individual verdict sees.

## Shared state protocol

`.ailoop/run/` and the six mechanical scripts are copied from the **skill's**
`templates/` at intake — one source of truth, two drivers. Either coordinator
can resume the other's campaign; `.ailoop/learnings/` is shared verbatim.

## Usage

```
loop campaign <spec.md>   start a campaign (refuses if "done" isn't machine-checkable)
loop resume               resume after an escalation or a dead session
loop status               render the live backlog tree (progress.mjs)
```

`loop` is the family name — the loop-engineering toolkit; `campaign` is its
first verb, and future artifacts of the discipline get their own verbs
rather than their own naming debates. `install.sh` links `bin/loop.mjs` to
`~/.local/bin/loop`. Env: `AILOOP_WORKERS` (parallel workers, default 3).

Escalations exit 2 with the reason and leave `.ailoop/run/` intact; resolve
and `loop resume`. A refused intake (exit 3) leaves no state at all.

## Display

On a TTY, `loop campaign` runs a live dashboard for the life of the run
(`tui.mjs`): per-phase progress bars with gate state, the live agent pane
with per-agent elapsed time, a spend tally (cost / tokens / agent calls),
and the journal as the scrolling event feed — the files are the loop's
memory, so the renderer mostly just polls them. When stdout isn't a TTY
(piped, CI, devcontainer logs) the same events fall back to plain
timestamped lines. The dashboard never owns state: kill it, `loop resume`,
and the picture rebuilds from the journal.

## Model tiering

Workers take the ticket's `model` tag (opus default). Critic and gaming run
sonnet — narrow questions, explicit rubrics. Judge, triage, reviewer,
reintegration, coverage, and harvest run opus. `verify.mjs` costs no model.

## Known limits

- **Workers run `--dangerously-skip-permissions`** (and the intake gate agent
  does too, to probe toolchain commands). This coordinator is built for the
  devcontainer workflow; running it on a host shell hands headless agents
  unrestricted tool access.
- **Not yet exercised on a real campaign.** The mechanical spine
  (init → seed → add → vet → frontier → dispatch → verify → scope-fail →
  merge → resume-journal) and the live agent layer (prompt → `claude -p`
  → schema → verdict) are smoke-tested; a full spec-to-green run is not.
  First campaign should be a small spec, watched.
- **Phase-gate bisection is delegated, not scripted.** On a red gate the
  skill prescribes per-branch bisection; here triage gets the evidence and
  the branches (kept until phase close) and decides — a scripted bisect arm
  is the obvious first promotion out of the triage log.
