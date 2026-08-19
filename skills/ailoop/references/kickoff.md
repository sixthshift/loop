# Kickoff — starting a campaign

Runs only when `.ailoop/campaign/` is absent. The refuse-to-start gate here is
the **only** permitted human interruption in a healthy run: spend it at step 2,
never mid-drive.

## 0. Preconditions

```
loop --version          # missing → say so and stop; there is no fallback path
git rev-parse --show-toplevel   # run from the repo root being built
```

Confirm both `claude` and `codex` are authenticated — the model chains assume
author≠judge across engines, and a missing engine silently collapses that
independence onto one family.

## 1. Read the spec

Locate the locked spec the human pointed at and read it fully. Record its hash
(`sha256sum <spec>`) — you will hand it to `init` as the campaign's contract, and
Resume checks it.

## 2. The kickoff role — the refuse-to-start gate

```
echo '{"spec":"<spec text>","specPath":"<path>","learnings":"<see below>"}' \
  | loop prompt kickoff --vars -
```

Run it against `loop models`' kickoff chain, with Bash and permissions bypassed —
it must actually *run* candidate check commands to trust them, not guess them
from the manifest. It returns `{blockers, fastChecks, gate, outOfScope,
requirements, milestones, caps, notes}` per `loop schema kickoff`.

**`blockers` non-empty → stop.** Report each item and what it needs, write
nothing, and leave no campaign residue. A spec whose "done" doesn't reduce to
exit codes is not buildable by this loop, and the cheapest possible moment to say
so is before any state exists.

For `learnings`, pass `.ailoop/learnings/checks.json` if present, prefixed with a
line saying these are priors to **re-probe, not facts** — a stale command that
still looks plausible is worse than no prior at all.

**Milestones.** The spec's checkpoints, and the campaign's only mid-drive sweep
trigger. Seed whatever kickoff returned without editing: the ids are what a sweep
spends, and the writer refuses a milestone citing a clause outside the
enumeration, so a mismatch surfaces here rather than as a checkpoint that never
arrives. An empty list means the spec declared none — the campaign then reflects
only at termination, so say so in the pre-flight report rather than letting the
human discover it from a silent journal.

**Spend policy.** `caps` is the spec's declared attempt budget, or `null` when it
declared none — seed it either way. It is what decides how many times a ticket may
fail on its own merits before the frontier walls it and the answer becomes the
human's, so a campaign running on defaults nobody chose will park for permission
it could have been granted in advance. `null` leaves the conservative defaults in
force, which is a fine outcome and a different one from a spec that thought about
it.

**Fast vs gate tier.** Fast = seconds-to-a-minute, runs on every ticket verify.
Gate = the slow suite (e2e, anything needing a live server), runs once on the
merged tree when every ticket has drained. A ticket that ships a new gate-tier
test still runs *that test* at its own verify — it is that ticket's acceptance.

## 3. Create the campaign

```
loop backlog init --project <slug> --coordinator skill \
  --spec-path <path> --spec-sha <sha>
loop backlog seed - <<< '{"fastChecks":[…],"gate":[…],"outOfScope":[…],"requirements":[…],"milestones":[…],"caps":…}'
```

`--coordinator skill` is the default and the only reachable seat; pass it
explicitly anyway, so the stamp in `backlog.json` is a statement rather than a
default nobody chose.

Add `.ailoop/campaign/` to `.gitignore` (learnings/ stays tracked). Campaign
state shares the checkout with every worker; ignoring it is what keeps verify's
dirty-tree refusal and `branch discard`'s clean honest about whose files are
whose.

Journal the enumeration and the contract so both outlive the screen:

```
loop backlog note --kind requirements --subject spec --body "R1: …
R2: …" --data '{"requirements":[…]}'
loop backlog note --kind kickoff --subject spec --body "sha256=<sha> coordinator=skill"
```

If `.ailoop/learnings/flakes.json` exists, journal it too
(`--kind known-flakes`) so a verify red against a known flake goes straight to
the probe.

### Why the enumeration is load-bearing

Closed tickets measure the backlog against itself. Requirements measure it
against the **spec** — the only way to notice work nobody wrote a ticket for
while there is still time to write one. The frontier joins the two on every pass,
so "3 clauses nobody claimed" surfaces mid-campaign instead of at termination,
after the whole tree was built around the absence. The two counts answer
different questions and can disagree: a campaign can be 8/8 tickets closed with a
clause no ticket ever claimed.

It is made once, before any code exists, so a clause missed here is invisible to
every count downstream. Two things hedge that: the pre-flight report puts the full
list in front of the human at the one moment they are present, and the terminal
coverage pass re-reads the spec against the list and reports what the enumeration
itself missed.

## 4. Decompose

```
echo '{"spec":…,"requirements":[…],"config":{…},"learnings":…,"feedback":""}' \
  | loop prompt decompose --vars -
```

Run it on the decompose chain (a consensus group — its members draft in parallel
and one reconciles), then feed the result straight to the writer:

```
loop backlog add - <<< '<the tickets array>'
```

If the writer refuses, re-run decompose with its exact refusal text as
`feedback`. Two refusals and it is **recover** (`decompose-refused`) — a third
identical ask will not produce a different answer.

### 4.1 The critic pass — before `add`, not after

Decompose authors the acceptance checks, and nothing downstream reads them until
a judge does, after a worker has already built against them. Run the `critic`
role on the drafts first:

```
echo '{"tickets":[…],"requirements":[…],"outOfScope":[…],"learnings":…}' \
  | loop prompt critic --vars -
```

It asks exactly one question — *what contract-violating implementation would
these exact checks accept?* — and returns `{findings, summary}`. Apply each
finding before `add`:

- `patch` → merge it into that draft's `acceptanceChecks` (the complete array it
  returned, never a partial one) and add the ticket as amended.
- `acceptedRisk` → add the ticket unchanged and journal the risk
  (`--kind accepted-risk`, with its severity). It is carried to the review that
  judges that ticket, which is the whole point of recording it rather than
  arguing with it now.

Run it on the drafts, not on the seeded backlog: a patch applied before `add`
costs nothing, and the same correction after dispatch costs a build, a verify, a
review and a merit attempt. Its chain leads Claude while decompose leads Codex,
and that is deliberate — the check-author must not grade its own blind spots.

Findings of `[]` is a normal, common result and needs no second ask. This pass
also runs over any later batch of tickets an arm proposes — a coverage gap, a
repair ticket, a `tooBig` split — for the same reason: those checks are authored
by an agent that cannot run them either.

Pass `.ailoop/learnings/sizing.md` as `learnings` when present: what proved too
big before should be split preemptively, because `tooBig` replies are healthy but
not free.

Tickets declare **modules** — the directories they live in — not a file list. You
can predict "this ticket lives in `src/auth/`" from the spec; you cannot predict
the file the implementation turns out to need, and a file list charges the ticket
for that forecast error. `satisfies` claims only what the ticket's own acceptance
actually proves; leave a clause unclaimed rather than parking it on the nearest
ticket, because an over-claim reads as coverage and nothing downstream will
disagree. Shared mutable state a ticket's checks touch (a dev DB they reset, a
queue) needs no scheduling declaration — tickets run one at a time — but the
cleanup obligation stays: a check that leaves shared state dirty fails the
*next* ticket, and the fault will be filed against the wrong one.

There is no pre-dispatch *state*: a ticket is `open` and becomes dispatchable
when its deps close — nothing gates it on having been vetted. The two reads that
happen before a worker sees it are both measurements against the checks rather
than approvals of the plan: the critic pass above, once, over the drafts, and
`loop vet` at dispatch. Judging the built diff remains the review's alone.

## 5. Pre-flight report

One message to the human: ticket count, the campaign gate's checks, the
requirement enumeration **printed in full with the ticket claiming each clause**,
the milestones with the clauses each delivers (or that the spec declared none, so
there will be no mid-drive sweep at all), `coverage.unmapped` from the first
`loop frontier` read, and anything about the spec that surprised you. Journal the same summary (`--kind preflight`) — this is
the last point before the loop runs unattended, and the screen does not survive.

Then start the drive **in the same turn as this report** — the report is not a
stopping point and not an approval gate. A sentence describing what you are about
to dispatch is not a dispatch: a coordinator that ends its turn here leaves a
fully initialised campaign with zero workers running, and that state reads
healthy from every angle — `open:N in-flight:0`, no red check, no refused verb —
until a human notices nothing has happened, which is exactly the supervision the
loop exists to remove. The frontier reports it as `idle: true`. The only
legitimate stop before the first dispatch is a genuine kickoff blocker, and step
2 already handled those.
