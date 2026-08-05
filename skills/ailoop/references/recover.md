# Recover — the universal else

Every anomaly you can't resolve from the frontier's output routes here: one
full-tool agent, spawned fresh, that diagnoses the fault, fixes the campaign's
**definition** or the **environment**, proves the fix by running the check, and
hands you back lawful backlog mutations. It never touches product code — a
product defect becomes a repair *ticket* that a worker builds and the review
judges, so every change to the work stays verified.

Recover is why the loop no longer stops. Before it, the only reply to an
unenumerated fault was an escalation that ended the campaign; now the campaign
ends only when nothing autonomous is left.

The prompt is `loop prompt recover` — do not write your own. It carries the
authority-and-trust rules, the four root-cause classes, the safety envelope and
the action contracts. Your job is the four things around it: the anomaly key, the
budget, the jurisdiction dance, and applying what comes back.

## The anomaly kinds

| `kind` | Reached from |
|---|---|
| `frontier-problems` | `problems`/`cycles` you can't fix as bookkeeping |
| `attempt-wall` | `capped`/`stuck` — a ticket failing on its own merits |
| `worker-blocked` | a worker's `blocked` reply |
| `toobig-without-split` | a `tooBig` reply with no proposed children |
| `judge-escalate` | the review returned `escalate` |
| `campaign-gate-red` | the campaign gate red after clean landings |
| `dirty-mainline` | a land refused because the checkout has uncommitted work |
| `stalled` | nothing moving, nothing dispatchable |
| `decompose-refused` | the writer refused a decomposition twice |
| `script-refused` | a `REFUSED:` you can't interpret as your own bug |

Four things never reach recover, because they are the human's by construction:

- **A meaning-level check amendment** — what behavior counts as done. Park. A
  stuck loop weakening its own checks is the loop grading its own homework, and
  recover is part of the loop.
- **A crossed `outOfScope` tripwire** — never built past. Park.
- **A second flake probe on the same ticket.** One probe is evidence; asking for
  another is the judge stalling. Park.
- **A spec contradiction the locked spec genuinely can't answer.** Recover gets it
  *first* — most "contradictions" are an under-built dependency it can fix with a
  repair ticket — but a real gap in the contract parks.

## The budget — why a repeat is damning

The key is `<kind>:<ticketId>` when the anomaly names a ticket, bare `<kind>`
otherwise. **Two prior resolutions of the same key and you park instead of
calling**, quoting those prior fixes in the park reason.

Read the count off `backlog.json`'s `recoveries[<key>]` — `{count, summaries}`,
durable state, so it survives a resume and a compaction. Never from memory: a
gate-red → repair → gate-red cycle easily spans one.

Ask `loop recovery-budget --kind <kind> [--ticket <id>]` rather than deriving the
key: whether a kind budgets per ticket or per campaign is the verb's to know, and
the loose guess — one key for what should have been two — is the failure that never
announces itself, because a budget that never trips looks exactly like a budget
with room left.

Resolution is what makes a repeat damning. Recover said it fixed the campaign
definition and the same anomaly came back — that is exactly what a defect in this
loop looks like from the inside: a real problem papered over one journal note at a
time, each note reading like a success. A third fresh-context agent would write a
third confident success note. An *unresolved* recover parked instead, and nothing
re-arms a park.

A merit wall carries the same budget one level down: recover gets two distinct
attempts on a given ticket's wall, and the second call must say so in the anomaly
("a prior recovery already changed this ticket and it STILL walled — find a
DIFFERENT root cause"). Then the ticket parks.

## The guard — the boundary is enforced, not asked for

Recover has full tools on the shared checkout. Its "never product code" rule is in
the prompt, but the prompt is not what enforces it:

```
loop jurisdiction snapshot --out .ailoop/campaign/juris.json
# … spawn the recover agent, await it …
loop jurisdiction revert --in .ailoop/campaign/juris.json
```

Run the revert **before you read the verdict**, and whether or not it claims
success — an out-of-bounds edit is a fact about the tree, not a claim in the
reply. Nothing else may move that checkout while recover is live: no land, no
gate run, no worker dispatch, or the difference between the two snapshots stops
being attributable to recover alone.

`revert` prints `{paths, diff, reverted}`. On a non-empty `paths`:

- `reverted: true` **and** `fastChecks` exist → journal
  `--kind recover-out-of-bounds` and file a repair ticket carrying the reverted
  diff as *a hypothesis to verify against the spec, not a patch to re-apply*, with
  the fast tier as its acceptance. Recover isn't authoritative here and may have
  been wrong; a worker builds it and the review judges it.
- `reverted: false` → the unreviewed edit is standing on the mainline a gate will
  measure. **Park**, with the diff head in the reason. Only a human can decide
  whether to keep or unwind it.
- no `fastChecks` to hold a repair ticket to → park with the reverted diff.
  Inventing a green-by-construction check would be worse than the breach.

In bounds, and not a breach: untracked scratch files, manifests and lockfiles (an
install *is* a manifest edit), `.ailoop/` itself, and cleaning away dirt that was
already there when recover arrived.

## Applying what it returns

`{resolved: false, reason}` → park against the anomaly's target.

`{resolved: true, actions, evidence}` → apply the actions **in order**, each
through `loop backlog`. A refused action is journaled (`--kind recover-refused`)
and never silently dropped; keep applying the rest. `actions: []` with
`resolved: true` is legitimate — an environment-only fix.

Then record the resolution, which is what the budget counts:

```
loop backlog recover-resolution --key "<kind>[:<ticketId>]" \
  --subject "<kind>" --body "<evidence> — applied [<actions>]"
```

Three rules on the actions you accept:

- **You own ticket ids.** Renumber every ticket in an `add` against the current
  backlog before writing it, remapping internal `depends_on` edges — recover
  proposes ids blind to concurrent work.
- **Gate replacement authority is yours to grant, once.** A reused gate name
  replaces the command deciding correctness, so it is accepted only when this
  anomaly is `campaign-gate-red` — the one invocation that held the failure and
  could re-run the correction green. Every other anomaly may only *add* a gate
  check; the refusal is journaled. That same invocation is also the only one that
  may pass `--release-latch`: the authority to replace a gate command and the
  authority to answer a parked gate are the same fact about the caller. An arm
  that merely widens coverage leaves the latch where the human left it.
- **A `fast-checks` action needs no authority argument** — run each proposed
  command at the repo root and admit only what exits 0. Measurement, not
  permission.

## Promote a recurring kind

Every recover call is journaled, so the recover log is this seat's own escaped-bug
record. A `kind` that keeps coming back is a missing arm in SKILL.md, not a run of
bad luck — propose the edit to the human. Keep the anomaly vocabulary stable when
you do: it is the join key across every campaign's log, and a renamed kind silently
resets the history that would have shown the pattern.
