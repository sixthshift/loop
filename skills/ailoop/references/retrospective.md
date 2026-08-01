# Termination & retrospective

Runs only when `loop frontier` reports `complete: true`, `backlog.json`'s
`gateState.parked` is absent, and `gateState.lastRun` is green *against the
current counts* — a green run only covers the tree it measured, so a `tickets` or
`closed` figure that has moved since means work landed the gate never saw. Read
that off the file, never off your memory of running it.

## 1. Coverage pass

The arithmetic is already done: `loop frontier`'s `coverage` says which
requirement ids the claiming tickets closed (`proven`) and which nobody claimed
(`unmapped`). Don't re-count it. Run the `coverage` role and hand it the counts
alongside the spec, so it spends its whole read on the two questions counting
can't answer:

1. **Did each requirement's checks observe the boundary its clause names?** A
   `proven` clause only means the claiming tickets' own checks went green where
   they looked. A check reading through an admin connection didn't prove the
   grant; one reading the app's echo didn't prove persistence. Walk each clause
   against the acceptance checks that closed it and the gate evidence.
2. **What did the enumeration itself miss?** Re-read the spec against
   `requirements`. A normative clause that never became an id is an *enumeration
   gap* — the one failure mode the join is structurally blind to, because
   `unmapped` can only count ids that exist.

```
echo '{"spec":…,"requirements":{"list":[…],"requirements":N,"unmapped":[…],"proven":[…]},
       "tickets":[{id,title,satisfies,acceptance,evidence}…],"outOfScope":[…],
       "gateEvidence":"…"}' | loop prompt coverage --vars -
```

`{done: false, missing: [...]}` → renumber those tickets against the current
backlog, `loop backlog add -`, journal `--kind coverage-gap`, and **the drive
resumes**. The gate it re-opens must go green again. Both findings are harvest
candidates: the decomposition missed it once and could again.

## 2. Harvest → learnings

Run the `harvest` role over the whole journal (`journal.jsonl`) plus the current
prose facets. It returns `{checks, flakes, sizingMd, gamingMd, landminesMd,
report}`.

The two keyed facets merge mechanically — never by hand:

```
echo '{"checks":[…],"flakes":[…]}' | loop learn --campaign <project>
```

It upserts by key (`name` for checks, `test` for flakes), bumps evidence on a
match, ages every entry not re-confirmed this campaign, evicts entries stale for
3 campaigns, and caps each facet at ~30 (lowest evidence first). `retire: true`
on a candidate flips its status so the next kickoff's priming skips it.

The three prose facets can't be mechanically deduped, so the harvest role returns
each as fully **merged** text — write `sizingMd`, `gamingMd`, `landminesMd`
straight to `.ailoop/learnings/`. Merged, not appended: a matching entry gets
sharpened and its re-confirmation noted, a contradiction gets resolved now (which
is right, given both campaigns' evidence?), never both kept.

Single-campaign generalizations are often wrong. That is what the evidence count
is for — one campaign's lesson enters as a hypothesis and earns rule status by
surviving. An entry confirmed across many campaigns is no longer a learning but
policy: propose the SKILL.md edit to the human instead of re-injecting it
forever.

`.ailoop/learnings/` carries across campaigns verbatim, which is the only reason a
later one can compare against an earlier one — never fork its shape.

## 3. The post-mortem, before anything is deleted

```
loop postmortem --out <spec-path-without-.md>.postmortem.html
```

It embeds the raw journal, so the timeline, per-ticket costs and every journaled
event survive the campaign directory's deletion. **If this fails, stop and report
— do not delete `.ailoop/campaign/` without the archive.** There is no second
chance.

Its cost figures come from the `--data` telemetry you journaled at each close;
tickets closed without it show duration only.

## 4. Final report

To the human, computed from the journal and evidence files — never narrated from
memory: what was built, requirement coverage clause by clause, gate evidence
pointers, check amendments (typo-level self-served; meaning-level parked and how
they were answered), gate replacements with the command each displaced, escaped
bugs and which checks got strengthened, every park and how it resolved, and the
recover log — each anomaly kind, how often it fired, and any kind that fired
often enough to deserve a real arm in SKILL.md.

The harvest role's `report` field is the draft; you own its accuracy.

## 5. Close the campaign

Journal the close (`--kind campaign-close`), flip the spec's frontmatter to
`status: done` (aispec treats `done` specs as retired records — this flip is what
tells it the contract is spent), reap the closed tickets' branches
(`loop worktree delete-branch <id>` — they survived this long for gate
bisection), then delete `.ailoop/campaign/`. Learnings remain, tracked; the
journal survives inside the post-mortem HTML.

The campaign is over when — and only when — the human has the report and the
post-mortem, the spec reads `done`, and the campaign directory is gone.
