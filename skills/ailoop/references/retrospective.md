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

## 3. The report and the post-mortem — one artifact

The human gets a single page: the post-mortem HTML, opening with your report
and carrying, below it, the measurements the report cites. Getting there is
four steps, in this order, because the report's numbers come from a page that
must in turn embed the report:

**1. Render, to read.**

```
loop postmortem --out <spec-path-without-.md>.postmortem.html
```

Its cost figures come from the `--data` telemetry you journaled at each settle
— attempts included, since a retried ticket paid for every attempt; settles
without it show duration only. The **where-the-time-went** section
additionally reads whatever worker/judge transcripts your harness still
retains under `~/.claude/projects/`, joined by the journaled agent ids
(falling back to the `Build/Review <id>` dispatch labels), to split each
ticket into model inference vs test suites vs checks. Render before any
transcript cleanup; where transcripts are gone — codex workers never leave
any — the section says so and degrades to journal phase walls rather than
guessing.

Check the coverage line it prints. `none` on a campaign whose workers were
claude agents means the join failed, not that the work was cheap — usually
because the render is happening outside the container the campaign ran in, so
the transcripts are in that container's tree rather than this host's. Copy that
tree out and point at it:

```
docker run --rm -v <project>_devcontainer_claude-config:/cc -v <dest>:/out \
  alpine cp -r /cc/projects/-workspace/. /out/
loop postmortem --out <path>.html --transcripts <dest>
```

Two buckets never depend on that join and are always present: **blocked**
(park wall, carved out of whatever phase was stamped when the park landed) and
**stall** (`build` wall minus the `workerSeconds` you journaled — the loop's own
dead time, waiting to spawn or slow to notice a finished worker). Both are
derived from the journal alone, so they survive a campaign whose transcripts
were never written. `stall` is only claimed where every settled attempt
reported its seconds; journal the settle telemetry faithfully or the section
goes quiet about the loop's own latency.

**2. Compose the report**, in markdown, computed from the journal, the
evidence files, and the page you just rendered — never narrated from memory:
what was built, requirement coverage clause by clause, gate evidence pointers,
check amendments (typo-level self-served; meaning-level parked and how they
were answered), gate replacements with the command each displaced, escaped
bugs and which checks got strengthened, every park and how it resolved, and
the recover log — each anomaly kind, how often it fired, and any kind that
fired often enough to deserve a real arm in SKILL.md.

**Where the time went** is a standard section, read off the rendered page's
numbers, never re-derived by eye: the dispatch shape (achieved parallelism, the
idle between tickets, and the wall held on a park), the average cycle and its
split, the dominant cost bucket, and — as recommendations — only the levers
this campaign's data actually supports. The recurring candidates, each
checkable against the section: **park latency** when `blocked` is the dominant
bucket or `held` covers much of the span; **coordinator latency** when `stall`
is more than dispatch noise on any ticket; parallelism headroom when the run
was serial and inference-bound; scoped checks during iteration when flat
full-tier suites were re-run per touch; retry spend when attempts multiplied
whole cycles; a checked-in runner script when generated bash rivals the code
volume. Name the numbers behind whichever you claim.

Read `held` against `idle`, never `idle` alone. Parallelism hides a park —
other tickets keep landing, so `idle` stays near zero — right up until the
backlog drains behind the parked one and the campaign stops. A run reporting
minutes of idle and hours of held was blocked on its human for most of its
life, and the lever is the park pipeline, not the judge or the suites.

The harvest role's `report` field is the draft; you own its accuracy.

**3. Journal it** — the report is a campaign event, and journaling it is what
puts it inside the archive:

```
echo '{"body": "<the markdown>"}' | loop backlog note --kind campaign-report --subject campaign -
```

The stdin payload, not `--body`: report-sized markdown routed through a shell
argument gets mangled by the shell's own vocabulary. To correct a report,
journal a new one — the page renders the last.

**4. Render again, to the same path.** This render is the artifact: it opens
with the report and embeds the raw journal (report included), so the timeline,
per-ticket costs and every journaled event survive the campaign directory's
deletion. **If it fails, stop and report — do not delete `.ailoop/campaign/`
without the archive.** There is no second chance. Hand the human the file
path, with the parked decisions (if any) restated in the terminal.

## 4. Close the campaign

Journal the close (`--kind campaign-close`), flip the spec's frontmatter to
`status: done` (aispec treats `done` specs as retired records — this flip is what
tells it the contract is spent), reap the closed tickets' branches
(`loop branch delete <id>` — they survived this long for gate
bisection), then delete `.ailoop/campaign/`. Learnings remain, tracked; the
journal survives inside the post-mortem HTML.

The campaign is over when — and only when — the human has the post-mortem with
the report inside it, the spec reads `done`, and the campaign directory is
gone.
