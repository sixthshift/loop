# loop

An autonomous build coordinator. Point it at a locked build spec; it decomposes
the spec into a ticket backlog, dispatches parallel coding agents in isolated git
worktrees, verifies every result with scripts, judges every diff with a
fresh-context adversarial reviewer, and repeats until the campaign gate is green.

The coordinator seat — the control flow — is deterministic TypeScript. Every
*judgment* is a fresh agent process: kickoff, decompose, ticket review, sweep,
recover, coverage, harvest. The coordinator never grades work it dispatched.

> **Status: pre-first-campaign.** The mechanical spine and the agent layer are
> unit- and smoke-tested (152 tests); a full spec-to-green run has not happened
> yet. Workers run with permissions bypassed — see [Known limits](#known-limits).

## Requirements

| | |
|---|---|
| `claude` and/or `codex` CLI | the agent engines, authenticated. Either alone works; both gives author≠judge engine independence |
| `git` | worktrees are the isolation primitive |
| A git repo to build in | the target project, not this one |

The binary is self-contained — no runtime to install. Bun is a *contributor*
requirement, not a user one.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/sixthshift/loop/main/install.sh | bash
```

Downloads the binary for your platform from the latest [release][releases],
verifies it against the published `sha256sums.txt`, and installs it to
`~/.local/bin/loop`. `LOOP_VERSION=v0.1.0` pins a version; `LOOP_BIN_DIR` changes
where it lands.

Prebuilt for macOS (arm64, x64) and Linux (x86_64, aarch64), glibc. Elsewhere —
Alpine/musl, Windows — build from source.

To upgrade later:

```sh
loop update
```

Checks the latest release, exits if you already have it, and otherwise replaces
the running binary in place — wherever you installed it, not just
`~/.local/bin`. Same checksum verification, and nothing touches the filesystem
until it passes.

<details>
<summary>From source</summary>

```sh
bun install
ln -s "$PWD/src/index.ts" ~/.local/bin/loop   # src/index.ts is already executable, shebang: bun
```

Deps resolve from the symlink's realpath, so the link works from any directory.
Needs [Bun](https://bun.sh) ≥ 1.3; the dashboard is Ink/JSX, transpiled natively,
no build step. `bun run build` produces the release binaries for all four
targets.

</details>

[releases]: https://github.com/sixthshift/loop/releases

## Usage

Run from the root of the project being built:

```sh
loop campaign <spec.md>   # start a campaign (or resume one, spec unchanged)
loop resume               # resume without re-supplying the spec path
loop status               # print the backlog tree and exit
loop update               # replace this binary with the latest release
```

`loop` is the family name — the loop-engineering toolkit; `campaign` is its first
verb, so future artifacts of the discipline get verbs rather than naming debates.

**Environment:** `AILOOP_WORKERS` sets the initial parallel-worker cap (default
3; adjustable live from the dashboard).

**Exit codes:**

| Code | Meaning | State |
|---|---|---|
| 0 | campaign complete | `.ailoop/campaign/` deleted, post-mortem written |
| 1 | coordinator crash that slipped every membrane | intact — `loop resume` |
| 2 | escalation, paused for a human decision, lock held, or spec-hash mismatch | intact — `loop resume` |
| 3 | kickoff refused (spec not buildable) | none written at all |

## The spec

Input is one markdown file whose "done" is machine-checkable. Kickoff reads it
once and **refuses to start** if it can't derive check commands, listing exactly
what's missing — that refusal is the only sanctioned human interruption in a
healthy run. If the spec has YAML frontmatter with a `status:` field, a completed
campaign flips it to `status: done`.

Specs are meant to be authored with the `aispec` skill, which drives a spec to a
locked state; `loop` drives a locked spec to green.

## How a campaign runs

**1 · Kickoff** (once, only when no campaign exists). One agent reads the spec
and *runs* candidate commands to confirm them, yielding the campaign config: the
fast checks (per-ticket tier), the campaign `gate` (the slow suite), and
out-of-scope boundaries, and an enumeration of the spec's normative clauses as
`requirements` — `R1`, `R2`, … Then decompose turns the spec into open tickets —
each with declared `modules`, `depends_on`, `resources`, prose context,
acceptance, its own `acceptanceChecks`, and the requirement ids it `satisfies`.
The spec's sha256 is journaled: a resume against an edited spec refuses rather
than drive an old contract to green.

The enumeration is what makes spec coverage *arithmetic* rather than a verdict
delivered at the end. The frontier joins tickets to requirement ids on every
pass, so "3 clauses nobody claimed" shows up in the pre-flight report and on the
dashboard's second progress bar — while the campaign can still act on it —
instead of surfacing at termination after the whole tree was built around the
absence. Two bars, because they answer different questions and can disagree: a
campaign can be 8/8 tickets closed with a clause no ticket ever claimed. The
sole writer refuses a ticket claiming an id that isn't enumerated; a claim
nothing can be joined to is worse than no claim, because it reads as coverage.

The list is made once, by one agent, before any code exists — so it is
load-bearing, and a clause missed there is invisible to every count downstream.
Two things hedge that: kickoff prints and journals the enumeration at the one
moment a human is present, and the terminal coverage pass still re-reads the
spec against the list and reports clauses missing from it as enumeration gaps.

**2 · Drive.** One event loop. Each pass reads the frontier — a pure function
over `backlog.json` — and walks a priority ladder: structural problems, merit
walls, completion, dispatch, stall. Tickets dispatch when their dependencies are
closed and their declared modules and resources are disjoint from everything in
flight, so parallel workers can't collide. A ticket declares the *directories*
it lives in, not a file list: a decomposer can predict "this ticket lives in
`src/auth/`" from the spec alone, but not the file the implementation turns out
to need — and a file list charges the ticket for that forecast error.

Each dispatched ticket gets a fresh git worktree and branch. When its worker
returns:

- **verify** (no model — exit codes and git) refuses a dirty tree, runs the fast
  checks plus the ticket's acceptance checks, and requires the committed diff to
  stay inside the ticket's declared modules. Writes an evidence log and a patch.
- **review** (fresh agent, cold read of the diff and the evidence) is the single
  adversarial gate. It rules `close`, `retry`, `gamed` (hardcoded outputs,
  weakened tests, special-cased inputs, scope creep — the cheated check gets
  sharpened before re-dispatch), `flake-probe` (re-run a command N times),
  `amend-typo`, or `escalate`.
- **close** merges to mainline. A merge conflict is an *infra* failure, not a
  merit one — the ticket rebuilds against the moved HEAD without burning its
  attempt budget. If mainline moved, the fast tier re-runs on the merged tree.

Every 5 closes, a **sweep** agent reads the *whole* journal and names the
cross-ticket pattern no per-ticket verdict can see — a systemic landmine, a
decomposition wrong at the seams, a check the campaign keeps re-sharpening. It
is the only arm not scoped to a single ticket, so it runs on the strong tier;
its output is still proposals the coordinator applies.

**3 · Campaign gate.** When all ticket work drains, the slow suite (e2e, anything
needing a live server) runs **once**, on the whole merged tree. Red is treated as
an escaped bug: recover either spawns a repair ticket, corrects a mis-scoped
gate, or parks it for the human.

Gate edits are classified before they apply (`gate.ts`). A new gate name only
adds coverage, so any arm may add one. Reusing a live name *replaces* the
command currently deciding correctness — and no comparison of two shell strings
can prove that's a tightening. So a replacement is accepted from exactly one
caller: a recover answering that gate's own red run, the only invocation that
holds the failure and can re-run the correction green. Sweep can't run anything
and every other recover never saw the gate, so for them a reused name is
refused. Either way it is journaled under its own kind, with the command it
displaced.

The **fast tier** is amendable too (`fastcheck.ts`), and on a different rule: not
authority-by-anomaly but measurement. A fastCheck must be green on the mainline as
it stands — kickoff refuses to start over a red baseline — so the coordinator runs
each proposed command at the repo root and admits only what exits 0, whichever
anomaly proposed it. That exists because a campaign-wide check which measures the
environment rather than the product reds *every* ticket identically, and without
this actuator no arm could reach it: the loop's only move was to page a human, per
ticket, forever. There is no removal — dropping baseline coverage is a human's
decision.

**4 · Retrospective.** A coverage agent grades the requirement-to-proof matrix —
the coordinator already counted which clauses are claimed and closed, so the
pass spends its read on whether each check observed the boundary its requirement
names, plus one re-read of the spec for clauses the enumeration missed. Anything
unproven becomes a new ticket and the drive resumes. Otherwise: harvest
distils the journal into reusable learnings, a self-contained HTML post-mortem is
written next to the spec, branches are reaped, and campaign state is deleted.

### The two gaps a script has to close

- **Unenumerated situations → `recover.ts`**, the universal `else`. Every
  unhandled frontier problem, refused mutation, merit wall, blocked worker, red
  gate, dirty mainline, or stall routes to a fresh full-tool agent — and so does
  every unenumerated *throw*: the drive loop sits inside a crash membrane that
  journals the error and hands it to recover instead of dying (the same error
  twice escalates — a repeated crash is a missing arm, not a flake). Recover
  reproduces the fault, fixes the campaign **definition** (gates, scope, ticket
  contracts, deps) through legal backlog mutations, fixes the **environment**
  directly (installs, stale ports, a wedged checkout), runs the check to prove
  its fix green, and self-audits — but it never touches **product code**: a
  genuine defect becomes a repair *ticket* that a worker builds and the review
  judges, so every change to the work stays verified. When it can't fix within
  jurisdiction it parks. It never hard-stops. Every invocation is journaled: the
  recover log is the coordinator's own escaped-bug record, and a recurring kind
  should be promoted to a real arm in `drive.ts`.

  Two things contain the most privileged actor in the loop. **The product-code
  boundary is enforced, not trusted** (`jurisdiction.ts`): recover holds the
  mainline lock for its whole run, so the checkout before and after is
  attributable to it alone. Any tracked, non-manifest file it changed —
  committed or not — is reverted, and the reverted diff becomes a repair ticket
  a worker builds and the review judges. Untracked scratch files, manifests
  (an install *is* a manifest edit) and cleaning away pre-existing dirt all stay
  in bounds. **And a recurring anomaly stops being recoverable**: the
  coordinator counts recover's *resolutions* per anomaly — per ticket for
  ticket-scoped kinds, per campaign for the rest — and past two it parks with
  the prior fixes attached instead of calling a fresh agent that will write a
  third confident success note. The count comes off the journal, so it survives a
  resume; that is also what bounds the gate-red → repair → gate-red loop, since
  every round of it resolves.
- **Opportunistic noticing → the sweep**, above. A scheduled substitute for
  ambient attention.

### Failure is a taxonomy

Nothing hard-stops that a human could resolve later. Merit failures (verify red,
gaming, judge-rejected) count toward a ticket's attempt cap and climb the worker
model ladder; infra failures (dead session, operator kill, moved mainline) don't.
A ticket that walls gets recover's diagnosis twice, then parks. When nothing
autonomous remains, the campaign **pauses** with a report of every deferred
decision and its recorded reason — state intact, `loop resume` continues.

## Dashboard

On a TTY, `loop campaign` runs an interactive dashboard for the life of the run.
The main screen is the active work: campaign progress with gate state, the spend
tally, and every process running right now — agents (`⚙`) and scripts (`$`, e.g.
`verify:T007`, `gate:e2e`) — each with a one-line tail. While a process is
mid-output its row shows the newest text instead of a stale event, and each row
carries a measured liveness cell (`liveness.ts` samples process-subtree CPU;
output silence is a false hang signal — a long e2e run is silent by design).

Reading is free-roam: `tab` to the filterable journal, `t` for tickets, `g` for
the dependency DAG as a rail graph, `enter` on any process to tail its live
output — an agent's transcript with its raw token stream, or a script's
stdout/stderr as it runs. Per-process rings are windows; the journal is the
record.

Acting is deliberately narrow — `p` pause dispatch, `+`/`-` worker cap, `r` queue
a sweep, `x` kill a worker, `q` quit with state intact, `?` keys. Every mutation
is a flag the drive loop honors at its next decision point, or a process kill
that settles through the ordinary failed-attempt path. **The dashboard never
writes campaign state**: kill it, `loop resume`, and the picture rebuilds from
the journal.

Off a TTY (piped, CI, container logs) the same events fall back to plain
timestamped lines and Ink is never loaded.

## Agents, engines, models

A model name carries its engine as a prefix — `claude-opus`,
`codex-gpt-5.6-terra`; a bare name means claude. Each role in
[`src/campaign/models.ts`](src/campaign/models.ts) has a preference chain: unavailable
engines are skipped, transient failures fall through to the next candidate, and
every chain carries the other family as a fallback so a provider outage degrades
instead of stalling.

Two axes set each chain — difficulty picks the tier, and independence picks the
order, because a diff's author and its judge should be different engines. So
workers lead the light Codex (writing code is its home turf), decompose leads
Codex (it authors the acceptance checks), and review leads `claude-opus` and
degrades *within* Claude first, so a Claude outage never collapses the gate onto
the worker's own family.

The worker chain doubles as an escalation ladder: a ticket's Nth merit failure
starts at the Nth rung, so a proven-hard ticket climbs terra → sol → opus. A
nested entry is a *consensus group* — its members draft in parallel and one
reconciles the anonymized drafts into a single output (used where the schema
output *is* the artifact, e.g. decompose; never for workers). Verification costs
no model at all.

## State on disk

In the target repo, gitignored automatically at kickoff:

```
.ailoop/campaign/          deleted on successful completion
  backlog.json             the ticket ledger — one writer, validated transitions
  journal.jsonl            append-only record; every resume rebuilds from it
  evidence/                per-ticket check logs and diff patches
  coordinator.pid          single-coordinator lock
.ailoop/learnings/         SURVIVES the campaign — priors for the next one
<spec>.postmortem.html     self-contained archive of the journal
```

Worker worktrees live **outside** the repository — `../.loop-worktrees/<repo>/<ticket>`,
or `$XDG_STATE_HOME/loop/worktrees/` when the repo's parent isn't writable. Inside
the repo, a worktree is swept up by every root-anchored test collector, and a
runtime resolving dependencies from it silently walks up into the primary
checkout's installed tree — so a missing dependency looks like a broken test
rather than an unprovisioned worktree. Each worktree is provisioned at dispatch
by copying the primary checkout's ignored dependency trees (`node_modules` and
friends, workspace-nested ones included) with copy-on-write clone → hardlink →
byte copy, whichever the filesystem allows. Nothing is installed: no network, no
build hooks. On a filesystem without clone or hardlink support that is real disk
per in-flight ticket, and the dispatch note records which rung ran.

Every `backlog.json` mutation goes through one writer that validates status
transitions and journals as it writes — so the journal explains every state
change, and resume never guesses.

## Development

```sh
bun test src        # 152 tests
bun run typecheck   # tsc --noEmit, strict
```

| Path | |
|---|---|
| `src/index.ts` | CLI shell — verb wiring only |
| `src/campaign/` | the deterministic seat: `drive`, `frontier`, `backlog`, `verify`, `recover`, `jurisdiction` (recover's enforced boundary), `gate` + `fastcheck` (check-amendment authority), `kickoff`, `retrospective`, `worktree` + `provision`, `journal`, `models` |
| `src/agent/` | spawning agents: `agent` (spawn, timeout, fallback, consensus), `engine` + `engines/`, `schemas`, `fleet` |
| `src/agent/prompts/` | one markdown prompt per role — the judgment layer, editable without touching control flow |
| `src/tui/` | dashboard (Ink), rail graph, control flags, liveness |
| `src/update.ts` | `loop update` — verified self-replacement |
| `build.ts` | the release build: four cross-compiled binaries + `sha256sums.txt` |
| `next-version.ts` | the version a push earns, read off its commits |

Prompts are embedded as text imports rather than read at runtime, because a
compiled binary has no `src/agent/prompts/` to read from. Adding a prompt is
therefore a new import line in `agent.ts`, not just a file dropped in the
directory.

### Releasing

There is no release ritual: **a push to `main` releases itself.** The workflow
reads the commits since the last tag and derives the version from them —
`feat:` a minor bump, `fix:`/`refactor:`/`perf:` a patch, `!` or
`BREAKING CHANGE:` a major (which, below 1.0, is still a minor — `0.x` advertises
an unsettled shape and spending `1.0.0` on the first renamed verb would claim a
stability the tool hasn't earned). A push carrying only `docs:`/`test:`/`chore:`
commits releases nothing and rides along with the next real change.

The version lives in exactly one place, `package.json`; the workflow stamps it,
commits it as `chore(release):`, tags it, and publishes. So `loop --version`, the
git tag, and the release name cannot disagree.

```sh
bun run build          # the four release binaries + sha256sums.txt, into dist/
bun run next-version.ts   # what the next push would release (empty = nothing)
```

## Design notes

### Why the coordinator is code

This began as `ailoop`, a Claude Code skill — a model in the coordinator seat
reading prose. That skill's own design rule was *"judgment lives with you;
everything with one right answer lives in a script,"* and every revision moved
more of the coordinator into scripts: backlog writes, frontier arithmetic,
verification, and finally the cheat check — forcibly outsourced, because a
coordinator that dispatched a ticket is the builder's advocate, not its auditor.

That argument generalizes: a long-lived coordinator is context-poisoned for
*every* verdict. This program is the fixed point of that trajectory — control
flow is code, every judgment is a fresh context. What that buys: no compaction
risk, no idle coordinator tokens while workers run, deterministic resume, and
campaigns that outlive a session.

The skill remains the better vehicle while the process itself is still being
redesigned — editing prose is cheaper than editing code.

### Deliberate divergence from the skill

This coordinator has no *phase* concept. Dependencies sequence the backlog, and
the slow suite is one campaign-level gate that runs once on the merged tree when
every ticket has drained; the skill keeps per-phase gating. The `backlog.json`
shapes have diverged, so **a campaign in flight belongs to the coordinator that
started it** — the two cannot resume each other. `.ailoop/learnings/` is still
shared verbatim: schema-free prose and keyed facets cross freely, so a campaign
feeds its priors to whichever coordinator runs next.

The pre-dispatch ticket check and the separate gaming pre-screen were both
removed. Open tickets dispatch straight to a worker, and the post-build review
carries the whole adversarial load.

## Known limits

- **Workers run `--dangerously-skip-permissions`** (as does the kickoff agent, so
  it can probe toolchain commands). This is built for a devcontainer workflow;
  running it on a host shell hands headless agents unrestricted tool access.
- **Not yet exercised on a real campaign.** The mechanical spine (init → seed →
  add → frontier → dispatch → verify → scope-fail → merge → resume) and the agent
  layer (prompt → CLI → schema → verdict) are tested; a full spec-to-green run is
  not. First campaign should be a small spec, watched.
- **Gate bisection is delegated, not scripted.** On a red campaign gate, recover
  gets the evidence and every branch (all kept until the gate is green) and
  decides. A scripted bisect arm is the obvious first promotion out of the
  recover log. The bisection surface is the whole campaign, not a phase — that's
  the cost of running e2e once instead of per phase.
- **The liveness cell is Linux-only.** It reads process-subtree CPU from `/proc`;
  elsewhere the cell stays blank rather than guess.
