// The read-only gate, native. Computes everything the loop needs to KNOW about
// the backlog — never mutates it — as a typed value the coordinator branches on
// directly: no subprocess, no JSON parse of an untyped blob. The type is the
// whole contract.
//
// The ailoop skill ships its own terminal-runnable copy (frontier.mjs) for its
// agent-driven path. The two duplicate this algorithm on purpose and share no
// code, so the skill stays self-contained in any project. They must agree
// ticket-for-ticket — change the verdict here and you change it there too.

import path from 'node:path';
import { backlog } from './backlog.ts';
import type { Backlog, Ticket } from './backlog.ts';
import type { Frontier } from './state.ts';

const isLive = (t: Ticket) => !['closed', 'decomposed'].includes(t.status);

// Manifest/lockfiles are allowlisted: many tickets legitimately touch them, so
// they never count as a collision when deciding which tickets are file-disjoint.
const ALLOW = new Set(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']);
const declaredFiles = (t: Ticket) => (t.files ?? []).filter(f => !ALLOW.has(path.basename(f)));

export function frontier(): Frontier {
  const b = backlog();
  const byId = new Map(b.tickets.map(t => [t.id, t]));

  const problems = findProblems(b, byId);
  const cycles = findCycles(b, byId);

  // ready: deps closed AND status vetted (draft/blocked/in-flight never ready).
  const ready = b.tickets
    .filter(t => t.status === 'vetted')
    .filter(t => (t.depends_on ?? []).every(d => byId.get(d)?.status === 'closed'))
    .map(t => t.id);

  const { capped, stuck } = findWalls(ready, byId, b.caps ?? { maxAttempts: 3, thrash: 2, infraCap: 8 });
  const walled = new Set([...capped, ...stuck].map(x => x.ticket));
  const dispatchable = pickDispatchable(ready.filter(id => !walled.has(id)), b, byId);

  // phasesDone: phases whose live tickets are all gone (and had at least one).
  // Stays true once a phase is sealed — the coordinator filters already-closed
  // phases against the journal; here we only know the work is drained.
  const phasesDone = (b.phases ?? [])
    .filter(p => {
      const ts = b.tickets.filter(t => t.phase === p.id);
      return ts.length > 0 && ts.every(t => !isLive(t));
    })
    .map(p => p.id);

  const inFlight = b.tickets.filter(t => t.status === 'in-flight').map(t => t.id);
  // blocked/draft/vetted/failed-wall tickets all block completion, deliberately.
  const complete = b.tickets.length > 0 && b.tickets.every(t => !isLive(t));
  const counts = b.tickets.reduce<Record<string, number>>(
    (m, t) => (m[t.status] = (m[t.status] ?? 0) + 1, m), {});

  return { problems, cycles, ready, dispatchable, capped, stuck, phasesDone, inFlight, complete, counts };
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
    if (isLive(t) && (!Array.isArray(t.files) || t.files.length === 0))
      problems.push({ ticket: t.id, issue: 'empty files declaration — unknown footprint' });
    if (t.status === 'vetted' && !t.redTeamed)
      problems.push({ ticket: t.id, issue: 'vetted without redTeamed flag — state corruption, backlog-write should have prevented this' });
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

// --- dispatchable: greedily admit ready tickets that are file- AND resource-
//     disjoint from everything in flight and from each other. Seed the occupied
//     sets with what's already running, then stream admissions. ---------------
function pickDispatchable(candidates: string[], b: Backlog, byId: Map<string, Ticket>): string[] {
  const inFlight = b.tickets.filter(t => t.status === 'in-flight');
  const occupiedFiles = new Set(inFlight.flatMap(declaredFiles));
  const occupiedResources = new Set(inFlight.flatMap(t => t.resources ?? []));
  const dispatchable: string[] = [];
  for (const id of candidates) {
    const t = byId.get(id)!;
    const files = declaredFiles(t);
    const resources = t.resources ?? [];
    if (files.some(f => occupiedFiles.has(f))) continue;
    if (resources.some(r => occupiedResources.has(r))) continue;
    dispatchable.push(id);
    files.forEach(f => occupiedFiles.add(f));
    resources.forEach(r => occupiedResources.add(r));
  }
  return dispatchable;
}
