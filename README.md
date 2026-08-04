# loop

The substrate an autonomous build coordinator stands on.

The coordinator is a **model** — the [`ailoop`](skills/ailoop) skill. Point it at a
locked build spec and it decomposes the spec into a ticket backlog, dispatches
parallel coding agents in isolated git worktrees, verifies every result with
scripts, judges every diff with a fresh-context adversarial reviewer, and repeats
until the campaign gate is green.

This binary is everything underneath that seat, as verbs: the sole backlog writer,
the frontier arithmetic, verification and its scope check, worktree provisioning,
id allocation, the check-amendment rules, recover's jurisdiction boundary and its
budget, the role prompts and their schemas. Plus `loop watch`, a read-only window
onto a campaign it is not driving.

The organizing rule is one sentence: **nothing here asks the coordinator to
remember, count, or measure.** A model in the seat can improvise a fault nobody
enumerated, which is exactly what makes it a bad place to keep a budget, a ticket
count, or a gate's freshness.

> **Status: pre-first-campaign.** The mechanics are unit- and smoke-tested; a full
> spec-to-green run has not happened yet. Workers run with permissions bypassed —
> see [Known limits](#known-limits).

## Requirements

| | |
|---|---|
| Claude Code | the coordinator seat: `loop skills install`, then `/ailoop <spec>` |
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

From the root of the project being built, once:

```sh
loop skills install       # install the aispec / ailoop skills where Claude Code looks
```

Then the campaign runs from inside Claude Code, and the human watches from a
second pane:

```sh
/aispec                   # interrogate a spec to `status: locked`   (Claude Code)
/ailoop <spec.md>         # drive that spec to green                 (Claude Code)

loop watch                # live read-only dashboard, in another pane
loop status               # print the backlog tree once and exit
loop update               # replace this binary with the latest release, skills included
```

`loop` is the family name — the loop-engineering toolkit — and everything else it
exposes is a **mechanics verb**, one measurement or bookkeeping step the
coordinator is not trusted to do in its head. Each prints JSON on stdout and
narrates on stderr, so a coordinator can parse the result without the commentary
corrupting the parse:

```sh
loop backlog <cmd> …      # the sole writer (JSON payloads on stdin)
loop frontier             # derived scheduler facts: ready, dispatchable, walls, gate freshness, coverage
loop verify --ticket … --dir … --base …    # the measurement; --cmd … for a flake probe
loop worktree add|attach|preserve|remove|merge|delete-branch <id>
loop renumber             # allocate real ticket ids to proposed drafts (stdin → stdout)
loop recovery-budget --kind … [--ticket …]  # may a recover be spent here, and what did the last two say
loop gate-amend --by … --note … --anomaly … # the gate, under the authority its anomaly grants
loop fastcheck-amend --by … --note …        # the fast tier, admitting only what exits 0 at the root
loop jurisdiction snapshot|revert         # recover's enforced product-code boundary
loop prompt <role> [--vars -]             # the role prompt, rendered
loop schema <role> [--engine codex]       # that role's output contract
loop models [<role>]      # the model chain, resolved to engine + CLI model + availability
loop postmortem --out …   # render the journal as a self-contained archive
loop learn --campaign …   # merge a harvest into .ailoop/learnings/
```

None of these takes a lock, because the seat they serve is a conversation rather
than a process: a model cannot hold a pidfile across separate verb invocations. The
only thing standing between two coordinators and one backlog is
`backlog.coordinator`, stamped at `init`, plus a human paying attention.

A campaign stamped `cli` came from the deterministic drive loop this project used
to ship (≤ v0.5.0). The verbs refuse it and say so — see [Why the coordinator is a
model](#why-the-coordinator-is-a-model).

## The spec

Input is one markdown file whose "done" is machine-checkable. Kickoff reads it
once and **refuses to start** if it can't derive check commands, listing exactly
what's missing — that refusal is the only sanctioned human interruption in a
healthy run. If the spec has YAML frontmatter with a `status:` field, a completed
campaign flips it to `status: done`.

Specs are meant to be authored with the `aispec` skill, which drives a spec to a
locked state; `loop` drives a locked spec to green.

## The skills

Two Claude Code skills ship in this repository, under [`skills/`](skills):

| | |
|---|---|
| **`aispec`** | interrogates a human into a locked spec — the front of the pipeline |
| **`ailoop`** | the coordinator seat itself — the model that drives a campaign |

```sh
loop skills install     # → ~/.claude/skills, and ~/.agents/skills for aispec
loop skills uninstall   # removes only what loop installed
```

They live here rather than in a dotfiles tree because they are **clients of this
program's contract**, not personal preferences. `ailoop` drives a campaign
entirely through the mechanics verbs; `aispec` writes specs against kickoff's
refuse-to-start gate. Rename a verb or tighten a gate rule and both go stale — so
they version and release with the thing that broke them, and `loop update`
refreshes them in the same step. CLI/prose skew used to be silent; now it can't
happen.

Two delivery modes, and the difference is load-bearing. From a **binary** there is
no `skills/` directory to point at, so the files are embedded as text imports (the
same mechanism and the same reason as the role prompts) and written out, stamped
with a `.loop-skill-version` marker. From a **source checkout** they are symlinked
instead — editing prose has to stay a file edit that is live in the next session,
because a skill needing a rebuild would make the coordinator the expensive half of
this project to change, and being cheap to change is most of the argument for
putting a model in that seat at all.

Installing writes into `$HOME`, so every ambiguous case refuses rather than
surprises: a `~/.claude/skills` that is itself a symlink is refused outright (that
is the dotfiles layout — writing through it would commit files into that
repository), and a skill directory loop didn't install needs `--force`. If your
skills directory is a single symlink today, link its entries individually so the
directory itself is real, then install.

`ailoop` is Claude-only: every judgment role is a spawned subagent, which Codex
has no equivalent for. `aispec` goes to both.

## How a campaign runs

**1 · Kickoff** (once, only when no campaign exists). One agent reads the spec
and *runs* candidate commands to confirm them, yielding the campaign config: the
fast checks (per-ticket tier), the campaign `gate` (the slow suite), and
out-of-scope boundaries, and an enumeration of the spec's normative clauses as
`requirements` — `R1`, `R2`, … Then decompose turns the spec into open tickets —
each with declared `modules`, `depends_on`, `resources`, prose context,
acceptance, its own `acceptanceChecks`, and the requirement ids it `satisfies`.
The spec path and sha256 are persistent backlog state and mirrored into the
audit journal: a resume against an edited spec refuses rather than drive an old
contract to green.

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
Two things hedge that: kickoff opens the complete enumeration in the dashboard
(`R` returns to it later; non-TTY runs print the same list) and mirrors it into
the audit journal, and the terminal coverage pass still re-reads the spec
against the list and reports clauses missing from it as enumeration gaps.

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
  weakened tests, special-cased inputs, scope creep — the build is discarded and
  the cheated check gets sharpened before re-dispatch), `sharpen` (the build is
  affirmed correct but the checks can't observe a locked clause — the checks
  grow, the build is preserved and re-proven rather than rebuilt), `flake-probe`
  (re-run a command N times), `amend-typo`, or `escalate`.
- **close** merges to mainline, fast-forwarding when the ticket's base is still
  the tip — a merge commit there would record nothing the journal's close event
  doesn't. A merge conflict is an *infra* failure, not a merit one — the ticket
  rebuilds against the moved HEAD without burning its attempt budget. If mainline
  moved, the fast tier re-runs on the merged tree.

Every 5 closes, a **sweep** agent reads the journal since the last sweep plus
every prior sweep's summary — the summaries are the rolling memory, which keeps
each read bounded instead of quadratic over the campaign — and names the
cross-ticket pattern no per-ticket verdict can see: a systemic landmine, a
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
  recover log is the coordinator's own escaped-bug record, and a recurring kind is
  a missing instruction in `SKILL.md` rather than a run of bad luck.

  Two things contain the most privileged actor in the loop. **The product-code
  boundary is enforced, not trusted** (`jurisdiction.ts`): recover holds the
  mainline lock for its whole run, so the checkout before and after is
  attributable to it alone. Any tracked, non-manifest file it changed —
  committed or not — is reverted, and the reverted diff becomes a repair ticket
  a worker builds and the review judges. Untracked scratch files, manifests
  (an install *is* a manifest edit) and cleaning away pre-existing dirt all stay
  in bounds. **And a recurring anomaly stops being recoverable**: the
  budget counts recover's *resolutions* per anomaly — per ticket for ticket-scoped
  kinds, per campaign for the rest — and past two the campaign parks with the prior
  fixes attached instead of calling a fresh agent that will write a third confident
  success note. `loop recovery-budget` owns both the scoping rule and the count, so
  neither is the coordinator's to infer or recall; they live in `backlog.json` and
  survive a resume and a compaction. That is also what bounds the gate-red → repair
  → gate-red loop, since every round of it resolves.
- **Opportunistic noticing → the sweep**, above. A scheduled substitute for
  ambient attention.

### Failure is a taxonomy

Nothing hard-stops that a human could resolve later. Merit failures (verify red,
gaming, judge-rejected) count toward a ticket's attempt cap and climb the worker
model ladder; infra failures (dead session, operator kill, moved mainline) don't.
A ticket that walls gets recover's diagnosis twice, then parks. When nothing
autonomous remains the campaign **drains**: a report of every deferred decision with
its recorded reason, `.ailoop/campaign/` left exactly as it is, and the human's
answer picked up by the next `/ailoop`.

## Dashboard

`loop watch`, in a pane beside the session that is driving. It is a **reader**: it
owns nothing, holds no lock, and can be started, killed, and restarted at any point
in a campaign — including before one exists and after it ends.

That constraint sets the whole design. The coordinator is a model in a
conversation, so there is no process to attach to and no way to ask it anything;
`watch` polls `backlog.json`, `journal.jsonl`, and the live-run directory
(`snapshot.ts`) at 2 Hz. Polling rather than `fs.watch` because the backlog is
replaced by atomic rename, and a path watcher misses exactly the writes that
matter.

The main screen is a **pipeline board** — a column per stage, tickets flowing
left to right, because the loop *is* a pipeline and a flat list left the motion
to be reconstructed in the operator's head. The grain is still the ticket, and
that pivot is forced rather than chosen: the screen used to list processes,
because the drive loop owned them; a reader cannot have that list, since most of
a ticket's life is an agent inside the coordinator's own session. What the files
do support is where each ticket has got to:

```
 ready 4 +2⋯ │ building 2  │ verify 1     │ review 1    │ closed 9/18
─────────────┼─────────────┼──────────────┼─────────────┼──────────────
 T013        │ T012 2m08s  │ T014 38s     │ T007 4m12s  │ ██████░░░░░
 T016        │ T015 11m ⚠  │ $ 12 passed  │             │ gate —
 ⋯ T020      │             │              │             │ ✓ T011
```

Under the board, in attention order: checks no ticket owns (a campaign gate run,
rendered full-width while it exists), whatever waits on a human — a parked
ticket with its reason, a parked gate, an unclaimed clause — or the one line
saying nothing does, then the last few story events from the journal. The
screen answers "do I need to do anything?" before it answers anything else.

The phase comes from `loop backlog phase`, which the coordinator stamps as it moves
a ticket through settling. It is the only field in the snapshot no mechanic reads —
it exists for **invariant 1** (a ticket is never `in-flight` without a live
worker), the coordinator's one failure with no symptom: a stranded in-flight ticket
silently holds its modules against everything that shares a directory with it.
`verifying for 40m` is a diagnosis; `in-flight` alone is not.

The indented `$` rows are the exception where the tail is real output. A verb
holding a child process publishes its own window to `.ailoop/campaign/live/`
(`live.ts`) and deletes it on the way out — the coordinator never sees that stream,
but the verb does, so the verb writes it. A leftover file whose pid is dead is
dropped rather than rendered as running.

**Staleness, not liveness.** The old cell sampled process-subtree CPU and could say
*this is working*. Nothing on disk distinguishes "the coordinator is mid-way
through a twenty-minute review" from "its session died forty minutes ago", because
the gap needing coverage is precisely when it isn't writing. So the header shows
`quiet 6m` from the journal's mtime, ambering past 5 minutes and reddening past 20.
A probed pid outranks the clock: a two-hour e2e suite reads `▶ check running`.

Reading is free-roam: `tab` to the filterable journal, `R` for the locked
requirement enumeration and its claiming tickets, `t` for tickets, `g` for the
dependency DAG as a rail graph, `↵` for a ticket's detail or a check's live output.

Prose **wraps rather than truncating**, everywhere it is the thing you came to
read: journal bodies (a park reason is a paragraph), ticket titles and contracts,
every attempt's hypothesis, and a check's output. Panes therefore budget the frame
in display *rows*, not entries, and scrolling moves by row (`layout.ts` holds that
arithmetic). Three things still cut at the edge on purpose: the board's cells and the
rail graph's labels, which are one-line summaries of something `↵` opens in full; a
check's in-progress line, so a progress bar rewriting itself cannot resize the
pane; and the header/footer chrome.

**There are no controls** — no pause, no worker cap, no kill. Those existed when the
drive loop was in-process and could honor a flag at its next decision point.
Reaching a model in a conversation would mean writing a request file and hoping it
reads it, and a control that *might* be obeyed is worse than no control.

Off a TTY (piped, CI, container logs) `loop watch` prints the `status` tree once
and exits; Ink is never loaded.

## Agents, engines, models

A model name carries its engine as a prefix — `claude-opus`,
`codex-gpt-5.6-terra`; a bare name means claude. Each role in
[`src/campaign/agents/models.ts`](src/campaign/agents/models.ts) has a preference chain: unavailable
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
  backlog.json             AUTHORITATIVE snapshot — contract, tickets, gates,
                           recovery budgets, sweep cadence; validated transitions
  journal.jsonl            append-only audit record; never replayed into state
  evidence/                per-ticket check logs and diff patches
  live/                    one file per running check, published by the verb that
                           holds it; deleted when it ends. `loop watch` reads these
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

Every `backlog.json` mutation goes through one synchronous writer that validates
the transition and atomically replaces the snapshot before appending its audit
event. Atomic because the reader is a separate process: `loop watch` polling a file
mid-write would otherwise parse a torn snapshot. Resuming reads the backlog directly
and reconciles in-flight tickets against Git; nothing reconstructs current state
from the journal.

## Development

```sh
bun test src
bun run typecheck   # tsc --noEmit, strict
```

| Path | |
|---|---|
| `src/index.ts` | CLI shell — verb wiring only |
| `src/mechanics.ts` | the mechanics verbs: the whole surface the coordinator drives through |
| `src/campaign/backlog.ts`, `frontier.ts`, `journal.ts` | authoritative snapshot writer and id allocation, pure derived scheduler facts, audit record |
| `src/campaign/verify.ts`, `worktree.ts`, `provision.ts` | the measurement and its scope check; worker checkouts and their dependency trees |
| `src/campaign/gate.ts`, `fastcheck.ts`, `jurisdiction.ts`, `recovery-budget.ts` | the enforced authority boundaries: who may replace a live check, what must be measured before admission, what recover may touch, when it stops being believed |
| `src/campaign/paths.ts`, `state.ts`, `live.ts` | where campaign state lives (a leaf); shell execution and spec hashing; the live-run window a verb publishes for the dashboard |
| `src/campaign/agents/` | the judgment layer: role prompts, output schemas, model chains, engine naming and codex's schema adaptation |
| `src/tui/` | `loop watch` — the file-reader snapshot, the Ink dashboard, the rail graph, and the pure layout arithmetic |
| `src/campaign/postmortem.ts`, `learn.ts`, `progress.ts` | the durable archive, the learnings merge, the rendered tree |
| `skills/`, `src/skills.ts` | the `aispec`/`ailoop` skills and `loop skills install` |
| `src/update.ts` | `loop update` — verified self-replacement |
| `build.ts` | the release build: four cross-compiled binaries + `sha256sums.txt` |
| `next-version.ts` | the version a push earns, read off its commits |

Prompts and the skills are embedded as text imports rather than read at runtime,
because a compiled binary has no `src/campaign/agents/prompts/` to read from.
Adding a campaign role therefore adds an explicit entry in
`campaign/agents/prompt.ts`.

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

### Why the coordinator is a model

This began as `ailoop`, a Claude Code skill — a model in the coordinator seat
reading prose. Its design rule was *"judgment lives with you; everything with one
right answer lives in a script,"* and every revision moved more of the coordinator
into scripts: backlog writes, frontier arithmetic, verification, and finally the
cheat check — forcibly outsourced, because a coordinator that dispatched a ticket
is the builder's advocate, not its auditor.

That argument seemed to generalize all the way. If a long-lived coordinator is
context-poisoned for every verdict, take it out of the seat entirely: control flow
as code, every judgment a fresh process. So `loop campaign` was built as the fixed
point of that trajectory, and for a while both seats existed over one set of
mechanics, on the theory that a comparison would settle it.

**The comparison didn't need running.** `drive.ts` became the most-churned file in
the repository, and every commit was the same shape: a fault nobody had enumerated,
promoted into a new arm. That is the cost structure of code in the seat — not a
bug to fix but the thing itself, because the seat's actual job is *what to do when
the situation has no name*, and code cannot improvise. Its own [Known
limits](#known-limits) recorded the pattern in the third person: "a scripted bisect
arm is the obvious first promotion out of the recover log." There was always
another arm.

What code in the seat bought — deterministic resume, no compaction risk, no idle
coordinator tokens, campaigns outliving a session — turned out to be purchasable
another way: put the durable facts in files and make the verbs refuse illegal moves.
That is what the mechanics surface already was. So the drive loop was removed at
v0.5.0 and the skill drives.

The half worth keeping is the discipline the argument produced. A model in the seat
improvises, which is precisely why it is the wrong place to keep a count, a budget,
or a gate's freshness — so it keeps none of them. Every verb in `mechanics.ts`
exists because the alternative is a coordinator doing arithmetic by eye and
reporting the result as fact.

**Honest status:** this is an argument from the shape of the code and its churn, not
from two campaigns measured side by side. Neither seat ever drove a spec to green.
The claim is that the *maintenance* cost of an enumerated ladder is real and
observed; the claim that a model in the seat drives a spec better is still untested.

### What the seat is not trusted with

The dividing line, since it is the whole design. The coordinator decides; it does
not measure, count, or remember. Concretely, these are verbs rather than
instructions because a plausible wrong answer to each is invisible downstream:

| | why not the model |
|---|---|
| `frontier.gateGreen` | a remembered green carried past new work is the easiest false "done" in the loop |
| `renumber` | a draft's edge onto its sibling silently becomes an edge onto whatever live ticket holds that number now |
| `recovery-budget` | guess the scoping rule loose and the budget never trips, which looks exactly like a budget with room left |
| `gate-amend` | no comparison of two shell strings proves a replacement is a tightening, so the authority comes from the anomaly |
| `fastcheck-amend` | "I ran it at the repo root and it passed" is a claim; the verb runs it |
| `verify` | a worker's report is testimony. Exit codes and `git diff` are evidence |

The coordinator also never fills a judgment role itself — review, sweep, coverage
and recover are all spawned with fresh context, because the seat that dispatched
the work is the last one that should grade it.

`.ailoop/learnings/` survives a campaign and feeds the next one's kickoff, which is
the only way a later campaign can compare against an earlier one.

### What the first campaigns must measure

Several arguments above are settled by cost structure, not data — the same
epistemic status as retiring the drive loop. Each carries a falsifiable
prediction, and the journal already records the events that decide it, so the
first campaigns double as the experiment. Re-litigating any of these before the
data exists is design-by-prior; so is building more mechanics.

- **Review's price.** The adversarial review is priced for workers that game and
  misread. Count `gamed` verdicts and wrong-boundary retries per campaign:
  near-zero after a handful of campaigns means review is over-priced insurance
  and can be lightened — sampled, or triggered only on rung-climbs — with
  evidence in hand rather than priors about model character.
- **The fault tail.** "There was always another arm" was observed during
  development, not steady state. Tally recover kinds per campaign: a kind
  recurring with a stable shape is the next verb candidate, and a tail that
  flattens reopens the script-seat question honestly — that bet was settled on
  cost structure, and this is the counter-evidence that would unsettle it.
- **Narrative continuity.** The model seat's claimed edge is lived context: it
  diagnoses from having watched the situation develop, where the old escalate
  path handed a fresh agent a briefing for a fault the script never anticipated.
  If that's the real mechanism, coordinator quality should drop right after a
  context compaction — the moment its history becomes a summary, it *is* the
  briefing-packet agent. Observed degradation → invest in the journal as
  reconstruction; none → compaction risk is overweighted.
- **`loop watch` fidelity.** Already a known limit: the dashboard has never
  rendered a real campaign. The first one is its validation run.

## Known limits

- **Workers run `--dangerously-skip-permissions`** (as does the kickoff agent, so
  it can probe toolchain commands). This is built for a devcontainer workflow;
  running it on a host shell hands headless agents unrestricted tool access.
- **Not yet exercised on a real campaign.** The mechanical spine (init → seed →
  add → frontier → dispatch → verify → scope-fail → merge → resume) is tested; a
  full spec-to-green run is not. First campaign should be a small spec, watched.
- **`loop watch` has never been checked against a known-good live run.** The drive
  loop that could have provided one was removed in the same change that made the
  dashboard a file reader, so its panes have unit coverage and a smoke test but no
  side-by-side comparison against a campaign rendered from process memory.
- **The dashboard reports staleness, not liveness.** Nothing on disk separates a
  coordinator mid-review from a coordinator whose session died. A quiet campaign
  and a dead one look the same past the amber threshold; the wording says so rather
  than dressing a timestamp up as a heartbeat.
- **Worker cost is only as complete as the coordinator reports.** Token counts reach
  the archive through `backlog close --data`, and the coordinator's harness does not
  always surface its subagents' usage. The post-mortem distinguishes fully priced,
  partially priced (labelled, with the count), and unpriced (the section says so)
  rather than rendering absent spend as free work.
- **The codex null-strip has no verb.** `loop schema --engine codex` serves the
  write half of codex's strict-mode adaptation; the read half (`stripNulls` in
  `campaign/agents/engines.ts`) is exported but unreachable, so a coordinator
  running codex may see a `null` where Claude gives an absent key.
- **Gate bisection is delegated, not scripted.** On a red campaign gate, recover
  gets the evidence and every branch (all kept until the gate is green) and
  decides. The bisection surface is the whole campaign, not a phase — that's the
  cost of running e2e once instead of per phase.
