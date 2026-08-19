---
status: draft            # draft | locked | done — ailoop runs only a locked spec; done = retired
spec_version: 1          # bumped by change orders after lock
---

# <Project> — Build Spec

<!-- One paragraph: what this is and why it's worth building. Vision, not
     mechanism — the sections below carry the mechanism.

     The HTML comments in this file are aispec's authoring notes, deleted when
     the spec locks: the locked text goes verbatim into kickoff, every decompose
     drafter, and the coverage pass, and must contain only the contract. -->

## Locked decisions

<!-- Over-specified ON PURPOSE: every choice a builder could stall on or
     re-litigate gets decided here — stack, data model, architecture, naming,
     error behavior, "do not add X" lists. aispec locks conventional defaults
     loudly and lists them for override; the human decides the genuine forks.
     Standing constraints inherited from previous drives are CITED from the
     repo's durable docs, never restated. ailoop seeds the backlog's locked
     decisions from this block; workers cite it.

     Two entries are written FOR decompose, which is read-only and gets no
     human. `Layout` — where each area of work lives (`src/<area>/` plus its
     test tree): decompose turns it into per-ticket module footprints, and
     the declared footprint is the whole of verify's scope boundary — the
     fence every diff is judged against; unstated, decompose invents the
     layout, and every mis-forecast is a burned scope-violation attempt.
     `Shared contracts` — the exact shape of any artifact two requirements
     both read (the schema, the DDL, the flag names): workers see only their
     own ticket's context, and drift between two tickets' readings passes
     every per-ticket verify to surface at the campaign gate, the most
     expensive detection point in the loop. -->

- Stack: ...
- Layout: ...
- Data model: ...
- Shared contracts: ...
- Do not add: ...

## Out of scope

<!-- The tripwire list — ailoop halts if a build crosses it. Harvested
     explicitly (humans never volunteer what NOT to build) and from rejected
     interpretations and "maybe later" answers during interrogation. Word each
     entry as an observable tripwire — the behavior whose appearance IS the
     violation — never a feature label: kickoff may condense but never infer,
     so it cannot conjure the observable behavior a label left out, and a
     fuzzy entry either never trips or halts a healthy build. -->

- ...

## Requirements

<!-- The flat list of every normative in-scope clause. NO PHASE HEADINGS — the
     loop drives one campaign-level gate and sequences work by dependency, so a
     `## Phase 2` heading is flattened away silently, taking your ordering with
     it. Ordering goes in Ordering constraints; checkpoints go in Milestones.
     Both cite these clauses rather than grouping them.

     Kickoff enumerates these as R1, R2, … exactly once; tickets then carry
     `satisfies: [R…]`, progress is counted against them, and the final coverage
     pass grades proof clause by clause. A clause omitted here is one nothing
     downstream is looking for.

     One ATOMIC clause per `###` — no "and" joining separately-verifiable
     behaviors — worded so whether it holds is decidable by inspection, and
     every requirement-grade clause lives in THIS section. The other sections
     keep their own normative forms — Locked decisions state choices, Out of
     scope holds exclusions, Ordering constraints the sequencing — but a
     BEHAVIOR clause stranded among them is enumerated at kickoff's discretion
     or not at all. Headings that map one-to-one onto clauses make the
     enumeration a transcription of your structure instead of an
     interpretation of your prose.

     Each clause carries its own executable acceptance. Prefer contrast
     checks ("given A → X; given B → must differ in THIS way") over existence
     checks — existence is the most gameable form. Write behavioral examples
     with LITERAL values — a real input, the exact expected output — never
     `<a valid X>` placeholders: decompose cannot execute anything, so these
     literals are the only fixtures its generated checks can be built from,
     and invented fixtures are where gameable checks come from. Anything
     knowingly unverifiable belongs under Known limits, NOT here: kickoff
     refuses to start on a normative requirement no command can settle. -->

### <short name of the requirement>

<the clause, stated so it is decidable by inspection>

**Acceptance:**
- `<command>` → <expected result>
- Behavioral: given <concrete input A> → <expected output>; given
  <contrasting input B> → output must differ: <how>

### <next requirement>

...

## Milestones

<!-- Observational only: a milestone gates nothing, orders nothing, and carries
     no checks. It names the moment a coherent slice of the product exists — and
     that moment is the ONLY thing that runs ailoop's sweep, its one
     cross-ticket reflective pass. Declare none and the campaign gets no
     mid-drive sweep at all: every systemic pattern waits for termination,
     which is after the work it would have redirected.

     Cite requirement headings, never restate or re-group them: kickoff
     translates each citation into the `R` id it enumerated, and a citation it
     cannot resolve is refused rather than guessed. A milestone is reached only
     when EVERY clause it names is delivered by closed tickets — including
     clauses no ticket claimed, which hold it back on purpose: a slice with an
     unclaimed clause is not a slice.

     Size them by coherence, not by count. The question the sweep asks at one is
     "do these pieces compose?", so a milestone worth declaring is one where
     that question has a real answer — a slice that a person could use, or that
     the next slice is built on. A milestone per requirement makes the sweep
     ask it of nothing; one milestone at the end makes it ask too late. Leave
     Leaving the section empty is a real choice with a real cost, not a
     default — make it deliberately. -->

- **M1 — <what exists once this lands, in product terms>**
  delivers: <requirement heading>, <requirement heading>
- **M2 — <the next coherent slice>**
  delivers: <requirement heading>

## Ordering constraints

<!-- The loop sequences work through per-ticket `depends_on` edges derived at
     decompose time, so ordering is conveyed by stating the constraint AGAINST
     the work — never by grouping requirements under a heading, and never by
     Milestones above: a milestone marks when work is DONE, it does not order
     what runs first, and two milestones can be in flight at once. Give each one a
     reason a decomposer can act on: a shared file, an inverted baseline, a
     schema both sides read. Keep them all here so none is buried in prose.
     A reason that names a shared artifact obliges Locked decisions to pin
     that artifact's shape — the constraint orders the work; the pinned shape
     is what keeps the two sides compatible while they are built apart. -->

- <requirement A> must land before <requirement B> — because <the concrete
  reason: they share this file / A inverts the baseline B asserts against / …>

## Checks

<!-- Candidate commands, for kickoff to probe and classify into tiers. Naming
     them is wanted; wiring them into tiers is kickoff's job, not yours.
     A repo with no checks yet makes the harness itself the first requirement,
     with an ordering constraint ahead of everything: fastChecks must be green
     at baseline, and an empty tier leaves every ticket proving itself on its
     own acceptance alone. -->

- **Fast-check candidates** (safe to repeat per ticket, seconds to ~1 min, and
  must be GREEN at baseline — a red baseline is a blocker): `<command>`
- **Gate candidates** (merged-tree integration/e2e; slow suites and anything
  needing shared mutable infrastructure belong here): `<command>`
- **Expected-red gates**, if any: `<command>` — red at kickoff because <the
  behavior this campaign builds that will turn it green>.

## Known limits

<!-- Non-normative, and explicitly so. Anything the human has knowingly made
     unprovable (a path needing credentials they won't supply, a third-party
     round trip) lives here rather than in Requirements, or kickoff refuses to
     start. If a check for it exists, write it and mark it skipped WITH its
     reason — never replace it with a weaker one that passes. These graduate into
     the repo's durable docs when the campaign closes. -->

- <the limit> — unverifiable because <why>; the consequence is <what ships
  unproven>.

## Environment & preconditions

<!-- What must exist for the checks to run: API keys/secrets, external
     services, runtimes, network access. Kickoff probes these — a missing one is
     a refuse-to-start, so surface them here, not mid-build.

     Two machine-facing lists live here too. Shared mutable state the checks
     touch — a dev DB they reset, a fixed port, a fixture directory — with its
     reset/cleanup expectation: tickets run one at a time, so nothing
     contends, but a check that leaves such state dirty fails the NEXT
     ticket, and the fault is filed against the wrong one. And any
     remote isolated test resource needs its FULL grant — host/boundary,
     credential reference name, allowed operations, ownership, cleanup — all
     five, or kickoff records a blocker and workers receive no grant at all.

     Also gating, though not spec content: kickoff runs
     `git status --porcelain --untracked-files=all` and treats ANY tracked
     modification as a blocker. The only tolerated untracked paths are exactly
     `.ailoop/learnings/{checks.json,flakes.json,sizing.md,gaming.md,landmines.md}`;
     any other untracked path blocks too. `.gitignore` must contain an exact
     `.ailoop/campaign/` line — that line only; campaign state shares the
     checkout with every worker, and the ignore line is what keeps the loop's
     dirty-tree measurements honest. Note here what the human still needs to
     commit. -->

- ...
- Shared mutable state the checks touch: ...
- Remote test resource grants (all five fields), if any: ...

## Open questions

<!-- aispec's working backlog — one entry per unresolved ambiguity, riskiest
     first. An answered question is DELETED and its answer lands in the
     section above where it belongs (contested forks carry a one-line why
     naming the rejected option; defaults stay bare). Two exits only: answered
     by the human, or the feature it belongs to is cut — never defaulted away,
     never parked in Out of scope. A question too big to answer decomposes
     into answerable sub-questions. Must be empty before status flips to
     locked. -->

- [ ] ...

## Change orders

<!-- Post-lock only. Never edit a locked section silently: append the change
     here (date · change · rationale), bump spec_version, then apply it above.
     ailoop's next resume detects the changed hash and stops to reconcile —
     this section is what that reconciliation reads, so say what changed and
     why. A change to what counts as done also goes through ailoop's
     meaning-level amendment tier if a drive is in flight. -->

## Braindump (raw)

<!-- First-session capture, written verbatim AS the human dumps — durability
     before structure. Structuring moves material into the sections above and
     deletes it from here; delete the whole section once it is empty. -->
