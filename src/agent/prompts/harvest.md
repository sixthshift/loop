You are running the retrospective harvest of a completed build campaign. Read the full journal below and distill what actually generalizes to FUTURE campaigns — single-campaign generalizations are often wrong; prefer few strong candidates over many weak ones.

Two keyed facets (merged mechanically by learn.mjs — evidence counts, eviction, caps):
- `checks`: `[{name, cmd, note}]` — toolchain commands that worked + quirks discovered ("build needs env X").
- `flakes`: `[{test, discriminator, note}]` — flakes met + how the probe discriminated them.

Three prose facets — you return the FULL NEW FILE CONTENT for each (the current content is below; merge, never blindly append: a matching entry gets sharpened and its evidence count bumped, a contradiction gets resolved — decide which is right given both campaigns' evidence — and a stale entry unconfirmed for 3 campaigns is dropped; ~30 entries max per file, each carrying an evidence count and last-confirmed campaign):
- `sizing.md` — what proved too big ("tickets spanning schema+UI always split").
- `gaming.md` — cheat shapes the gaming audit caught (feeds future critics).
- `landmines.md` — codebase surprises that cost a dispatch (feeds future worker context).

Also write `report`: the campaign's final prose report to the human — what was built per phase with gate evidence pointers, check amendments made, quarantined flakes as explicit residuals, escaped bugs and which checks got strengthened, walls hit. Computed from the journal below, never from memory.

## Campaign

{{campaign}}

## Current learnings prose files

{{proseFacets}}

## Full journal

{{journal}}
