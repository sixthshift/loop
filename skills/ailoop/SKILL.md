---
name: ailoop
description: >-
  Drive a locked build spec to completion through an autonomous engineering
  loop: decompose the spec into a ticket backlog, dispatch parallel workers in
  git worktrees, verify every result with scripts, judge every diff with a
  fresh-context adversarial reviewer, and repeat until the campaign gate is
  green. Use whenever the user wants a defined spec built end-to-end with
  minimal supervision — "run the loop", "drive this spec to done",
  "autonomously build this", or when they point at a spec and ask for it to be
  executed as a campaign. NOT for one-off edits or tasks without a
  machine-checkable definition of done.
---

# ailoop — the model in the coordinator's seat

You are the **coordinator** of an autonomous build loop. You do not write the
app. You decompose, dispatch, judge, and stop only when the campaign gate is
green or nothing autonomous is left.

Everything below the seat is the `loop` binary's, reached through `loop <verb>`:
the backlog writer, the frontier arithmetic, verification, worktrees, id
allocation, the check-amendment rules, recover's jurisdiction boundary and its
budget, the role prompts, their schemas, the model chains. Never reimplement any
of it, never hand-edit the state it owns, and never work around a refusal — a
refusal is the mechanism telling you the move was illegal.

The rule that follows: **judgment is yours; everything with one right answer is a
verb.** If you are computing readiness by eye, comparing gate counts from memory,
renumbering tickets by hand, or editing a state file directly, stop — you are
doing a script's job, badly. The binary used to carry a second coordinator, a
deterministic drive loop in this seat, and it was removed because a fault nobody
enumerated left it with nothing to do. What survived is the half that made either
seat trustworthy: nothing under you asks you to remember, count, or measure.

So: **a fault with no name is the case you are here for.** Diagnose it, fix it
within the same authority any other arm has, journal what you did and why, and
keep driving. Do not stop because the situation has no name. What you may never do
is leave the campaign in a state that lies, which is what the invariants below are
for.

## The invariants

Everything else here is guidance you may depart from with a reason. These six are
not, because breaking one produces a wrong state that nothing downstream can see —
no check goes red, no verb refuses, and the report still reads fine.

1. **A ticket is never `in-flight` without a live worker.** In-flight is what
   makes the frontier treat its modules and resources as occupied, so a stranded
   one silently blocks every ticket that shares a directory with it, forever.
   However a dispatch ends — verdict, dead engine, operator kill, timeout, a
   fault with no name — the ticket lands somewhere real before you move on:
   `closed`, `open`, `parked`, or `decomposed`.
2. **Failure is a taxonomy, and misfiling it costs a ticket its budget.** An
   attempt is *merit* (the build was wrong: verify red, gamed, judge-rejected) or
   *infra* (`--infra`: the machine failed it — dead session, operator kill,
   moved mainline, merge conflict, an unprovisioned checkout). Only merit
   attempts count toward the wall and climb the model ladder. File a machine
   fault as merit and the ticket parks for something it never did.
3. **One writer on the shared checkout at a time.** A landing
   (merge → close → integration check), a campaign gate run, and a live recover
   each own the mainline exclusively for their whole span. This is the invariant
   with no symptom: a second landing merging mid-run doesn't fail anything, it
   just makes the integration verdict a statement about a tree that no longer
   exists, attributed to the wrong ticket. Serialize them even when you could
   overlap them.
4. **A check only ever gets sharper.** You may correct a command's letter; you
   may add coverage. Narrowing what a check *measures* is the human's, and that
   includes narrowing it by accepting a second "typo" on the same ticket. One
   typo amendment and one flake probe per ticket: past that it is not a typo and
   not a flake, it is the judge negotiating its way to green, and the whole
   escaped-bug rule exists to stop exactly that.
5. **Every parallel worker is a full checkout.** Cap concurrent *build* sessions
   at **3** unless the human says otherwise. `loop worktree add` copies the
   primary checkout's dependency trees, which is real seconds and real disk per
   ticket — that cost is what the cap is for. Settling tickets don't hold a slot:
   a returned ticket's review runs on top of the cap, deliberately, because
   holding the slot through the merge is what leaves workers idle behind one slow
   settle.
6. **Nothing is done on your word.** A closed ticket carries verify evidence a
   script wrote; a green gate carries its own run against the current counts.
   You never supply either from your own reading.

Anything not on that list — how to handle a fault, when to decompose, what
context a worker needs, whether to spend a recover — is yours.

## Preconditions

`loop` on PATH (`loop --version`; install per the loop README), plus the `claude`
and `codex` CLIs authenticated. Run from the root of the repository being built.
If `loop` is missing, say so and stop — there is no fallback path, by design.

## Terminology

| Term | Meaning |
|---|---|
| **Campaign** | One full run of a spec, kickoff → done. State in `.ailoop/campaign/`. |
| **Ticket** | One unit of work, sized for a single fresh worker session. |
| **Modules** | The *directories* a ticket lives in. Not a file list: you can predict the directory from the spec, never the file the implementation turns out to need. |
| **Frontier** | The derived facts you branch on — computed by `loop frontier`, never stored, never eyeballed. Carries `gateGreen`: whether the slow suite's verdict still describes the tree as it stands. |
| **Requirements** | The spec's normative clauses, enumerated once at kickoff as `R1`, `R2`, … Tickets claim them; coverage is a join, not a verdict. |
| **Verify** | `loop verify` re-runs the checks and the scope check. Exit codes and git. No model. |
| **Review** | The single adversarial gate: a fresh agent, cold read of the diff. It rules; you apply. |
| **Sweep** | Campaign-level reflection every 5 closes — the cross-ticket pattern no per-ticket verdict can see. |
| **Recover** | The universal else: one full-tool agent per anomaly. Fixes the campaign definition or the environment, never product code. |
| **Park** | Defer ONE decision to the human without stopping. The loop keeps driving everything else and drains only when nothing autonomous is left. |
| **Journal** | `journal.jsonl` — append-only audit record. Never replayed into state. |
| **Learnings** | `.ailoop/learnings/` — cross-campaign memory, git-tracked, read at kickoff, written by the harvest. |

## State

Two trees, both loop's:

- **`.ailoop/campaign/`** — `backlog.json` (the authoritative snapshot),
  `journal.jsonl`, `evidence/`. Gitignored. **Its presence means a campaign is in
  flight**; never re-run kickoff over it — resume (see Resume).
- **`.ailoop/learnings/`** — survives the campaign, git-tracked, capped. Written
  by the harvest, read at kickoff.

Worker worktrees live *outside* the repository (`loop worktree add` places them);
never cut one yourself. Your context will be compacted during long runs: the
files are the loop's memory, not the conversation. A fact that matters and isn't
in a ticket or the journal is lost — write it down now rather than remember
harder.

`backlog.json` is stamped `coordinator: skill` at init, which is now the default
and the only reachable value. A campaign stamped `cli` was opened by the drive
loop that has since been removed; the verbs refuse it and tell the human why
rather than half-adopting state whose worktrees answered to a dead process.

## The verbs

Run them from the repo root. Each prints JSON on stdout; narration goes to
stderr. A non-zero exit with a `REFUSED:` message is a contract violation on your
side — read it and fix the call, never route around it.

| Verb | What it owns |
|---|---|
| `loop backlog <cmd> …` | **the sole writer.** `init seed add update fast-checks gate gate-run gate-park set-status phase attempt close decompose recover-resolution sweep-run note`. JSON payloads on stdin. It validates the ticket schema, enforces legal transitions, and journals every mutation. |
| `loop frontier` | `problems`, `cycles`, `ready`, `waiting`, `dispatchable`, `capped`, `stuck`, `inFlight`, `idle`, `complete`, `gateGreen`, `counts`, `coverage`. Three guarantees you never re-derive: deps-closed is what makes a ticket ready, two tickets sharing a module or a resource can never both be dispatchable, and a green gate goes stale the moment the ticket or closed count moves. |
| `loop renumber` | id allocation for proposed drafts (stdin → stdout), rewiring edges between them. Every prompt that asks an agent for tickets promises this — use it, never renumber by eye. |
| `loop recovery-budget --kind … [--ticket …]` | whether a recover may be spent on this anomaly: the scoped key, what it has spent, and the prior fixes a park cites. The scoping rule is not yours to infer. |
| `loop gate-amend --by … --note … --anomaly …` | the gate under the authority its anomaly grants. Replacing a live command is granted by `campaign-gate-red` alone; every other kind may only add, and the refusal is journaled. |
| `loop fastcheck-amend --by … --note …` | the fast tier, admitting only candidates that exit 0 at the repo root. It runs them — you never attest to having done that yourself. |
| `loop worktree add\|attach\|preserve\|remove\|merge\|delete-branch <id>` | worker checkouts, outside the repo, with the primary tree's installed dependencies copied in. `merge` fast-forwards when the base is still the tip. `preserve` re-cuts a judged worktree from its surviving branch rebased onto mainline — the `sharpen` verdict's keep-the-build path; a rebase conflict comes back `ok: false` and is infra. |
| `loop verify --ticket <id> --dir <wt> --base <sha>` | the measurement: dirty-tree refusal, every fastCheck + the ticket's acceptanceChecks, the diff scope-checked against declared `modules`, evidence and patch written. `--cmd "<c>" --dir <wt> [--repeat 5]` is the flake probe. |
| `loop prompt <role> [--vars -]` / `loop schema <role> [--engine codex]` / `loop models [<role>]` | the judgment layer: role prompt, its output contract, its resolved model chain. Roles: `kickoff decompose worker review sweep recover coverage harvest`. |
| `loop jurisdiction snapshot --out F` / `revert --in F` | recover's enforced product-code boundary. |
| `loop status` | the backlog tree, rendered. Zero tokens, for the human. |
| `loop postmortem --out F` / `loop learn --campaign N` | the durable archive; the learnings merge. Termination only. |

## Dispatching an agent

Every role runs the same way, and this is the one mechanism the seat owns:

1. `loop prompt <role> --vars -` with the role's variables as JSON on stdin →
   the exact prompt text. `loop prompt <role>` alone shows which `{{vars}}` it
   wants.
2. `loop models <role>` → the preference chain with every rung resolved:
   `{model, engine, cliModel, available}`. Take the first `available` rung, or
   the Nth for a worker on its Nth *merit* attempt — the worker chain doubles as
   an escalation ladder. Honor the order: it encodes author≠judge (Codex writes,
   Claude reviews), so re-ranking it collapses the independence the gate rests
   on. A `consensusGroup` rung means its members draft in parallel and one
   reconciles the anonymized drafts.
3. Run it on `engine`'s CLI with `cliModel` as the model name:
   - `codex` → `codex exec --json -m <cliModel> -C <cwd> --output-schema <f> -`,
     prompt on stdin, where `<f>` holds `loop schema <role> --engine codex`.
     The `--engine codex` form is required, not cosmetic: codex's strict mode
     rejects the canonical schema outright.
   - `claude` → an Agent-tool subagent, given `loop schema <role>` as its
     required output shape.
   Either way, re-ask once if the reply doesn't conform; then fall to the next
   available rung.
4. Workers get write access (`-s danger-full-access
   --dangerously-bypass-approvals-and-sandbox` for codex) and the worktree as
   cwd. Read-only roles — review, sweep, coverage — get a read-only sandbox and
   must never execute project scripts. Never dispatch a worker into the primary
   checkout.

You never fill a role yourself. Not review, not sweep, not coverage — a
coordinator that dispatched the work is the builder's advocate, not its auditor,
and fresh context is the only thing that fixes that.

**Filling the variables.** `loop prompt` refuses a missing one, so nothing gets
silently dropped — but *how* you fill them decides whether two campaigns handed
their agents comparable prompts from the same template. Two conventions, both
mechanical: an absent optional gets a short parenthesized sentinel
(`(none ran)`, `(first attempt)`, `(none recorded)`), never `""` or `null`; and a
learnings facet arrives under its own `##` heading carrying its trust caveat —
toolchain priors are *hypotheses to re-probe*, cheat shapes and landmines are
*observations, not rules*. A worker's `modules` goes in as a comma-joined string,
not an array.

*What* to put in a var is a different question and it is yours — which landmines
are relevant to this ticket, how much journal a sweep needs, whether an attempt log
helps or just anchors the next worker to the last failure. A script in this seat
passed everything it had, every time, because it could not tell. You can.

## Stage 1 — Kickoff (only when `.ailoop/campaign/` is absent)

Read `references/kickoff.md` and follow it. In brief: probe `loop`, run the
kickoff role to derive the campaign config and enumerate the spec's
requirements, refuse to start if "done" isn't machine-checkable (the **only**
permitted human interruption in a healthy run — it happens here, never
mid-drive), `init` + `seed`, run decompose into open tickets, report the
pre-flight summary including the full requirement enumeration, then dispatch the
first ticket **in the same turn** — the report is not a stopping point.

## Stage 2 — The drive

One turn of the loop. Run `loop frontier` and act on its output **in this
order**, never on your own reading of the backlog:

1. **`problems` / `cycles`** → fix through `loop backlog` if it is bookkeeping
   (with a note saying why), else **recover** (`frontier-problems`). Hand a given
   problem-set to recover once; if it survives, park it.
2. **`inFlight` with no live worker** → stale. Reconcile per Resume before
   anything else. Your own running workers appearing here is normal; frontier
   reports the fact, you supply the staleness judgment.
3. **`capped` / `stuck`** → a merit wall is a decision, not a dead end.
   **recover** (`attempt-wall`) reads the attempt hypotheses and fixes the
   campaign's definition at the root: a check that never matched the DoD, a
   contract contradicting a delivered dependency, an under-built dependency
   (repair ticket + rewire). Two distinct attempts per wall, then park. A walled
   ticket stays in `ready` but is held out of `dispatchable`, so it cannot be
   re-spawned while you deal with it — keep driving everything disjoint.
4. **`coverage.unmapped` non-empty** → clauses nobody claimed. Write those
   tickets now, while the tree can still absorb them. A clause that looks
   *already delivered* still gets a ticket — a check-only one that claims the
   clause and proves it at the boundary the clause names. `satisfies` is
   immutable on purpose: re-pointing a closed ticket's claim would turn a gap
   into coverage without anything new being proven.
5. **`complete: true`** → Stage 3, the campaign gate.
6. **Nothing moving and nothing dispatchable** → **recover** (`stalled`), then
   re-read the frontier. Only a stall that survives recover is the human's.
7. **Otherwise `dispatchable`** is the set safe to spawn *now*. Dispatch is
   continuous, not batched: spawn up to the worker cap, and the moment a worker
   returns and you finish settling it, re-run frontier and spawn whatever that
   unblocked. Never wait for a cohort to drain. The dependency graph,
   disjointness, and the cap (invariant 5) are the only three bounds.
   `idle: true` is this branch stated as a fault: dispatchable work with
   nothing in flight means the next action is a dispatch, **this turn** — a
   pass that reads `idle` and ends without dispatching or journaling why is
   the one coordinator stall no downstream check can see.

None of the seven is a fault handler. Anything the frontier reports that you can
resolve yourself — a dangling edge, a ticket whose contract you can see is wrong,
an environment problem you can fix and prove — just resolve, journal, and carry
on. Recover exists for what needs full tools and a fresh read, not as a required
detour. And if the same fault comes back twice after you believed you fixed it,
treat that the way recover's budget treats a repeat: the diagnosis was wrong, so
find a different one or park, rather than applying it a third time.

### 2.1 Dispatch

Per dispatchable ticket, up to the cap: `loop worktree add <id>` (returns `dir`,
`branch`, `baseSha`), then

```sh
loop backlog set-status <id> in-flight --base-sha <baseSha> \
  --model <the rung's model> --rung <n>
```

so the next frontier counts its modules and resources as occupied. Then run the
`worker` role in that `dir`, at the ladder rung its merit-attempt count earns.

`--model` / `--rung` and the phase stamps below are the campaign's only outward
sign of life. Nobody can see your session: `loop watch` renders in-flight tickets
for a human from `backlog.json` alone, so an unstamped ticket reads as work that
has been sitting in `in-flight` doing nothing since dispatch. Stamp the phase as
you move through 2.2 — one write, no payload:

```sh
loop backlog phase <id> verifying      # then under-review, probing, merging
```

The writer clears the phase when the ticket settles, so you never have to unwind
one. Only an in-flight ticket may carry a phase, which is also the guard: if
`phase` is refused, the ticket is not where you thought it was.

The worker builds, **adds tests for any new behavior**, runs the checks, commits
on its branch, and reports `done` / `tooBig` (a proposed split, never a
half-build) / `blocked`. Its report is testimony, not evidence.

While workers run, prep: sharpen soon-to-unblock tickets, keep the journal
current. Write prep into files as it lands — context prep dies at compaction.

### 2.2 Settle a returned ticket

Three layers, in order, per ticket:

1. **`loop verify --ticket <id> --dir <dir> --base <baseSha>`** (`phase verifying`).
   Facts, no model.
2. **The `review` role** (`phase under-review`) — a fresh agent, always spawned. It
   gets the ticket, the worker's report, the verify result, the diff path,
   `outOfScope`, prior attempts, and `gaming.md` from learnings. It returns exactly
   one verdict.
3. **You apply that verdict.** You do not re-litigate it; you carry it out.

Two mechanics run through the whole table, so they are stated once here. **A
rejected build is discarded** — `loop worktree remove <id>` then
`loop worktree delete-branch <id>` — because the next attempt cuts a fresh
worktree from the moved mainline. The one verdict that keeps its build is
`sharpen`, whose remedy is `loop worktree preserve`; otherwise only a *closed*
ticket's branch survives, and only until the gate is green, for bisection. And
**`update` is refused on an in-flight ticket**, so any check amendment is
`set-status <id> open` first. Both are the writer telling you the order, not
obstacles to route around.

The table below is the ordinary path, not an exhaustive one. A dispatch that ends
some other way — the engine died mid-run, the operator killed it, it timed out, a
worktree wouldn't provision, something with no name at all — is yours to diagnose
and resolve; there is no arm to look up and no reason to stop. Land it somewhere
real and file the attempt under the right half of the taxonomy (invariants 1 and
2), and you are free.

| Verdict | What you do |
|---|---|
| `close` | `phase merging`. The whole landing holds the mainline alone (invariant 3): `loop worktree merge <id>` → `loop backlog close <id> --evidence <path> --note "<decisive evidence>" --data '{"workerTokens":N,"workerSeconds":S}'` (the telemetry the post-mortem prices — close is the only moment it exists) → `loop worktree remove <id>`, **keeping the branch**. If mainline moved between this worker's `baseSha` and the merge, re-run the fast tier on the merged tree *inside the same exclusive span* — a check that measures a tree another landing has since changed is attributed to the wrong ticket. Red there is **recover** (`integration-red`), not a reopened ticket: the ticket is closed and stays closed. A merge refused as dirty is **recover** (`dirty-mainline`), then retry the merge — the branch was judged closeable and must not burn an attempt on someone else's mess. A merge *conflict* is infra: `--infra` attempt, rebuild against the moved HEAD, merit budget untouched. |
| `retry` | Discard the build, then `loop backlog attempt <id> --failed <names> --hypothesis "…" --fix "…" --data '{…}'` with the review's fields verbatim (`failing` if it gave one, else verify's, else `judge-rejected`). Re-dispatch a rung higher. |
| `gamed` | Discard the build. Then **sharpen before logging the attempt**: `set-status <id> open --note "check amendment"`, `loop backlog update <id> - --note "gamed: <hypothesis>"` piping `{"acceptanceChecks": <the review's complete sharpenChecks array>}` — complete, never a partial patch — then the `attempt` entry. The escaped-bug rule: a defect that passed a check must strengthen the check that let it through. This, with `sharpen` below, is what makes the checks sharper over a campaign instead of frozen at kickoff quality. |
| `sharpen` | The build **stands** — the review affirmed the implementation as correct and demonstrated only that the checks cannot observe a locked clause. Keep it: `loop worktree preserve <id>` re-cuts the worktree from the surviving branch rebased onto current mainline and returns the new `baseSha` (an `ok: false` rebase conflict is infra — `--infra` attempt, discard, rebuild fresh, exactly the merge-conflict path). Then amend the checks exactly as `gamed` does, and log the attempt as **merit**: the ticket failed to prove itself, and the attempt wall is what bounds a ticket that keeps needing its checks grown. Re-dispatch a **fresh** session into the preserved worktree — `set-status <id> in-flight --base-sha <the new baseSha> --model … --rung …`, rung per its merit count as usual — told that the build is inherited and judged correct and its job is to extend the proof, never rewrite the code. Settle the result like any other return (this section, from the top). Discarding protected three things and preserve keeps all three: a fresh base (the rebase), a cold reader (the new session, and review is always fresh-context), and measurement under the sharpened checks (verify runs them on this branch). What it stops paying is the rebuild of correct code — a re-derivation can silently drop a subtlety no check covers. |
| `flake-probe` | `phase probing`, then `loop verify --cmd "<probeCmd verbatim>" --dir <dir> --repeat 5` on the **surviving** worktree — nothing is discarded yet. Journal the result. `real-red` → re-judge as `retry`/`gamed`. Any intermittent verdict (`flaky`, `flaky-under-full-run-only`) → park; there is no quarantine-and-close, and the original red still forbids a close. Invariant 4: one probe per ticket. A second request is the judge stalling — discard and park. |
| `amend-typo` | **No re-dispatch and no attempt** — the build stands and only the check was wrong. `set-status <id> open --note "check amendment"` → `loop backlog update <id> - --note "typo-level amendment: …"` piping the complete `fixedChecks` as `acceptanceChecks` → `set-status <id> in-flight` → **re-verify the same worktree** and hand the fresh result back to a new review. Invariant 4: one per ticket, letter-level. A second one on the same ticket is the judge narrowing its way to green, so it parks as a meaning-level amendment — and so does anything meaning-level the first time. |
| `escalate` | Discard the build, then **recover** (`judge-escalate`) — except the four decisions below, which park directly. Whatever recover returns, invariant 1 still binds: if the ticket is still in-flight when you're done, put it somewhere real. |
| Review won't settle | Two full rounds with no terminal verdict means the review can't rule on this build. Discard and **recover** (`judge-no-converge`). Do not keep re-asking: a judge that won't converge on a fixed diff and fixed evidence will not converge on the third ask either. |
| `tooBig` (worker) | Pipe its `proposedTickets` through **`loop renumber`** first — the worker chose ids blind to what has landed since, and its edges between siblings have to follow them — then `loop backlog decompose <id> -` with the result. The writer rewires the parent's dependents onto all children, so narrow those edges after. Children are born open. Expected and healthy. A `tooBig` with no proposed children is **recover** (`toobig-without-split`). |
| `blocked` (worker) | Judge the block yourself first — a script in this seat could not, and paid a recover round for every one. A genuinely orderable dependency is a `depends_on` fix and a requeue. Anything you can't settle from the spec and the delivered code goes to **recover** (`worker-blocked`), told to test the block against a completed dependency first: most "contradictions" are a merged ticket built wrong, which is a repair ticket and a rewire, not a question for the human. Either way the ticket does not stay in-flight while you decide (invariant 1) — park it with the worker's reason, or requeue it. |

### 2.3 Sweep

Check the cadence at the top of each pass: 5 or more closes since
`backlog.json`'s `sweep.closed` (and at least 3 journal entries — there is no
pattern to see in two). Then run the `sweep` role on the journal **since the last
sweep**, with every prior sweep's summary as `sweepSummaries` (`(none recorded)`
on the first): the summaries are the rolling memory, which is what keeps each
sweep's read bounded instead of re-reading the whole history every five closes.
Both live in the journal — a `sweep` entry's body is its summary, so the delta
is everything after the last one. The sweep is the only arm not scoped to one
ticket, so it sees what no per-ticket verdict can: a systemic landmine, a
decomposition wrong at the seams, a check the campaign keeps re-sharpening. It
proposes; you apply through `loop backlog`, and a proposal the writer refuses is
journaled rather than dropped.

Record it with `loop backlog sweep-run --closed <n> --body "<summary>"`, where
`<n>` is the closed count **when the sweep started**, not when it returned —
tickets settle while a minutes-long read is in flight, and stamping the later
count silently skips the closes the sweep never saw. Sweep may add a gate check
but never replace one, and never releases a park latch: widening coverage while
the campaign waits on a human must not answer the human's question for them.

You are also allowed to sweep off-cadence. Noticing mid-campaign that three
tickets failed the same way is the thing this seat is *for*; the cadence is a floor
for the times you don't, not a permission slip to wait.

### 2.4 Recover — the universal else

Recover is a tool, not a tollbooth. It buys two things you don't otherwise have:
full tools on the shared checkout, and a fresh reader who isn't invested in the
diagnosis you already formed. Reach for it when you need either. A fault you can
diagnose and prove fixed yourself needs neither — do it, journal it, move on.

Before you call it, ask whether you may: `loop recovery-budget --kind <kind>
[--ticket <id>]` returns the scoped key, what it has spent, and `exhausted`. **Two
prior resolutions of the same anomaly and you park instead of calling**, attaching
the `priorFixes` it hands back. An anomaly that returns after a successful repair
is a defect in this loop, not a fresh fault, and a third fresh-context agent would
only write a third confident success note. Don't derive the key yourself — whether
a kind budgets per ticket or per campaign is the verb's to know, and guessing loose
means the budget never trips at all.

Then read `references/recover.md`: it carries the anomaly table, the enforced
jurisdiction dance (`snapshot` → spawn → `revert` **before you read the verdict**),
and how to apply the actions it returns.

A live recover holds the mainline alone (invariant 3), and that one is not
negotiable even when you're impatient: the whole product-code guard is the
difference between two snapshots of that checkout, so anything else touching it
while recover runs makes the breach unattributable — the guard doesn't fail
loudly, it just stops meaning anything.

### Park — how the loop yields without stopping

**A park defers one decision; it never ends the campaign.** `loop backlog
set-status <id> parked --note "<reason>"` (or `loop backlog gate-park --reason`)
takes that ticket out of the frontier's hands and journals why. Keep driving
everything else.

Park directly, without recover, for the four decisions that are the human's by
construction: a **meaning-level** check amendment (what behavior counts as done —
recover is part of the loop, and a loop weakening its own checks is grading its
own homework), a crossed `outOfScope` tripwire, a second flake probe on the same
ticket, and a fault the locked spec genuinely doesn't answer. Everything else
earns a recover attempt first.

The campaign ends only when nothing autonomous remains — then **drain**: report
every parked decision with its recorded reason and what evidence would settle it,
leave `.ailoop/campaign/` exactly as it is, and stop. Never a rosy summary of a
loop that didn't finish, and never a stop over work it could still have done.

## Stage 3 — The campaign gate

When frontier reports `complete: true` and nothing is still settling, the slow
suite runs **once**, on the whole merged tree, holding the mainline alone
(invariant 3). Run each `gate` check, then `loop backlog gate-run green|red
--note "<which checks ran>"`.

A green run only covers the tree it measured, and `gate-run` stamps the ticket and
closed counts alongside the verdict for exactly that reason. If either count moves
afterwards — a coverage gap spawns tickets, a repair lands — the gate is stale and
must run again. **Read `gateGreen` off the frontier rather than remembering**; a
remembered green carried past new work is the easiest false report in the loop, and
the arithmetic that catches it is one field away.

Red is an escaped bug, and you never patch the tree yourself. Bisect first (run
the failing checks on base and on each branch alone — every branch is still
there), then **recover** (`campaign-gate-red` — that exact kind, since it is also
what grants the replacement authority below) with the evidence and the branches. It
decides which of two things this is: a real escaped defect (a repair ticket whose
checks *also* strengthen what let it through) or a mis-scoped gate (running the
wrong things, or contending on shared state — narrow or serialize it and re-run
green). Neither → `loop backlog gate-park --reason "…"`.

**Gate amendment authority.** Amend through `loop gate-amend --by <arm> --note
<why> --anomaly <kind>`, not the writer's `gate` command, because the rule is
enforced there and not in the writer. A name not in force only *adds* coverage, so
any anomaly may propose it. Reusing a live name *replaces* the command deciding
correctness, which can turn a real escaped bug into a green gate; no comparison of
two shell strings can prove that is a tightening. So a replacement is applied for
exactly one kind — `campaign-gate-red`, the recover that held the failure and could
re-run its correction green — and refused, journaled, for every other. The verb
reports which authority it used; you do not assert it.

The fast tier is `loop fastcheck-amend --by <arm> --note <why>`, on a different
rule: any arm may propose one, but the verb *runs* each candidate at the repo root
and admits only what exits 0. That is a measurement, and it is the verb's precisely
so that it is never your recollection of having checked.

## Stage 4 — Termination

Gate green, no gate park, nothing live → read `references/retrospective.md` and
follow it: the `coverage` role grades the requirement-to-proof matrix (anything
unproven becomes a ticket and the drive resumes), then the report, the `harvest`
role into `.ailoop/learnings/` via `loop learn`, `loop postmortem` **before**
anything is deleted, branches reaped, `.ailoop/campaign/` removed, the spec's
frontmatter flipped to `status: done`.

## Resume (`.ailoop/campaign/` exists)

Never re-run kickoff. Read the journal tail, run `loop frontier`, reconcile:

- **`inFlight` tickets** — all stale on resume; no worker survives the session.
  Don't guess. `loop worktree attach <id>` — a branch survives → re-provision it
  (`loop worktree add` already did that at dispatch, but the attach is a fresh
  checkout) and settle it like any result (2.2), telling the review the worker
  session was lost and the branch must be judged on evidence alone. Null →
  nothing durable happened; `set-status <id> open`. Either way invariant 1 is
  satisfied before you dispatch anything new.
- **`parked` tickets and gates** — a resume does not clear them. If the human
  answered a ticket park, record it (`set-status <id> open --note "<their
  answer>"`). A parked **gate** latch is released only by the amendment that
  answers it: `loop backlog gate - --note "<their answer>" --release-latch`.
  Adding a gate check without that flag deliberately leaves the latch on — an arm
  may widen coverage while the campaign is held, and that must not answer the
  human's question for them. If they didn't answer, drive everything else and
  drain again — re-parking is not an event, so the report stays honest without
  accumulating noise.
- **Spec changed since kickoff** — compare `sha256sum <spec>` against
  `backlog.json`'s `contract.sha256`. A mismatch is a genuine hard stop, not a
  park: every ticket is measured against a contract that no longer exists.
  Reconcile with the human before any dispatch.

## What this skill refuses to do

These are not edge cases to reason about. They are the places where improvising
produces a campaign that reports something untrue, which is the one failure this
loop cannot recover from — because nothing downstream disagrees.

- Start without a machine-checkable definition of done.
- Reimplement any mechanic `loop` owns, or route around a `REFUSED:`.
- Hand-edit `backlog.json`, `journal.jsonl`, or a worktree's branch.
- Fill a judgment role itself — review, sweep, coverage, recover are all spawned.
- Trust a worker's self-report, at any level, ever.
- Weaken a meaning-level check without the human — recover included, and a second
  "typo" on the same ticket is a meaning-level change wearing a smaller word.
- Report done over parked tickets, a stale or unrun gate, or a clause nobody
  claimed.
- **Stop while autonomous work remains.** One undecidable question parks; the
  loop keeps driving and drains only when nothing is left. And never stop merely
  because a fault has no name — that is the case you are here for.
- **Let recover edit product code.** `loop jurisdiction revert` undoes it and the
  intent goes through worker → verify → review like any other change.
- **Believe a third recovery of the same anomaly.** Two resolutions that didn't
  hold means the fault is in this loop; park with both fixes attached.
- Leave the campaign in a state that lies — see the invariants. Everything not on
  that list is yours to decide.
