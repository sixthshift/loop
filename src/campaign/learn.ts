// The arithmetic half of the retrospective harvest. The coordinator decides
// WHAT generalizes into a durable learning (judgment); this merges those
// proposals into .ailoop/learnings/ with evidence counts, staleness eviction,
// and a size cap — one right answer, so it is never eyeballed. Touches only the
// two keyed-JSON facets (checks, flakes); the prose facets (sizing, gaming,
// landmines) can't be mechanically deduped and stay coordinator-authored.
//
// Runs at termination, before .ailoop/campaign/ is deleted; learnings/ is a
// sibling that survives. Native twin of the ailoop skill's learn.mjs.
//
// Keyed by `name` (checks) / `test` (flakes): present this campaign → bump
// evidence + reset staleness + refresh mutable fields; absent → staleness++.
// Evidence never decreases; retire flips status so intake's Prime skips it.
// Entries stale for `evict` campaigns drop; each facet caps at `cap` (lowest
// evidence first). A learning that still matters keeps getting re-confirmed.

import fs from 'node:fs';
import path from 'node:path';
import { LEARNINGS } from './state.ts';

type HarvestItem = { retire?: boolean } & Record<string, string | boolean | undefined>;
export type Harvest = { checks?: HarvestItem[]; flakes?: HarvestItem[] };
type Entry = Record<string, any>;
export type FacetCounts = { added: number; confirmed: number; retired: number; evicted: number; capped: number };

// $doc is rewritten each merge so the committed store stays self-describing.
const DOC: Record<string, string> = {
  checks: 'Verified toolchain commands carried across campaigns. Intake Primes toolchain detection + the baseline from active entries, then RE-PROBES them (a prior is a hypothesis, not a fact). Keyed by name.',
  flakes: "Known flaky tests + discriminators. Intake Primes verify's quarantine set from quarantined entries; status flips to resolved when a run proves the test stable. Keyed by test.",
};

export function mergeLearnings(opts: {
  harvest: Harvest;
  campaign: string;
  dir?: string;
  evict?: number;
  cap?: number;
  now?: string;
}): { campaign: string; dir: string; checks: FacetCounts; flakes: FacetCounts } {
  const dir = opts.dir ?? LEARNINGS;
  const evict = opts.evict ?? 3;
  const cap = opts.cap ?? 30;
  const now = opts.now ?? new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });

  const ctx = { dir, evict, cap, now, campaign: opts.campaign };
  return {
    campaign: opts.campaign, dir,
    checks: mergeFacet(ctx, opts.harvest.checks ?? [], 'checks', 'name', ['cmd', 'tier', 'note'], 'active', 'retired'),
    flakes: mergeFacet(ctx, opts.harvest.flakes ?? [], 'flakes', 'test', ['cmd', 'mode', 'discriminator'], 'quarantined', 'resolved'),
  };
}

type Ctx = { dir: string; evict: number; cap: number; now: string; campaign: string };

const load = (dir: string, name: string): Entry[] => {
  const p = path.join(dir, `${name}.json`);
  const o = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  return Array.isArray(o[name]) ? o[name] : [];
};

const save = (dir: string, name: string, entries: Entry[]): void =>
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ $doc: DOC[name], [name]: entries }, null, 2) + '\n');

function mergeFacet(
  ctx: Ctx, items: HarvestItem[], name: string, key: string, fields: string[],
  activeStatus: string, retiredStatus: string,
): FacetCounts {
  let entries = load(ctx.dir, name);
  const index = new Map(entries.map(e => [e[key], e]));
  const seen = new Set<string>();
  const counts: FacetCounts = { added: 0, confirmed: 0, retired: 0, evicted: 0, capped: 0 };

  for (const item of items) {
    const k = item[key];
    if (!k || typeof k !== 'string') { console.error(`skip ${name} entry missing "${key}": ${JSON.stringify(item)}`); continue; }
    seen.add(k);
    const status = item.retire ? retiredStatus : activeStatus;
    const e = index.get(k);
    if (e) {
      for (const f of fields) if (item[f] !== undefined) e[f] = item[f];
      e.evidence = (e.evidence ?? 1) + 1;
      e.stale = 0;
      e.status = status;
      e.last_confirmed = ctx.campaign;
      e.last_confirmed_at = ctx.now;
      if (item.retire) { e.retired_at = ctx.now; counts.retired++; } else counts.confirmed++;
    } else {
      const entry: Entry = { [key]: k };
      for (const f of fields) if (item[f] !== undefined) entry[f] = item[f];
      entry.evidence = 1;
      entry.stale = 0;
      entry.status = status;
      entry.first_seen = ctx.campaign;
      entry.last_confirmed = ctx.campaign;
      entry.last_confirmed_at = ctx.now;
      if (item.retire) entry.retired_at = ctx.now;
      entries.push(entry);
      counts.added++;
    }
  }

  // age entries not re-confirmed this campaign; evict once past the window
  for (const e of entries) if (!seen.has(e[key])) e.stale = (e.stale ?? 0) + 1;
  const kept = entries.filter(e => (e.stale ?? 0) < ctx.evict);
  counts.evicted = entries.length - kept.length;
  // cap: keep the highest-evidence entries (ties: freshest first)
  if (kept.length > ctx.cap) {
    kept.sort((a, b) => (b.evidence - a.evidence) || ((a.stale ?? 0) - (b.stale ?? 0)));
    counts.capped = kept.length - ctx.cap;
    entries = kept.slice(0, ctx.cap);
  } else entries = kept;

  save(ctx.dir, name, entries);
  return counts;
}
