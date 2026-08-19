// Where a ticket's wall clock went, derived from the journal alone: per
// attempt, how long the worker held the checkout, how long verify measured,
// how long the judge took, how long the land took — plus the campaign-shape
// facts (achieved parallelism, coordinator gap) that decide which lever a
// retrospective should reach for. Transcript-level detail (inference vs test
// suites) is transcripts.ts's; this module never leaves journal.jsonl.
//
// A park is wall clock the loop did not spend — the ticket sits waiting on a
// human ruling or an external fix while its span stays open — so it is carved
// out of whichever phase was stamped when it landed and reported as `blocked`.
// Without that subtraction an overnight park is indistinguishable from a slow
// judge: the campaign that taught this module the rule read 50% "review" of
// which 88% was three parks waiting for the human to wake up, which is exactly
// the wrong lever to hand a retrospective.
//
// Spans are keyed per attempt, not per ticket: each `→ in-flight` opens one
// and each attempt/close/decompose settles one. A ticket that walls, retries,
// or is decomposed and re-added therefore yields clean per-attempt walls where
// a first-dispatch → first-verify subtraction goes negative. The one exception
// is deliberate: a `→ in-flight` while a span is already open is a mid-settle
// re-stamp (the amend-typo / gamed round trip parks the ticket in `open` for
// the writer's sake, not because the attempt ended), so it continues the open
// span rather than opening a second.

import type { JournalEntry } from './journal.ts';

export type PhaseWalls = {
  build: number;   // dispatch → first `verifying` stamp: the worker holding the checkout
  verify: number;  // `verifying` → `under-review`
  review: number;  // `under-review` → `merging` (or settle, for a rejected build)
  land: number;    // `merging` → close
  blocked: number; // park wall, carved out of the phase it landed in — waiting, not working
};

// The four phases a stamp opens. `blocked` is deliberately not one: nothing
// stamps it, it is subtracted out of whichever of these was running.
type StampedPhase = Exclude<keyof PhaseWalls, 'blocked'>;

export type AttemptTelemetry = {
  workerTokens?: number;
  workerSeconds?: number;
  model?: string;
  agent?: string;
  judgeAgent?: string;
  // The two edges of the worker's actual life, as ISO stamps. Without them the
  // loop's own dead time is one undifferentiated residual — build wall minus
  // what the worker claimed to spend — which says a gap exists and nothing
  // about where. With them it splits three ways: the coordinator getting a
  // worker started, the worker working, and the coordinator noticing it
  // finished. Only the first and third are anyone's to fix.
  spawnedAt?: string;
  returnedAt?: string;
};

// The stall, resolved. `prep` and `notice` are the coordinator's own latency on
// either side of the worker; `residual` is what is left of the build wall once
// all three are accounted for, and a large one means the stamps disagree with
// the wall rather than that time vanished.
export type StallSplit = { prep: number; notice: number; residual: number };

export type AttemptSpan = {
  n: number;
  start: string;
  end: string;
  outcome: 'close' | 'attempt' | 'decomposed' | 'open';
  walls: PhaseWalls;
  verifyScriptMs: number; // sum of journaled verify runs in this span — script time, a subset of walls.verify
  telemetry: AttemptTelemetry | null;
};

export type TicketBreakdown = { id: string; spans: AttemptSpan[] };

// Split one span's build wall into the coordinator's two latencies and the
// worker's own time. Null when the span did not journal both stamps: a partial
// split would read as "no prep latency here" rather than as "not measured",
// which is the mistake the whole stall bucket exists to stop the report making.
export function stallSplit(span: AttemptSpan): StallSplit | null {
  const { spawnedAt, returnedAt } = span.telemetry ?? {};
  if (!spawnedAt || !returnedAt) return null;
  const prep = Math.max(0, ms(spawnedAt) - ms(span.start));
  const worked = Math.max(0, ms(returnedAt) - ms(spawnedAt));
  const notice = Math.max(0, span.walls.build - prep - worked);
  return { prep, notice, residual: Math.max(0, span.walls.build - prep - worked - notice) };
}

const ms = (ts: string): number => new Date(ts).getTime();

const isTicket = (e: JournalEntry): boolean => /^T\d+$/.test(e.subject || '');

// A park opens at a `parked` entry and closes at the next status transition on
// that ticket — the release is always a status write (`→ open`, then usually
// `→ in-flight`), never a phase stamp, because a parked ticket has no phase to
// advance. A park still open at the last journal event is reported unreleased
// and ends there rather than being dropped: an unresolved park is the most
// expensive kind, and silently omitting it would flatter the campaign.
export type ParkWindow = { ticket: string; start: string; end: string; released: boolean };

export function parkWindows(journal: JournalEntry[]): ParkWindow[] {
  const out: ParkWindow[] = [];
  const open = new Map<string, string>();
  for (const e of journal) {
    if (!isTicket(e)) continue;
    const id = e.subject!;
    if (e.kind === 'parked') { open.set(id, e.ts); continue; }
    const from = open.get(id);
    if (e.kind === 'status' && from !== undefined) {
      open.delete(id);
      out.push({ ticket: id, start: from, end: e.ts, released: true });
    }
  }
  const last = journal.at(-1)?.ts;
  if (last) for (const [ticket, start] of open) out.push({ ticket, start, end: last, released: false });
  return out;
}

// Parks on one ticket never overlap each other (a ticket holds at most one at a
// time), so the intersections sum without double-counting.
const overlapMs = (parks: ParkWindow[], from: number, to: number): number => {
  let total = 0;
  for (const p of parks) {
    const lo = Math.max(from, ms(p.start));
    const hi = Math.min(to, ms(p.end));
    if (hi > lo) total += hi - lo;
  }
  return total;
};

const pickTelemetry = (data: any): AttemptTelemetry | null => {
  if (!data || typeof data !== 'object') return null;
  const out: AttemptTelemetry = {};
  if (typeof data.workerTokens === 'number') out.workerTokens = data.workerTokens;
  if (typeof data.workerSeconds === 'number') out.workerSeconds = data.workerSeconds;
  if (typeof data.model === 'string') out.model = data.model;
  if (typeof data.agent === 'string') out.agent = data.agent;
  if (typeof data.judgeAgent === 'string') out.judgeAgent = data.judgeAgent;
  if (typeof data.spawnedAt === 'string') out.spawnedAt = data.spawnedAt;
  if (typeof data.returnedAt === 'string') out.returnedAt = data.returnedAt;
  return Object.keys(out).length ? out : null;
};

type OpenSpan = {
  start: string;
  verifyingAt?: string;
  reviewAt?: string;
  mergingAt?: string;
  verifyScriptMs: number;
};

export function ticketBreakdowns(journal: JournalEntry[]): TicketBreakdown[] {
  const parksByTicket = new Map<string, ParkWindow[]>();
  for (const p of parkWindows(journal))
    parksByTicket.set(p.ticket, [...(parksByTicket.get(p.ticket) ?? []), p]);

  const tickets = new Map<string, { spans: AttemptSpan[]; open: OpenSpan | null }>();
  const forTicket = (id: string) => {
    let t = tickets.get(id);
    if (!t) { t = { spans: [], open: null }; tickets.set(id, t); }
    return t;
  };

  const settle = (id: string, t: { spans: AttemptSpan[]; open: OpenSpan | null }, end: string,
    outcome: AttemptSpan['outcome'], data: unknown) => {
    const o = t.open;
    if (!o) return;
    t.open = null;
    const walls: PhaseWalls = { build: 0, verify: 0, review: 0, land: 0, blocked: 0 };
    const parks = parksByTicket.get(id) ?? [];
    // A phase segment starts at its own stamp and runs to the next stamped
    // phase (or the settle). A phase never stamped never started — so a build
    // rejected at verify reads build + verify, with nothing leaking into
    // review or land.
    const started = ([
      ['build', o.start], ['verify', o.verifyingAt], ['review', o.reviewAt], ['land', o.mergingAt],
    ] as const).filter((m): m is readonly [StampedPhase, string] => m[1] !== undefined);
    for (let i = 0; i < started.length; i++) {
      const [name, at] = started[i]!;
      const from = Math.max(ms(at), ms(o.start));
      const to = i + 1 < started.length ? ms(started[i + 1]![1]) : ms(end);
      const blocked = overlapMs(parks, from, to);
      walls[name] += Math.max(0, to - from - blocked);
      walls.blocked += blocked;
    }
    t.spans.push({
      n: t.spans.length + 1, start: o.start, end, outcome,
      walls, verifyScriptMs: o.verifyScriptMs, telemetry: pickTelemetry(data),
    });
  };

  for (const e of journal) {
    if (!isTicket(e)) continue;
    const t = forTicket(e.subject!);
    if (e.kind === 'status' && /→ in-flight/.test(e.body || '')) {
      if (!t.open) t.open = { start: e.ts, verifyScriptMs: 0 };
      continue;
    }
    if (e.kind === 'phase' && t.open) {
      const name = (e.body || '').split(/[\s—]/, 1)[0];
      if (name === 'verifying') t.open.verifyingAt ??= e.ts;
      if (name === 'under-review' || name === 'probing') t.open.reviewAt ??= e.ts;
      if (name === 'merging') t.open.mergingAt ??= e.ts;
      continue;
    }
    if (e.kind === 'verify') {
      const d = (e.data as any)?.durationMs;
      if (t.open && typeof d === 'number') t.open.verifyScriptMs += d;
      continue;
    }
    if (e.kind === 'attempt') settle(e.subject!, t, e.ts, 'attempt', e.data);
    if (e.kind === 'close') settle(e.subject!, t, e.ts, 'close', e.data);
    if (e.kind === 'decompose') settle(e.subject!, t, e.ts, 'decomposed', e.data);
  }

  // A crash or a mid-flight render leaves a span open; it ends at the last
  // journal event, marked as such, so the section renders rather than lies.
  const last = journal.at(-1)?.ts;
  if (last) for (const [id, t] of tickets) settle(id, t, last, 'open', null);

  return [...tickets.entries()]
    .map(([id, t]) => ({ id, spans: t.spans }))
    .filter(t => t.spans.length)
    .sort((a, z) => (a.spans[0]!.start < z.spans[0]!.start ? -1 : 1));
}

// The campaign's shape: how parallel the run actually was, and how much wall
// clock sat between settles with nothing in flight — the coordinator's own
// overhead, invisible from inside any one ticket.
export type CampaignShape = {
  maxInFlight: number;
  idleMs: number;      // no span in flight, between the first dispatch and the last settle
  spannedMs: number;   // first dispatch → last settle
  // Wall clock during which at least one ticket was parked — the UNION of the
  // park windows, not their sum, because concurrent parks cost the campaign one
  // wall each. It deliberately overlaps productive work: parallelism can hide a
  // park until the backlog drains behind it, and reporting only fully-dead time
  // (idleMs) would call that campaign healthy right up to the moment it stops.
  heldMs: number;
};

export function campaignShape(breakdowns: TicketBreakdown[], parks: ParkWindow[]): CampaignShape {
  let heldMs = 0, cursor = -Infinity;
  for (const p of [...parks].sort((a, z) => ms(a.start) - ms(z.start))) {
    const [lo, hi] = [ms(p.start), ms(p.end)];
    if (hi <= cursor) continue;
    heldMs += hi - Math.max(lo, cursor);
    cursor = hi;
  }

  const edges: Array<{ at: number; delta: 1 | -1 }> = [];
  for (const t of breakdowns) for (const s of t.spans) {
    edges.push({ at: ms(s.start), delta: 1 });
    edges.push({ at: ms(s.end), delta: -1 });
  }
  if (!edges.length) return { maxInFlight: 0, idleMs: 0, spannedMs: 0, heldMs };
  // Closes before opens at a shared instant: a serial coordinator can journal
  // a close and the next dispatch in the same millisecond, and processing the
  // open first would count the contact point as concurrency. The idle side is
  // indifferent (the gap is zero either way).
  edges.sort((a, z) => a.at - z.at || a.delta - z.delta);
  let live = 0, maxInFlight = 0, idleMs = 0;
  let idleFrom: number | null = null;
  const first = edges[0]!.at;
  for (const e of edges) {
    if (live === 0 && idleFrom !== null) idleMs += e.at - idleFrom;
    live += e.delta;
    maxInFlight = Math.max(maxInFlight, live);
    idleFrom = live === 0 ? e.at : null;
  }
  return { maxInFlight, idleMs, spannedMs: edges.at(-1)!.at - first, heldMs };
}
