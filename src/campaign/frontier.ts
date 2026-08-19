// The read-only gate, native. Computes everything the loop needs to KNOW about
// the backlog — never mutates it — as a typed value the coordinator branches on
// directly: no subprocess, no JSON parse of an untyped blob. The type is the
// whole contract.
//
// Most of it reads the backlog against itself (what is runnable, what is
// walled, what runs next). `coverage` is the exception: it reads the
// backlog against the SPEC, joining tickets to the requirement ids kickoff
// enumerated, which is the only way the loop can notice work nobody wrote a
// ticket for while there is still time to write one.
//
// The ailoop skill's model-driven seat reads exactly this, through
// `loop frontier` (mechanics.ts) — one arithmetic, so a seat comparison never
// turns into a comparison of two schedulers.

import { backlog } from './backlog.ts';
import type { Backlog, Ticket } from './backlog.ts';
import type { Frontier } from './state.ts';
import { gateGreen } from './gate.ts';

const isLive = (t: Ticket) => !['closed', 'decomposed'].includes(t.status);

export function frontier(): Frontier {
  const b = backlog();
  const byId = new Map(b.tickets.map(t => [t.id, t]));

  const problems = findProblems(b, byId);
  const cycles = findCycles(b, byId);

  // An open ticket is either ready (all deps closed → dispatchable-eligible) or
  // waiting (a dep is still open). Both are the SAME stored status; the split is
  // derived here, never persisted — it flips the instant a dependency closes.
  const openTickets = b.tickets.filter(t => t.status === 'open');
  const depsClosed = (t: Ticket) => (t.depends_on ?? []).every(d => byId.get(d)?.status === 'closed');
  const ready = openTickets.filter(depsClosed).map(t => t.id);
  const waiting = openTickets.filter(t => !depsClosed(t)).map(t => t.id);

  const { capped, stuck } = findWalls(ready, byId, b.caps ?? { maxAttempts: 3, thrash: 2, infraCap: 8 });
  const walled = new Set([...capped, ...stuck].map(x => x.ticket));
  const dispatchable = pickDispatchable(ready.filter(id => !walled.has(id)), b, byId);

  const inFlight = b.tickets.filter(t => t.status === 'in-flight').map(t => t.id);
  // Serial dispatch makes the second clause structural — dispatchable is
  // empty whenever anything is in flight — so idle reads directly: work was
  // available and the coordinator's pass ended without dispatching it.
  const idle = dispatchable.length > 0;
  // parked/open/in-flight tickets all block completion, deliberately.
  const complete = b.tickets.length > 0 && b.tickets.every(t => !isLive(t));
  const counts = b.tickets.reduce<Record<string, number>>(
    (m, t) => (m[t.status] = (m[t.status] ?? 0) + 1, m), {});

  const cov = coverage(b);
  return { problems, cycles, ready, waiting, dispatchable, capped, stuck, inFlight, idle, complete, counts,
    gateGreen: gateGreen(), coverage: cov, sweepDue: sweepDue(b, cov) };
}

// --- sweep: the milestone owed a reflective pass ----------------------------
// A milestone is reached when every clause it delivers is proven — strictly
// stronger than "its tickets closed", since `proven` also requires that some
// ticket claimed each clause at all. So a milestone cannot arrive over a gap in
// its own coverage, which is the point: the checkpoint is the spec's statement
// that a slice of the product now exists, and an unclaimed clause inside it
// means the slice does not, however many tickets landed nearby.
//
// Reaching one is permanent — proven clauses never un-prove — so the trigger is
// cleared by being spent (`sweep-run --milestone`) rather than by the next
// close. Only the earliest unspent one is reported: two arriving together are
// two moments, and collapsing them into one sweep would drop the older one's
// summary from the rolling memory.
function sweepDue(b: Backlog, cov: Frontier['coverage']): string | null {
  const proven = new Set(cov.proven);
  const spent = new Set(b.sweep?.milestones ?? []);
  const reached = (b.milestones ?? []).find(m => !spent.has(m.id) && m.delivers.every(r => proven.has(r)));
  return reached?.id ?? null;
}

// --- coverage: the spec-side reading of progress ----------------------------
// Exported as well as folded into the frontier: the views already hold a
// Backlog, and the dashboard re-renders every second — no reason to re-read the
// file and re-walk the dependency graph to answer a question about two fields.
// Closed tickets measure the backlog against itself. This measures it against
// the enumeration kickoff made from the spec, which is the only thing that can
// notice work nobody ever wrote a ticket for.
//
// A decomposed parent's claim doesn't count: it delegated the work, and its
// children carry their own claims — counting the parent would report a clause as
// mapped when the ticket that would deliver it may never have been written.
//
// `proven` demands that EVERY claiming ticket closed, not that one did. Two
// tickets claiming a clause are two halves of it; a requirement isn't delivered
// while a ticket for it is still open. Nothing here is a judgement about proof
// quality — a closed ticket only means its own checks went green at the
// boundary they observe. That grading is still the terminal coverage pass's job.
export function coverage(b: Backlog): Frontier['coverage'] {
  const requirements = b.requirements ?? [];
  const claimants = new Map(requirements.map(r => [r.id, [] as Ticket[]]));
  for (const t of b.tickets) {
    if (t.status === 'decomposed') continue;
    for (const r of t.satisfies ?? []) claimants.get(r)?.push(t);
  }
  const unmapped: string[] = [];
  const proven: string[] = [];
  for (const [id, tickets] of claimants) {
    if (!tickets.length) unmapped.push(id);
    else if (tickets.every(t => t.status === 'closed')) proven.push(id);
  }
  return { requirements: requirements.length, unmapped, proven };
}

// --- structural problems: the graph lying about what's runnable ------------
function findProblems(b: Backlog, byId: Map<string, Ticket>): Frontier['problems'] {
  const problems: Frontier['problems'] = [];
  for (const t of b.tickets) {
    for (const d of t.depends_on ?? []) {
      const dep = byId.get(d);
      if (!dep) problems.push({ ticket: t.id, issue: `dangling dependency ${d}` });
      else if (dep.status === 'decomposed' && isLive(t))
        problems.push({ ticket: t.id, issue: `stranded on decomposed ${d} — rewire onto its children` });
    }
    if (isLive(t) && (!Array.isArray(t.modules) || t.modules.length === 0))
      problems.push({ ticket: t.id, issue: 'empty modules declaration — unknown footprint' });
  }
  const seen = new Set<string>();
  for (const t of b.tickets) {
    if (seen.has(t.id)) problems.push({ ticket: t.id, issue: 'duplicate id' });
    seen.add(t.id);
  }
  return problems;
}

// --- cycle detection: iterative DFS over live-edge dependencies -------------
function findCycles(b: Backlog, byId: Map<string, Ticket>): string[][] {
  const cycles: string[][] = [];
  const state: Record<string, 1 | 2> = {}; // absent = unvisited, 1 = in-stack, 2 = done
  for (const start of b.tickets) {
    if (state[start.id]) continue;
    const stack: Array<[string, number, string[]]> = [[start.id, 0, [start.id]]];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const [id, i, trail] = top;
      if (i === 0) state[id] = 1;
      const deps = (byId.get(id)?.depends_on ?? []).filter(d => byId.has(d));
      if (i < deps.length) {
        top[1]++;
        const d = deps[i]!;
        if (state[d] === 1) {
          const from = trail.indexOf(d);
          cycles.push([...trail.slice(from >= 0 ? from : 0), d]);
        } else if (!state[d]) {
          stack.push([d, 0, [...trail, d]]);
        }
      } else {
        state[id] = 2;
        stack.pop();
      }
    }
  }
  return cycles;
}

// Sentinels for infra attempts recorded before the explicit `infra` flag
// existed (or by any path that forgets it): a `failed` list that is exactly one
// of these is the machine failing, not the ticket. New attempts carry `infra`
// directly; this keeps the verdict stable across pre-flag backlogs.
const INFRA_SENTINELS = new Set(['worker-channel', 'merge-conflict']);
export const isInfraAttempt = (a: { infra?: boolean; failed?: string[] | string }): boolean => {
  if (a.infra) return true;
  const f = Array.isArray(a.failed) ? a.failed : a.failed ? [a.failed] : [];
  return f.length > 0 && f.every(x => INFRA_SENTINELS.has(x));
};

// --- walls: ready tickets held out of dispatch until a human intervenes.
//     capped = hit the merit-attempt cap; stuck = thrashing (merit failing set
//     not shrinking); infra-exhausted = the machine kept dying past infraCap.
//     Infra failures never count toward capped/stuck — a ticket earns a merit
//     wall only by genuinely failing on its own terms — but a large infraCap
//     still stops a truly-dead engine from re-dispatching forever. ------------
function findWalls(
  ready: string[],
  byId: Map<string, Ticket>,
  caps: { maxAttempts: number; thrash: number; infraCap?: number },
): { capped: Frontier['capped']; stuck: Frontier['stuck'] } {
  const infraCap = caps.infraCap ?? 8;
  const capped: Frontier['capped'] = [];
  const stuck: Frontier['stuck'] = [];
  for (const id of ready) {
    const all = byId.get(id)!.attempts ?? [];
    const merit = all.filter(a => !isInfraAttempt(a));
    const infra = all.length - merit.length;
    if (merit.length >= caps.maxAttempts) capped.push({ ticket: id, attempts: merit.length });
    else if (infra >= infraCap) capped.push({ ticket: id, attempts: all.length });
    if (merit.length >= caps.thrash) {
      const recent = merit.slice(-caps.thrash).map(x => new Set<string>(x.failed ?? []));
      let shrinking = false;
      for (let i = 1; i < recent.length; i++) if (recent[i]!.size < recent[i - 1]!.size) shrinking = true;
      if (!shrinking && recent.every(s => s.size > 0)) stuck.push({ ticket: id, window: caps.thrash });
    }
  }
  return { capped, stuck };
}

// --- dispatchable: the next ticket, singular. The primary checkout hosts one
//     worker at a time, so anything in flight means nothing else dispatches.
//     Among the ready, the first with a declared footprint — an undeclared one
//     verifies against nothing, so it is held here rather than dispatched
//     where no scope check can measure it (`problems` already reports it for
//     recover to fix). ------------------------------------------------------
function pickDispatchable(candidates: string[], b: Backlog, byId: Map<string, Ticket>): string[] {
  if (b.tickets.some(t => t.status === 'in-flight')) return [];
  const next = candidates.find(id => (byId.get(id)!.modules ?? []).length > 0);
  return next ? [next] : [];
}
