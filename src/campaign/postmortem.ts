// Render the campaign's journal as a self-contained HTML post-mortem: stat
// tiles, a Gantt timeline (one lane per ticket, dependency arrows, verify
// overlays, gate markers), a where-the-time-went section, per-ticket cost
// bars, and a table. Zero model cost; facts come from journal.jsonl +
// backlog.json, plus — for the time section's inference-vs-suites split —
// whatever worker/judge subagent transcripts are still discoverable under
// ~/.claude/projects — or under the tree `--transcripts` names, which is how a
// campaign that ran in a devcontainer is read from the host afterwards (they
// may not be discoverable at all: codex workers leave none, and old campaigns
// predate the id capture; the section states its coverage rather than letting
// missing detail read as fast work). The raw journal is
// embedded in the page (<script id="journal">), so the HTML is also the
// campaign's durable event archive — deleting campaign/ loses nothing.
//
// Run at retrospective, BEFORE .ailoop/campaign/ is deleted. Reachable as
// `loop postmortem` (mechanics.ts); campaigns are compared through the archives
// they leave behind.
//
// KNOWN LIMIT, and it grew when the coordinator became a model in a conversation:
// worker cost is only as complete as what a `close` was handed. This program used
// to run the agents itself and read each stream's token count directly, so every
// closed ticket had one. Now the coordinator spawns its own subagents and passes
// along whatever its harness told it — which may be nothing.
//
// So the page distinguishes three states rather than two, because "no cost bar"
// and "a cost bar covering half the tickets" are very different claims and only
// one of them is safe to read as a total: every ticket priced, some priced (the
// total is labelled partial and says how many), none priced (the section says the
// coordinator reported no telemetry, instead of rendering empty bars that look
// like free work). Coordinator-session overhead is invisible from inside the run
// and excluded in all three.

import fs from 'node:fs';
import path from 'node:path';
import { backlog } from './backlog.ts';
import { journalEntries } from './journal.ts';
import { campaignShape, parkWindows, ticketBreakdowns } from './time-breakdown.ts';
import type { TicketBreakdown } from './time-breakdown.ts';
import { analyzeTranscript, discoverAgents } from './transcripts.ts';
import type { TranscriptAnalysis } from './transcripts.ts';

// $/MTok output rate, checked 2026-07 — refresh when models rotate
const OUTPUT_PRICE: Record<string, number> = { opus: 25, sonnet: 15, haiku: 5 };
// Cost estimate is claude-only: codex reports no cost and has no price here, so
// it estimates to 0. A claude- prefix is stripped; a bare name is claude.
const priceFor = (model: string): number =>
  model.startsWith('codex-') ? 0 : (OUTPUT_PRICE[model.replace(/^claude-/, '')] ?? OUTPUT_PRICE.opus!);

// ---- the campaign report ----------------------------------------------------
// The coordinator journals its final report (kind `campaign-report`, markdown
// body) and this page renders the last one as its opening section — the
// report and the post-mortem are ONE artifact, so a claim in the prose sits on
// the same page as the chart that backs it, and the report survives inside
// the embedded raw journal like every other event.
//
// The renderer is a deliberate subset (headings, lists, tables, bold/italic,
// inline and fenced code, links): enough for a report, small enough to audit.
// Everything is HTML-escaped before any markup is introduced — the body is
// model prose being written into a durable archive.

export function mdToHtml(md: string): string {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Code spans are lifted out before the other passes and restored after:
  // their content is literal in markdown, so `a**b**c` must keep its
  // asterisks rather than gain a <strong> inside the <code>.
  const inline = (s: string) => {
    const codes: string[] = [];
    // NUL is the placeholder sentinel, stripped from the input first so the
    // restore pass can only ever match what the lift pass planted.
    return escapeHtml(s).replace(/\u0000/g, '')
      .replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+|#[^)\s]+|[^)\s:]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[+i]}</code>`);
  };

  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      const buf: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) buf.push(lines[i]!);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    if (h) {
      // The page owns h1 (title) and h2 (card headings); report headings nest below.
      const level = Math.min(h[1]!.length + 2, 6);
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && /^\s*[-*]\s+/.test(lines[i]!); i++)
        items.push(`<li>${inline(lines[i]!.replace(/^\s*[-*]\s+/, ''))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!); i++)
        rows.push(lines[i]!.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
      const headed = rows.length > 1 && rows[1]!.every(c => /^:?-+:?$/.test(c));
      const head = headed ? `<thead><tr>${rows[0]!.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : '';
      const body = (headed ? rows.slice(2) : rows)
        .map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table>${head}<tbody>${body}</tbody></table>`);
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const buf: string[] = [];
    for (; i < lines.length && lines[i]!.trim() !== ''
      && !/^(#{1,4}\s|```|\s*[-*]\s|\s*\|.*\|\s*$)/.test(lines[i]!); i++) buf.push(lines[i]!);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ---- where the time went ----------------------------------------------------
// The join the section renders: journal phase walls per attempt, refined by
// worker/judge transcripts where they can still be found. Everything is
// reduced to per-ticket minute segments HERE so the page script stays a dumb
// renderer — which segments exist, and what absorbs the unattributable rest,
// is report policy, not display code.

// Stack orders are the CVD-validated hue orders from the palette, not a
// preference — reordering them re-opens the adjacency validation.
// `stall` and `blocked` are appended at the tail rather than slotted among the
// work segments: they are non-work, and the hue run above them stays exactly as
// validated. Neither borrows a work hue — blocked takes the fail red, stall a
// dark neutral — so the two ways a campaign loses wall clock read as losses.
const SPLIT_SEGS = ['impl', 'unit', 'itest', 'e2e', 'types', 'verify', 'review', 'stall', 'blocked', 'other'] as const;
const PHASE_SEGS = ['worker', 'verify', 'review', 'land', 'stall', 'blocked'] as const;

type Seg = { k: string; min: number };
type TimeTicket = {
  id: string;
  attempts: number; // merit + infra failures; the ×N annotation on the bar
  split: boolean;   // true = transcript-refined segments; false = journal phase walls
  totalMin: number;
  segs: Seg[];
  ktok: number | null;
  thinkPct: number | null;
  workerWallMin: number | null;
};
type TimeData = {
  shape: { maxInFlight: number; idleMin: number; heldMin: number; unreleasedParks: number };
  coverage: 'full' | 'partial' | 'none';
  analyzed: number;
  closed: number;
  rate: number | null; // median sustained output tok/s across analyzed workers
  share: Seg[];
  scatter: Array<{ id: string; wallMin: number; ktok: number }>;
  tiers: Array<{ k: string; medianS: number; runs: number }>;
  tickets: TimeTicket[];
  telemetryGaps: number; // settled attempts that journaled no workerTokens
};

const minutes = (msv: number): number => Math.round(msv / 6000) / 10;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, z) => a - z);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

function deriveTime(journal: ReturnType<typeof journalEntries>, transcriptsRoot?: string): TimeData {
  const breakdowns = ticketBreakdowns(journal);
  const parks = parkWindows(journal);
  const shape = campaignShape(breakdowns, parks);

  const windows = breakdowns.map(t => ({
    ticket: t.id,
    startMs: new Date(t.spans[0]!.start).getTime(),
    endMs: new Date(t.spans.at(-1)!.end).getTime(),
    agentIds: {
      worker: t.spans.map(s => s.telemetry?.agent).filter((x): x is string => !!x),
      judge: t.spans.map(s => s.telemetry?.judgeAgent).filter((x): x is string => !!x),
    },
  }));
  const analyses = new Map<string, TranscriptAnalysis[]>();
  for (const d of discoverAgents(windows, transcriptsRoot)) {
    const a = analyzeTranscript(d.file);
    if (!a) continue;
    const key = `${d.ticket}:${d.role}`;
    analyses.set(key, [...(analyses.get(key) ?? []), a]);
  }

  const rates: number[] = [];
  const tierRuns = new Map<string, number[]>();
  for (const e of journal) {
    const d = (e.data as any)?.durationMs;
    if (e.kind === 'verify' && typeof d === 'number')
      tierRuns.set('verify', [...(tierRuns.get('verify') ?? []), d]);
  }

  let telemetryGaps = 0;
  const tickets: TimeTicket[] = breakdowns.map((t: TicketBreakdown) => {
    const walls = { build: 0, verify: 0, review: 0, land: 0, blocked: 0 };
    let spanWallMs = 0, verifyScriptMs = 0;
    for (const s of t.spans) {
      for (const k of ['build', 'verify', 'review', 'land', 'blocked'] as const) walls[k] += s.walls[k];
      spanWallMs += new Date(s.end).getTime() - new Date(s.start).getTime();
      verifyScriptMs += s.verifyScriptMs;
      if ((s.outcome === 'close' || s.outcome === 'attempt') && s.telemetry?.workerTokens === undefined) telemetryGaps++;
    }
    const attempts = t.spans.filter(s => s.outcome === 'attempt').length;

    // Coordinator latency, from the journal alone: the coordinator held the
    // ticket in `build` for walls.build, and its own settle telemetry says the
    // worker was only alive for workerSeconds. The difference is the loop's own
    // dead time — slow to spawn on one side, slow to notice a finished worker
    // on the other. Claimed only when EVERY settled attempt reported its
    // seconds; one missing figure would read as a stall the size of an attempt,
    // which is the mistake this bucket exists to stop the report from making.
    // null is "the journal cannot say", which is NOT the same claim as zero —
    // conflating them let a ticket with complete telemetry and no stall fall
    // through to the transcript estimate and report one anyway.
    const settledSpans = t.spans.filter(s => s.outcome === 'close' || s.outcome === 'attempt');
    const secs = settledSpans.map(s => s.telemetry?.workerSeconds);
    const stall: number | null = secs.length && secs.every((v): v is number => typeof v === 'number')
      ? Math.max(0, walls.build - secs.reduce((a, b) => a + b, 0) * 1000)
      : null;

    const workers = analyses.get(`${t.id}:worker`) ?? [];
    const judges = analyses.get(`${t.id}:judge`) ?? [];
    if (!workers.length) {
      const phase = {
        worker: walls.build - (stall ?? 0), verify: walls.verify, review: walls.review,
        land: walls.land, stall: stall ?? 0, blocked: walls.blocked,
      };
      const segs = PHASE_SEGS.map(k => ({ k, min: minutes(phase[k]) })).filter(s => s.min > 0);
      return {
        id: t.id, attempts, split: false, totalMin: minutes(spanWallMs), segs,
        ktok: null, thinkPct: null, workerWallMin: null,
      };
    }

    const sum = (f: (a: TranscriptAnalysis) => number) => workers.reduce((s, a) => s + f(a), 0);
    const modelMs = sum(a => a.modelMs);
    const tokens = sum(a => a.outputTokens);
    const thinkEst = sum(a => a.thinkingTokensEst);
    for (const a of workers) {
      if (a.modelMs > 0 && a.outputTokens > 0) rates.push(a.outputTokens / (a.modelMs / 1000));
      for (const r of a.toolRuns) tierRuns.set(r.cls, [...(tierRuns.get(r.cls) ?? []), r.ms]);
    }
    const judgeMs = judges.reduce((s, a) => s + a.wallMs, 0) || walls.review;
    // Journaled seconds are the better witness where they exist — they are what
    // the harness clocked, not what a transcript's first and last line imply —
    // so the transcript wall is the fallback, not the primary.
    const stallMs = stall ?? Math.max(0, walls.build - sum(a => a.wallMs));
    const named: Record<(typeof SPLIT_SEGS)[number], number> = {
      impl: modelMs,
      unit: sum(a => a.toolMs.unit),
      itest: sum(a => a.toolMs.integration),
      e2e: sum(a => a.toolMs.e2e),
      types: sum(a => a.toolMs.typecheck),
      verify: verifyScriptMs || walls.verify,
      review: judgeMs,
      stall: stallMs,
      blocked: walls.blocked,
      other: 0,
    };
    // The remainder — coordinator bookkeeping, unclassified bash, db ops, the
    // land — is shown as one gray segment and disclosed, never attributed.
    named.other = Math.max(0, spanWallMs - Object.values(named).reduce((s, v) => s + v, 0));
    return {
      id: t.id, attempts, split: true, totalMin: minutes(spanWallMs),
      segs: SPLIT_SEGS.map(k => ({ k, min: minutes(named[k]) })).filter(s => s.min > 0),
      ktok: Math.round(tokens / 1000),
      thinkPct: tokens ? Math.round((thinkEst / tokens) * 100) : null,
      workerWallMin: minutes(sum(a => a.wallMs)),
    };
  });

  const closedTickets = breakdowns.filter(t => t.spans.some(s => s.outcome === 'close'));
  const analyzed = closedTickets.filter(t => analyses.has(`${t.id}:worker`)).length;
  const coverage = analyzed === 0 ? 'none' : analyzed === closedTickets.length ? 'full' : 'partial';

  // The share sums every key any ticket emitted: under partial coverage the
  // unsplit tickets' worker/land walls sit beside the split tickets' buckets,
  // because dropping either side would skew the campaign split toward the
  // other while still presenting itself as campaign-wide.
  const SHARE_ORDER = ['impl', 'unit', 'itest', 'e2e', 'types', 'verify', 'review', 'worker', 'land', 'stall', 'blocked', 'other'];
  const share = SHARE_ORDER
    .map(k => ({ k, min: Math.round(tickets.reduce((s, t) => s + (t.segs.find(x => x.k === k)?.min ?? 0), 0)) }))
    .filter(s => s.min > 0);

  return {
    shape: {
      maxInFlight: shape.maxInFlight, idleMin: minutes(shape.idleMs),
      heldMin: minutes(shape.heldMs), unreleasedParks: parks.filter(p => !p.released).length,
    },
    coverage, analyzed, closed: closedTickets.length,
    rate: median(rates) === null ? null : Math.round(median(rates)!),
    share,
    scatter: tickets.filter(t => t.split && t.ktok !== null && t.workerWallMin !== null)
      .map(t => ({ id: t.id, wallMin: t.workerWallMin!, ktok: t.ktok! })),
    tiers: [...tierRuns.entries()]
      .map(([k, runs]) => ({ k, medianS: Math.round(median(runs)! / 1000), runs: runs.length }))
      .filter(t => t.runs >= 2 && t.medianS > 0)
      .sort((a, z) => a.medianS - z.medianS),
    tickets,
    telemetryGaps,
  };
}

export function writePostmortem(out: string, transcriptsRoot?: string): { tickets: number; events: number } {
  const b = backlog();
  const journal = journalEntries();
  if (!journal.length) throw new Error('no journal events to render');

  const t0 = new Date(journal[0]!.ts).getTime();
  const t1 = new Date(journal.at(-1)!.ts).getTime();
  const x = (ts: string) => (new Date(ts).getTime() - t0) / (t1 - t0);

  // ---- per-ticket lifecycle: the same fold the time section uses ----
  // One fold (ticketBreakdowns) serves the Gantt and the time section alike.
  // The page used to keep its own inline fold here, and the two drifted: the
  // inline one never settled a span on decompose and double-opened on the
  // amend-typo re-stamp, so the Gantt could draw a ticket in flight for hours
  // on the same page whose time section showed it settled in minutes.
  const breakdowns = ticketBreakdowns(journal);
  const verifiesByTicket = new Map<string, any[]>();
  for (const e of journal) {
    if (e.kind === 'verify' && /^T\d+$/.test(e.subject || ''))
      verifiesByTicket.set(e.subject!, [...(verifiesByTicket.get(e.subject!) ?? []), { ts: e.ts, ...(e.data as any) }]);
  }
  // gate markers: any journaled gate event (campaign-gate-close, gate-red, gate-amendment)
  const gates = journal.filter(e => /gate/.test(e.kind)).map(e => ({ ts: e.ts, body: `${e.subject}: ${e.body}` }));

  const rows = breakdowns.map(t => ({
    id: t.id,
    spans: t.spans,
    verifies: verifiesByTicket.get(t.id) ?? [],
    attempts: t.spans.filter(s => s.outcome === 'attempt').length,
    closedAt: t.spans.find(s => s.outcome === 'close')?.end ?? null,
    meta: b.tickets.find(bt => bt.id === t.id) || ({} as any),
  }));

  // The model that actually ran — recorded in worker telemetry at settle
  // (chain fallback and all), never a declared tag; tickets carry no model.
  const runModel = (t: (typeof rows)[number]): string =>
    t.spans.map(s => s.telemetry?.model).filter(Boolean).at(-1) ?? '';

  // Summed across attempts: retries were paid for too, and the close span's
  // telemetry IS the close data, so the sum degrades to exactly the old
  // close-only figure on campaigns that journaled telemetry only at close.
  // Tokens and seconds sum over the same spans so the pair stays one scope —
  // throughput derived from the archive must not mix all-attempt tokens with
  // final-attempt seconds.
  const totalTokens = (t: (typeof rows)[number]): number =>
    t.spans.reduce((s, sp) => s + (sp.telemetry?.workerTokens || 0), 0);
  const totalWorkerSeconds = (t: (typeof rows)[number]): number =>
    t.spans.reduce((s, sp) => s + (sp.telemetry?.workerSeconds || 0), 0);
  const estCost = (t: (typeof rows)[number]) => {
    const tokens = totalTokens(t);
    if (!tokens) return null;
    return (tokens / 1e6) * priceFor(runModel(t));
  };

  const data = {
    project: b.project,
    span: { first: journal[0]!.ts, last: journal.at(-1)!.ts },
    wallMinutes: (t1 - t0) / 60000,
    tickets: rows.map(t => ({
      id: t.id, title: t.meta.title || '',
      depends_on: t.meta.depends_on || [], model: runModel(t),
      attempts: t.attempts, closedAt: t.closedAt,
      closeX: t.closedAt ? x(t.closedAt) : null,
      tokens: totalTokens(t) || null,
      workerSeconds: totalWorkerSeconds(t) || null,
      cost: estCost(t),
      spans: t.spans.map(s => ({
        x0: x(s.start), x1: x(s.end), start: s.start, end: s.end,
        outcome: s.outcome, repair: /repair/i.test(t.meta.origin || ''),
      })),
      verifies: t.verifies.map((v: any) => ({
        x1: x(v.ts), x0: x(new Date(+new Date(v.ts) - (v.durationMs || 0)).toISOString()),
        ts: v.ts, durationMs: v.durationMs || 0, pass: v.pass,
      })),
    })),
    gates: gates.map(g => ({ x: x(g.ts), ts: g.ts, body: g.body })),
    time: deriveTime(journal, transcriptsRoot),
  };

  // The coordinator's journaled final report — the page's opening section.
  // Last one wins: a corrected report is re-journaled, never edited in place.
  const reportEntry = [...journal].reverse().find(e => e.kind === 'campaign-report' && typeof ((e as any).body) === 'string');
  const reportHtml = reportEntry ? mdToHtml(reportEntry.body!) : null;

  const totalCost = data.tickets.reduce((s, t) => s + (t.cost || 0), 0);
  // Priced against CLOSED tickets, not all of them: an open or parked ticket was
  // never expected to report telemetry, and counting it as missing would label
  // every mid-campaign archive partial.
  const closedTickets = data.tickets.filter(t => t.closedAt);
  const pricedCount = closedTickets.filter(t => t.cost != null).length;
  const costCoverage = pricedCount === 0 ? 'none'
    : pricedCount === closedTickets.length ? 'full'
    : 'partial';
  const unpriced = closedTickets.length - pricedCount;

  const html = `<title>ailoop post-mortem — ${data.project}</title>
<style>
  :root { color-scheme: light dark; }
  .viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb; --plane: #f9f9f7;
    --ink-1: #0b0b0b; --ink-2: #52514e; --ink-3: #898781;
    --grid: #e1e0d9; --axisline: #c3c2b7; --ring: rgba(11,11,11,0.10);
    --c-build: #2a78d6; --c-repair: #1baf7a; --c-verify: #e87ba4;
    --c-gate: #eda100; --c-fail: #e34948;
    --c-unit: #eb6834; --c-itest: #1baf7a; --c-e2e: #eda100;
    --c-types: #4a3aa7; --c-review: #008300; --c-other: #898781; --c-stall: #5f5c57;
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--ink-1); background: var(--plane);
    margin: 0; padding: 24px; min-height: 100vh; box-sizing: border-box;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1: #1a1a19; --plane: #0d0d0d;
      --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
      --grid: #2c2c2a; --axisline: #383835; --ring: rgba(255,255,255,0.10);
      --c-build: #3987e5; --c-repair: #199e70; --c-verify: #d55181;
      --c-gate: #c98500; --c-fail: #e66767;
      --c-unit: #d95926; --c-itest: #199e70; --c-e2e: #c98500;
      --c-types: #9085e9; --c-review: #008300; --c-other: #898781; --c-stall: #6f6c66;
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --plane: #0d0d0d;
    --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
    --grid: #2c2c2a; --axisline: #383835; --ring: rgba(255,255,255,0.10);
    --c-build: #3987e5; --c-repair: #199e70; --c-verify: #d55181;
    --c-gate: #c98500; --c-fail: #e66767;
    --c-unit: #d95926; --c-itest: #199e70; --c-e2e: #c98500;
    --c-types: #9085e9; --c-review: #008300; --c-other: #898781; --c-stall: #6f6c66;
  }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: var(--ink-2); margin: 0 0 20px; }
  .card { background: var(--surface-1); border: 1px solid var(--ring); border-radius: 10px; padding: 16px 18px; margin-bottom: 18px; }
  .tiles { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
  .tile { background: var(--surface-1); border: 1px solid var(--ring); border-radius: 10px; padding: 12px 16px; flex: 1 1 150px; min-width: 150px; }
  .tile .label { color: var(--ink-2); font-size: 12px; }
  .tile .value { font-size: 26px; font-weight: 600; margin-top: 2px; }
  .tile .note { color: var(--ink-3); font-size: 12px; margin-top: 2px; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  .desc { color: var(--ink-2); font-size: 13px; margin: 0 0 12px; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--ink-2); margin-bottom: 10px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .gantt-scroll { overflow-x: auto; }
  svg text { font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--ink-3); }
  svg text.lane-label { fill: var(--ink-1); font-weight: 600; }
  .tooltip { position: fixed; pointer-events: none; background: var(--surface-1); color: var(--ink-1);
    border: 1px solid var(--ring); border-radius: 8px; padding: 8px 10px; font-size: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.18); max-width: 320px; z-index: 10; display: none; }
  .tooltip .t-head { font-weight: 600; margin-bottom: 2px; }
  .tooltip .t-sub { color: var(--ink-2); }
  .bars .row { display: grid; grid-template-columns: 56px 1fr 150px; align-items: center; gap: 10px; margin: 3px 0; }
  .bars .id { font-weight: 600; font-size: 12px; }
  .bars .track { height: 16px; position: relative; }
  .bars .fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 0 4px 4px 0; }
  .bars .val { color: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
  .stack .row { display: grid; grid-template-columns: 72px 1fr 160px; align-items: center; gap: 10px; margin: 3px 0; }
  .stack .id { font-weight: 600; font-size: 12px; }
  .stack .id .att { color: var(--c-fail); font-weight: 600; }
  .stack .track { display: flex; height: 16px; align-items: stretch; }
  .stack .seg { border-radius: 3px; margin-right: 2px; min-width: 2px; }
  .stack .seg:last-child { margin-right: 0; }
  .stack .val { color: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
  .sharebar { display: flex; height: 24px; margin: 6px 0 4px; }
  .sharebar .seg { border-radius: 3px; margin-right: 2px; position: relative; }
  .sharebar .seg:last-child { margin-right: 0; }
  .sharebar .seg .pct { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 600; color: #fff; text-shadow: 0 0 3px rgba(0,0,0,0.45); }
  .notes { color: var(--ink-3); font-size: 12px; margin: 10px 0 0; }
  .notes li { margin: 2px 0 2px 16px; }
  .report h3 { font-size: 14px; margin: 14px 0 4px; }
  .report h4 { font-size: 13px; margin: 12px 0 3px; }
  .report h5, .report h6 { font-size: 12.5px; margin: 10px 0 2px; }
  .report p, .report ul { margin: 6px 0; font-size: 13.5px; }
  .report li { margin: 2px 0 2px 18px; }
  .report code { background: var(--plane); border: 1px solid var(--grid); border-radius: 4px; padding: 0 4px; font-size: 12px; }
  .report pre { background: var(--plane); border: 1px solid var(--grid); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
  .report pre code { border: 0; background: none; padding: 0; }
  .report a { color: var(--c-build); }
  details summary { cursor: pointer; color: var(--ink-2); font-size: 13px; }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--grid); vertical-align: top; }
  th { color: var(--ink-2); font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
<div class="viz-root">
  <h1>ailoop post-mortem — ${data.project}</h1>
  <p class="sub">Rendered from journal.jsonl · worker costs estimated from journaled tokens · coordinator-session overhead not included</p>
  <div class="tiles" id="tiles"></div>
  ${reportHtml ? `<div class="card report">
    <h2>Campaign report</h2>
    <p class="desc">Journaled by the coordinator at termination (${new Date(reportEntry!.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC). The sections below carry the measurements behind it.</p>
    ${reportHtml}
  </div>` : ''}
  <div class="card">
    <h2>Campaign timeline</h2>
    <p class="desc">One lane per ticket, ordered by dispatch. A ticket's bar runs dispatch → judgment (build + verify + judge). Hover a span for detail; hover a ticket label to trace dependencies (upstream solid, downstream dashed).</p>
    <div class="legend">
      <span><span class="sw" style="background:var(--c-build)"></span>in flight → closed</span>
      <span><span class="sw" style="background:var(--c-fail)"></span>in flight → failed attempt</span>
      <span><span class="sw" style="background:var(--c-repair)"></span>repair ticket</span>
      <span><span class="sw" style="background:var(--c-verify)"></span>verify.mjs</span>
      <span><span class="sw" style="background:var(--c-gate)"></span>gate event</span>
      <span><span class="sw" style="background:var(--ink-3); border-radius:99px"></span>close (merged)</span>
    </div>
    <div class="gantt-scroll"><div id="gantt"></div></div>
  </div>
  <div class="card">
    <h2>Where the time went</h2>
    <p class="desc" id="time-desc"></p>
    <div class="tiles" id="time-tiles"></div>
    <div class="sharebar" id="time-share"></div>
    <div class="legend" id="time-legend"></div>
    <div class="stack" id="time-bars"></div>
    <div id="time-scatter" style="overflow-x:auto"></div>
    <div class="tiles" id="time-tiers"></div>
    <ul class="notes" id="time-notes"></ul>
    <details>
      <summary>Table view — per-ticket minutes by bucket</summary>
      <div id="time-table" style="overflow-x:auto"></div>
    </details>
  </div>
  ${costCoverage === 'none' ? `<div class="card">
    <h2>Cost per ticket</h2>
    <p class="desc">Not available for this campaign. Worker cost is priced from token
    counts the coordinator passes to <code>backlog close</code>, and none were
    recorded — the coordinator spawns its workers through its own harness, which
    does not always report their usage back. Ticket durations are on the timeline
    above; they are wall time, not spend.</p>
  </div>` : `<div class="card">
    <h2>Cost per ticket (worker spend, estimated)</h2>
    <p class="desc">From journaled worker tokens priced at the model's output rate.${
      costCoverage === 'partial'
        ? ` <strong>Partial:</strong> ${pricedCount} of ${closedTickets.length} closed tickets reported tokens, so the
            total below covers those ${pricedCount} only and the other ${unpriced} are absent
            rather than free.`
        : ''} Tickets without journaled tokens show duration only.</p>
    <div class="bars" id="costbars"></div>
  </div>`}
  <div class="card">
    <details>
      <summary>Table view — every ticket with timings, attempts, tokens, and cost</summary>
      <div id="tablewrap" style="overflow-x:auto"></div>
    </details>
  </div>
  <div class="tooltip" id="tip"></div>
</div>
<script type="application/json" id="journal">${JSON.stringify(journal).replace(/</g, '\\u003c')}</script>
<script>
const D = ${JSON.stringify(data).replace(/</g, '\\u003c')};
const money = v => '$' + v.toFixed(2);
const fmtT = ts => new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
const mins = ms => (ms / 60000).toFixed(1) + ' min';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const closed = D.tickets.filter(t => t.closedAt).length;
const attempts = D.tickets.reduce((s, t) => s + t.attempts, 0);
const totalCost = ${JSON.stringify(costCoverage === 'none' ? null : totalCost)};
const costNote = ${JSON.stringify(
  costCoverage === 'full'
    ? 'excludes coordinator overhead'
    : `${pricedCount} of ${closedTickets.length} closed tickets · excludes coordinator overhead`,
)};
const tiles = [
  ['Wall time', Math.round(D.wallMinutes) + ' min', fmtT(D.span.first) + ' → ' + fmtT(D.span.last)],
  ['Tickets closed', closed + ' / ' + D.tickets.length, attempts + ' failed attempt' + (attempts === 1 ? '' : 's')],
  // A partial total is labelled where it is shown, not only in the section below:
  // a stat tile is the thing people screenshot.
  totalCost != null ? ['Worker cost (est.)' + ${JSON.stringify(costCoverage === 'partial' ? ', partial' : '')}, money(totalCost), costNote] : null,
  ['Verify runs', D.tickets.reduce((s, t) => s + t.verifies.length, 0), mins(D.tickets.reduce((s, t) => s + t.verifies.reduce((a, v) => a + v.durationMs, 0), 0)) + ' scripted, zero model cost'],
].filter(Boolean);
document.getElementById('tiles').innerHTML = tiles.map(([l, v, n]) =>
  '<div class="tile"><div class="label">' + l + '</div><div class="value">' + v + '</div><div class="note">' + n + '</div></div>').join('');

const LABEL_W = 200, LANE_H = 26, PAD_T = 26, PAD_B = 8, PLOT_W = 1080;
const H = PAD_T + D.tickets.length * LANE_H + PAD_B;
const W = LABEL_W + PLOT_W + 16;
const px = f => LABEL_W + f * PLOT_W;
const laneY = i => PAD_T + i * LANE_H;
const laneIdx = Object.fromEntries(D.tickets.map((t, i) => [t.id, i]));

let svg = '<svg width="' + W + '" height="' + H + '" role="img" aria-label="Campaign timeline">';
const spanMs = new Date(D.span.last) - new Date(D.span.first);
const tickEvery = spanMs > 4 * 3600e3 ? 60 : 30;
for (let m = 0; m * 60000 <= spanMs; m += tickEvery) {
  const ts = new Date(D.span.first).getTime() + m * 60000;
  const fx = px(m * 60000 / spanMs);
  svg += '<line x1="' + fx + '" y1="' + (PAD_T - 6) + '" x2="' + fx + '" y2="' + (H - PAD_B) + '" stroke="var(--grid)" stroke-width="1"/>';
  svg += '<text x="' + fx + '" y="' + (PAD_T - 10) + '" text-anchor="middle">' + fmtT(ts) + '</text>';
}
for (const g of D.gates) {
  svg += '<line class="hov" x1="' + px(g.x) + '" y1="' + PAD_T + '" x2="' + px(g.x) + '" y2="' + (H - PAD_B) + '" stroke="var(--c-gate)" stroke-width="2" opacity="0.7"' +
    ' data-tip="' + esc('<div class=t-head>gate event</div><div>' + esc(g.body) + '</div><div class=t-sub>' + fmtT(g.ts) + '</div>') + '"/>';
}
let arrows = '';
for (const t of D.tickets) {
  if (!t.spans.length) continue;
  for (const dep of t.depends_on) {
    const dt = D.tickets.find(o => o.id === dep);
    if (!dt || laneIdx[dep] === undefined) continue;
    const sx = px(dt.closeX ?? (dt.spans.at(-1)?.x1 ?? 0));
    const sy = laneY(laneIdx[dep]) + LANE_H / 2;
    const ex = px(t.spans[0].x0), ey = laneY(laneIdx[t.id]) + LANE_H / 2;
    arrows += '<path class="dep" data-from="' + dep + '" data-to="' + t.id + '" d="M' + sx + ' ' + sy +
      ' C ' + (sx + 24) + ' ' + sy + ', ' + (ex - 24) + ' ' + ey + ', ' + ex + ' ' + ey +
      '" fill="none" stroke="var(--axisline)" stroke-width="1" opacity="0.5"/>';
  }
}
svg += '<g id="deps">' + arrows + '</g>';
D.tickets.forEach((t, i) => {
  const y = laneY(i), cy = y + LANE_H / 2, barY = y + (LANE_H - 14) / 2;
  svg += '<text class="lane-label" data-ticket="' + t.id + '" x="8" y="' + (cy + 4) + '">' + t.id + '</text>';
  for (const s of t.spans) {
    const color = s.repair ? 'var(--c-repair)' : (s.outcome === 'attempt' ? 'var(--c-fail)' : 'var(--c-build)');
    const bw = Math.max(3, (s.x1 - s.x0) * PLOT_W);
    svg += '<rect class="hov" x="' + px(s.x0) + '" y="' + barY + '" width="' + bw + '" height="14" rx="4" fill="' + color + '"' +
      ' data-tip="' + esc('<div class=t-head>' + t.id + (s.outcome === 'attempt' ? ' — failed attempt' : s.outcome === 'decomposed' ? ' — decomposed' : '') + (t.model ? ' · ' + t.model : '') + '</div>' +
        '<div>' + esc(t.title) + '</div>' +
        '<div class=t-sub>' + fmtT(s.start) + ' → ' + fmtT(s.end) + ' (' + mins(new Date(s.end) - new Date(s.start)) + ')' +
        (t.tokens ? ' · ' + Math.round(t.tokens / 1000) + 'k worker tokens' : '') +
        (t.cost != null ? ' · ' + money(t.cost) + ' est.' : '') + '</div>') + '"/>';
  }
  for (const v of t.verifies) {
    const vw = Math.max(2, (v.x1 - v.x0) * PLOT_W);
    svg += '<rect class="hov" x="' + px(v.x0) + '" y="' + (barY + 2) + '" width="' + vw + '" height="10" rx="3" fill="var(--c-verify)"' +
      ' data-tip="' + esc('<div class=t-head>' + t.id + ' verify.mjs — ' + (v.pass ? 'pass' : 'fail') + '</div><div class=t-sub>' + fmtT(v.ts) + ' · ' + mins(v.durationMs) + '</div>') + '"/>';
  }
  if (t.closeX != null) {
    svg += '<circle class="hov" cx="' + px(t.closeX) + '" cy="' + cy + '" r="4" fill="var(--ink-3)" stroke="var(--surface-1)" stroke-width="2"' +
      ' data-tip="' + esc('<div class=t-head>' + t.id + ' closed</div><div class=t-sub>' + fmtT(t.closedAt) + ' — evidence recorded, branch merged</div>') + '"/>';
  }
});
svg += '<line x1="' + LABEL_W + '" y1="' + (H - PAD_B) + '" x2="' + (LABEL_W + PLOT_W) + '" y2="' + (H - PAD_B) + '" stroke="var(--axisline)" stroke-width="1"/>';
svg += '</svg>';
document.getElementById('gantt').innerHTML = svg;

const tip = document.getElementById('tip');
function wireTips(root) {
  root.querySelectorAll('.hov').forEach(el => {
    el.addEventListener('mousemove', e => {
      tip.innerHTML = el.dataset.tip; tip.style.display = 'block';
      const r = tip.getBoundingClientRect();
      tip.style.left = Math.min(e.clientX + 14, innerWidth - r.width - 10) + 'px';
      tip.style.top = Math.min(e.clientY + 14, innerHeight - r.height - 10) + 'px';
    });
    el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}
wireTips(document.getElementById('gantt'));

document.querySelectorAll('text.lane-label[data-ticket]').forEach(el => {
  el.addEventListener('mouseenter', () => {
    document.querySelectorAll('#deps .dep').forEach(p => {
      const up = p.dataset.to === el.dataset.ticket, down = p.dataset.from === el.dataset.ticket;
      if (up || down) {
        p.setAttribute('opacity', '1'); p.setAttribute('stroke', 'var(--ink-1)'); p.setAttribute('stroke-width', '1.5');
        if (down) p.setAttribute('stroke-dasharray', '4 3');
      } else p.setAttribute('opacity', '0.12');
    });
  });
  el.addEventListener('mouseleave', () => {
    document.querySelectorAll('#deps .dep').forEach(p => {
      p.setAttribute('opacity', '0.5'); p.setAttribute('stroke', 'var(--axisline)');
      p.setAttribute('stroke-width', '1'); p.removeAttribute('stroke-dasharray');
    });
  });
});

const spanTotal = t => t.spans.reduce((s, sp) => s + (new Date(sp.end) - new Date(sp.start)), 0);
const metric = t => t.cost ?? spanTotal(t) / 60000 / 1000; // cost, else minutes shrunk to sort after any cost
const sorted = D.tickets.slice().sort((a, b) => metric(b) - metric(a));
const maxM = Math.max(...sorted.map(metric), 1e-9);
// The cost section is omitted entirely when nothing was priced, so this block is
// conditional too — an unguarded getElementById on a missing node throws and takes
// the rest of the page's script (table, tooltips) down with it.
const costbars = document.getElementById('costbars');
if (costbars) {
costbars.innerHTML = sorted.map(t =>
  '<div class="row"><div class="id">' + t.id + '</div>' +
  '<div class="track"><div class="fill hov" style="width:' + (metric(t) / maxM * 100) + '%; background: var(--c-build)"' +
  ' data-tip="' + esc('<div class=t-head>' + t.id + (t.cost != null ? ' · ' + money(t.cost) + ' est.' : '') + '</div><div>' + esc(t.title) + '</div><div class=t-sub>' +
    (t.tokens ? Math.round(t.tokens / 1000) + 'k worker tokens · ' : '') + mins(spanTotal(t)) + ' in flight</div>') + '"></div></div>' +
  '<div class="val">' + (t.cost != null ? money(t.cost) + ' · ' : '') + mins(spanTotal(t)) + '</div></div>').join('');
wireTips(costbars);
}

// ---- where the time went ----
const TT = D.time;
const SEG = {
  impl:   ['model inference', 'var(--c-build)'],
  unit:   ['unit', 'var(--c-unit)'],
  itest:  ['integration', 'var(--c-itest)'],
  e2e:    ['e2e', 'var(--c-e2e)'],
  types:  ['typecheck · lint', 'var(--c-types)'],
  verify: ['verify', 'var(--c-verify)'],
  review: ['review', 'var(--c-review)'],
  other:  ['other', 'var(--c-other)'],
  worker: ['worker (unsplit)', 'var(--c-build)'],
  land:   ['land', 'var(--c-other)'],
  stall:  ['coordinator stall', 'var(--c-stall)'],
  blocked:['blocked \\u00b7 parked', 'var(--c-fail)'],
};
const segLabel = k => SEG[k][0], segColor = k => SEG[k][1];
const fmtMin = v => (v >= 100 ? Math.round(v) : +v.toFixed(1)) + ' min';

document.getElementById('time-desc').textContent = TT.coverage === 'none'
  ? 'From journal phase stamps alone: dispatch → verify → review → land per ticket. No worker '
    + 'transcripts were discoverable for the closed tickets, so the worker bar is undivided — '
    + 'codex workers leave no transcript here, and old sessions may have been cleaned.'
  : 'Journal phase walls, refined by the ' + TT.analyzed + ' closed ticket'
    + (TT.analyzed === 1 ? '\\u2019s' : 's\\u2019') + ' retained worker/judge transcripts into model '
    + 'inference vs test suites vs checks.'
    + (TT.coverage === 'partial'
      ? ' Partial: ' + (TT.closed - TT.analyzed) + ' of ' + TT.closed
        + ' closed tickets have no discoverable transcript and render phase walls only.'
      : '');

const settled = TT.tickets.filter(t => t.segs.length);
const shareTotal = TT.share.reduce((s, x) => s + x.min, 0);
const splitTickets = TT.tickets.filter(t => t.split && t.ktok != null);
const avgKtok = splitTickets.length ? Math.round(splitTickets.reduce((s, t) => s + t.ktok, 0) / splitTickets.length) : null;
const thinkPcts = splitTickets.map(t => t.thinkPct).filter(v => v != null);
const avgThink = thinkPcts.length ? Math.round(thinkPcts.reduce((s, v) => s + v, 0) / thinkPcts.length) : null;
const timeTiles = [
  ['Dispatch shape', TT.shape.maxInFlight <= 1 ? 'serial' : '\\u2264' + TT.shape.maxInFlight + ' in flight',
    fmtMin(TT.shape.idleMin) + ' idle between tickets'],
  TT.shape.heldMin > 0 ? ['Held on a park', fmtMin(TT.shape.heldMin),
    'wall with \\u22651 ticket parked'
      + (TT.shape.unreleasedParks ? ' \\u00b7 ' + TT.shape.unreleasedParks + ' still parked' : '')] : null,
  settled.length ? ['Avg ticket cycle', fmtMin(settled.reduce((s, t) => s + t.totalMin, 0) / settled.length),
    TT.share.slice().sort((a, z) => z.min - a.min).slice(0, 3)
      .map(s => segLabel(s.k).split(' ')[0] + ' ' + Math.round(100 * s.min / shareTotal) + '%').join(' \\u00b7 ')] : null,
  TT.rate != null ? ['Sustained throughput', TT.rate + ' tok/s', 'median output tokens \\u00f7 model time'] : null,
  avgKtok != null ? ['Output tokens / ticket', avgKtok + 'k',
    avgThink != null ? '\\u2248' + avgThink + '% thinking (estimate)' : ''] : null,
].filter(Boolean);
document.getElementById('time-tiles').innerHTML = timeTiles.map(([l, v, n]) =>
  '<div class="tile"><div class="label">' + l + '</div><div class="value">' + v + '</div><div class="note">' + n + '</div></div>').join('');

document.getElementById('time-share').innerHTML = TT.share.map(s => {
  const pct = 100 * s.min / shareTotal;
  return '<div class="seg hov" style="flex:0 0 ' + pct + '%; background:' + segColor(s.k) + '"' +
    ' data-tip="' + esc('<div class=t-head>' + segLabel(s.k) + '</div><div class=t-sub>' + fmtMin(s.min) + ' \\u00b7 ' + pct.toFixed(0) + '% of attributed wall</div>') + '">' +
    (pct >= 9 ? '<span class="pct">' + pct.toFixed(0) + '%</span>' : '') + '</div>';
}).join('');
wireTips(document.getElementById('time-share'));

const segKeys = [...new Set([].concat(TT.share.map(s => s.k), ...TT.tickets.map(t => t.segs.map(s => s.k))))];
document.getElementById('time-legend').innerHTML = segKeys.map(k =>
  '<span><span class="sw" style="background:' + segColor(k) + '"></span>' + segLabel(k) + '</span>').join('');

const maxTotal = Math.max(...settled.map(t => t.totalMin), 1e-9);
document.getElementById('time-bars').innerHTML = settled.slice().sort((a, z) => z.totalMin - a.totalMin).map(t =>
  '<div class="row"><div class="id">' + t.id + (t.attempts ? ' <span class="att">\\u00d7' + (t.attempts + 1) + '</span>' : '') + '</div>' +
  '<div class="track" style="width:' + (100 * t.totalMin / maxTotal) + '%">' +
  t.segs.map(s => '<div class="seg hov" style="flex:' + s.min + ' 0 0; background:' + segColor(s.k) + '"' +
    ' data-tip="' + esc('<div class=t-head>' + t.id + ' \\u00b7 ' + segLabel(s.k) + '</div><div class=t-sub>' + fmtMin(s.min) + ' of ' + fmtMin(t.totalMin) +
      (t.split ? '' : ' (journal phase wall)') + '</div>') + '"></div>').join('') +
  '</div><div class="val">' + fmtMin(t.totalMin) + (t.ktok != null ? ' \\u00b7 ' + t.ktok + 'k tok' : '') + '</div></div>').join('');
wireTips(document.getElementById('time-bars'));

if (TT.scatter.length >= 3 && TT.rate != null) {
  const SW = 680, SHt = 320, PL = 52, PR = 16, PT = 16, PB = 38;
  const maxW = Math.max(...TT.scatter.map(p => p.wallMin)) * 1.08;
  const lineK = w => TT.rate * 60 * w / 1000; // ktok the model emits in w minutes of pure inference
  const maxK = Math.max(...TT.scatter.map(p => p.ktok), lineK(maxW * 0.6)) * 1.12;
  const sx = w => PL + (w / maxW) * (SW - PL - PR);
  const sy = k => SHt - PB - (k / maxK) * (SHt - PT - PB);
  let sc = '<svg width="' + SW + '" height="' + SHt + '" role="img" aria-label="Output tokens vs worker wall">';
  const xstep = maxW > 120 ? 30 : maxW > 40 ? 10 : 5;
  for (let w = 0; w <= maxW; w += xstep) {
    sc += '<line x1="' + sx(w) + '" y1="' + PT + '" x2="' + sx(w) + '" y2="' + (SHt - PB) + '" stroke="var(--grid)"/>' +
      '<text x="' + sx(w) + '" y="' + (SHt - PB + 14) + '" text-anchor="middle">' + w + '</text>';
  }
  const kstep = maxK > 200 ? 50 : maxK > 80 ? 20 : 10;
  for (let k = 0; k <= maxK; k += kstep) {
    sc += '<line x1="' + PL + '" y1="' + sy(k) + '" x2="' + (SW - PR) + '" y2="' + sy(k) + '" stroke="var(--grid)"/>' +
      '<text x="' + (PL - 6) + '" y="' + (sy(k) + 4) + '" text-anchor="end">' + k + '</text>';
  }
  const wEnd = Math.min(maxW, maxK / (TT.rate * 60 / 1000));
  sc += '<line x1="' + sx(0) + '" y1="' + sy(0) + '" x2="' + sx(wEnd) + '" y2="' + sy(lineK(wEnd)) + '"' +
    ' stroke="var(--axisline)" stroke-width="1.5" stroke-dasharray="5 4"/>';
  sc += '<text x="' + (sx(wEnd) - 4) + '" y="' + (sy(lineK(wEnd)) + 12) + '" text-anchor="end">' + TT.rate + ' tok/s \\u2014 on the line = inference-bound</text>';
  for (const p of TT.scatter) {
    sc += '<circle class="hov" cx="' + sx(p.wallMin) + '" cy="' + sy(p.ktok) + '" r="4.5" fill="var(--c-build)" stroke="var(--surface-1)" stroke-width="1.5"' +
      ' data-tip="' + esc('<div class=t-head>' + p.id + '</div><div class=t-sub>' + fmtMin(p.wallMin) + ' worker wall \\u00b7 ' + p.ktok + 'k output tokens' +
        (p.wallMin > p.ktok / (TT.rate * 60 / 1000) * 1.3 ? ' \\u00b7 suite-bound' : '') + '</div>') + '"/>';
  }
  sc += '<text x="' + ((PL + SW - PR) / 2) + '" y="' + (SHt - 4) + '" text-anchor="middle">worker wall (min) \\u2014 right of the line is suite-bound</text>';
  sc += '<line x1="' + PL + '" y1="' + (SHt - PB) + '" x2="' + (SW - PR) + '" y2="' + (SHt - PB) + '" stroke="var(--axisline)"/>';
  sc += '</svg>';
  const scat = document.getElementById('time-scatter');
  scat.innerHTML = sc;
  wireTips(scat);
}

const TIER_LABEL = { typecheck: 'typecheck / lint', unit: 'unit run', integration: 'integration run', e2e: 'e2e run', db: 'db op', verify: 'verify (scripted)' };
const tierTiles = TT.tiers.filter(t => TIER_LABEL[t.k]);
if (tierTiles.length) {
  document.getElementById('time-tiers').innerHTML = tierTiles.map(t =>
    '<div class="tile"><div class="label">' + TIER_LABEL[t.k] + ', single run</div><div class="value">' +
    (t.medianS >= 120 ? (t.medianS / 60).toFixed(1) + ' min' : t.medianS + ' s') +
    '</div><div class="note">median of ' + t.runs + ' runs</div></div>').join('');
}

const timeNotes = [
  TT.coverage !== 'none' ? '\\u201cother\\u201d is wall the transcripts cannot attribute \\u2014 coordinator bookkeeping between phases, unclassified bash, db/git ops, the land, and any retry attempt whose own transcript wasn\\u2019t found \\u2014 disclosed rather than attributed.' : null,
  TT.coverage !== 'none' ? 'The thinking share is an estimate: billed output tokens minus visible characters at \\u22483.7 chars/token. Thinking text is stripped from saved transcripts, so it cannot be measured directly.' : null,
  TT.coverage !== 'none' ? 'Review minutes use the judge transcript\\u2019s wall where one was found; otherwise the journal\\u2019s under-review window, which includes coordinator overhead around the judge.' : null,
  TT.telemetryGaps ? TT.telemetryGaps + ' settled attempt' + (TT.telemetryGaps === 1 ? '' : 's') + ' journaled no workerTokens \\u2014 token totals cover the attempts that reported.' : null,
].filter(Boolean);
document.getElementById('time-notes').innerHTML = timeNotes.map(n => '<li>' + n + '</li>').join('');

const allKeys = ['impl', 'unit', 'itest', 'e2e', 'types', 'verify', 'review', 'land', 'worker', 'other'].filter(k => segKeys.includes(k));
document.getElementById('time-table').innerHTML = '<table><thead><tr><th>Ticket</th><th class="num">Attempts</th>' +
  allKeys.map(k => '<th class="num">' + segLabel(k) + '</th>').join('') +
  '<th class="num">Total</th><th class="num">Tokens</th></tr></thead><tbody>' +
  settled.map(t => '<tr><td><b>' + t.id + '</b></td><td class="num">' + (t.attempts + 1) + '</td>' +
    allKeys.map(k => '<td class="num">' + (t.segs.find(s => s.k === k) ? (+t.segs.find(s => s.k === k).min.toFixed(1)) : '\\u2014') + '</td>').join('') +
    '<td class="num">' + (+t.totalMin.toFixed(1)) + '</td><td class="num">' + (t.ktok != null ? t.ktok + 'k' : '\\u2014') + '</td></tr>').join('') +
  '</tbody></table>';

document.getElementById('tablewrap').innerHTML = '<table><thead><tr>' +
  '<th>Ticket</th><th>Title</th><th>Deps</th><th>Model</th>' +
  '<th class="num">In flight</th><th class="num">Verify</th><th class="num">Attempts</th><th class="num">Tokens</th><th class="num">Cost est.</th><th>Closed</th></tr></thead><tbody>' +
  D.tickets.map(t => '<tr><td><b>' + t.id + '</b></td>' +
    '<td>' + esc(t.title) + '</td><td>' + t.depends_on.join(', ') + '</td><td>' + t.model + '</td>' +
    '<td class="num">' + mins(spanTotal(t)) + '</td>' +
    '<td class="num">' + mins(t.verifies.reduce((s, v) => s + v.durationMs, 0)) + '</td>' +
    '<td class="num">' + t.attempts + '</td>' +
    '<td class="num">' + (t.tokens ? Math.round(t.tokens / 1000) + 'k' : '—') + '</td>' +
    '<td class="num">' + (t.cost != null ? money(t.cost) : '—') + '</td>' +
    '<td>' + (t.closedAt ? fmtT(t.closedAt) : '—') + '</td></tr>').join('') +
  '</tbody></table>';
</script>
`;

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  return { tickets: rows.length, events: journal.length };
}
