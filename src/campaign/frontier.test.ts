// The frontier's three folds — cycle detection, wall arithmetic, and greedy
// module-disjoint admission — are module-private, so every assertion here drives
// them through `frontier()`, the real exported seam, on a scratch campaign.

import { describe, expect, test } from 'bun:test';
import { frontier } from './frontier.ts';
import { buildTicket, withScratchCampaign } from './scratch-campaign.ts';
import type { Ticket } from './backlog.ts';

const onScratch = (tickets: Ticket[], caps?: { maxAttempts: number; thrash: number; infraCap?: number }) => {
  let f!: ReturnType<typeof frontier>;
  withScratchCampaign({ backlog: { tickets, ...(caps ? { caps } : {}) } }, () => { f = frontier(); });
  return f;
};

// No wall ever fires: isolates the graph and admission tests from cap arithmetic.
const NO_WALLS = { maxAttempts: 99, thrash: 99, infraCap: 99 };

describe('findCycles', () => {
  test('a self-dependency is a cycle of one node', () => {
    const f = onScratch([buildTicket({ id: 'T001', depends_on: ['T001'] })], NO_WALLS);
    expect(f.cycles).toEqual([['T001', 'T001']]);
  });

  test('a 3-node cycle is reported once, as the closed trail', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', depends_on: ['T002'] }),
      buildTicket({ id: 'T002', depends_on: ['T003'] }),
      buildTicket({ id: 'T003', depends_on: ['T001'] }),
    ], NO_WALLS);
    expect(f.cycles).toEqual([['T001', 'T002', 'T003', 'T001']]);
  });

  test('disjoint subgraphs are searched independently — only the cyclic one reports', () => {
    const f = onScratch([
      // component A: acyclic chain
      buildTicket({ id: 'T001', depends_on: ['T002'] }),
      buildTicket({ id: 'T002' }),
      // component B: cycle
      buildTicket({ id: 'T003', depends_on: ['T004'] }),
      buildTicket({ id: 'T004', depends_on: ['T003'] }),
      // component C: isolated node
      buildTicket({ id: 'T005' }),
    ], NO_WALLS);
    expect(f.cycles).toEqual([['T003', 'T004', 'T003']]);
  });

  test('a re-converging diamond is not a cycle (a finished node is not in-stack)', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', depends_on: ['T002', 'T003'] }),
      buildTicket({ id: 'T002', depends_on: ['T004'] }),
      buildTicket({ id: 'T003', depends_on: ['T004'] }),
      buildTicket({ id: 'T004' }),
    ], NO_WALLS);
    expect(f.cycles).toEqual([]);
  });

  test('dangling dependencies are dropped by the walk, not walked into', () => {
    const f = onScratch([buildTicket({ id: 'T001', depends_on: ['T404'] })], NO_WALLS);
    expect(f.cycles).toEqual([]);
    expect(f.problems).toEqual([{ ticket: 'T001', issue: 'dangling dependency T404' }]);
  });

  // The trail slice takes `indexOf(d)` and falls back to 0 when the closing node
  // isn't found. Every frame's trail is exactly the ids of the frames beneath it,
  // and `state[d] === 1` means d is one of those frames, so the miss should be
  // unreachable — this pins the property that makes it so: a reported cycle is
  // always closed. Taking the fallback on a deep trail would emit an open path
  // whose head is the DFS root instead of the repeated node.
  test('every reported cycle closes on the node that repeats', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', depends_on: ['T002'] }),
      buildTicket({ id: 'T002', depends_on: ['T003', 'T003'] }),  // duplicate edge
      buildTicket({ id: 'T003', depends_on: ['T004', 'T002'] }),  // back-edge to a deep ancestor
      buildTicket({ id: 'T004', depends_on: ['T004', 'T001'] }),  // self-edge + back-edge to the root
      buildTicket({ id: 'T005', depends_on: ['T003'] }),          // second DFS root, re-entering the mess
    ], NO_WALLS);
    expect(f.cycles.length).toBeGreaterThan(0);
    for (const c of f.cycles) {
      expect(c.length).toBeGreaterThanOrEqual(2);
      expect(c[0]).toBe(c[c.length - 1]!);
    }
  });
});

describe('findWalls', () => {
  const attempt = (failed: string[]) => ({ failed, hypothesis: 'h' });
  const infra = (failed: string[]) => ({ failed, hypothesis: 'h', infra: true });

  test('a ticket at exactly maxAttempts is capped; one under is not', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', attempts: [attempt(['a']), attempt(['b']), attempt(['c'])] }),
      buildTicket({ id: 'T002', attempts: [attempt(['a']), attempt(['b'])] }),
    ], { maxAttempts: 3, thrash: 99 });
    expect(f.capped).toEqual([{ ticket: 'T001', attempts: 3 }]);
    expect(f.ready).toEqual(['T001', 'T002']);      // both ready — the wall is a hold-out, not a status
    expect(f.dispatchable).toEqual(['T002']);       // …and it holds T001 out of dispatch
  });

  test('infra attempts do not count toward the merit cap', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', attempts: [infra(['x']), infra(['y']), infra(['z']), attempt(['a'])] }),
    ], { maxAttempts: 3, thrash: 99, infraCap: 99 });
    expect(f.capped).toEqual([]);
    expect(f.dispatchable).toEqual(['T001']);
  });

  test('a pre-flag attempt failing only on a sentinel counts as infra', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', attempts: [attempt(['worker-channel']), attempt(['merge-conflict']), attempt(['a'])] }),
      // mixed failure set: not purely the machine, so it stays a merit attempt
      buildTicket({ id: 'T002', attempts: [attempt(['worker-channel', 'unit']), attempt(['a']), attempt(['b'])] }),
    ], { maxAttempts: 3, thrash: 99, infraCap: 99 });
    expect(f.capped).toEqual([{ ticket: 'T002', attempts: 3 }]);
  });

  test('infraCap caps a ticket the engine keeps killing, counting all attempts', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', attempts: [infra(['x']), infra(['y']), attempt(['a'])] }),
    ], { maxAttempts: 99, thrash: 99, infraCap: 2 });
    expect(f.capped).toEqual([{ ticket: 'T001', attempts: 3 }]);
  });

  test('a non-shrinking merit window is stuck; a shrinking one is not', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', attempts: [attempt(['a', 'b']), attempt(['c', 'd'])] }),   // 2 → 2: thrashing
      buildTicket({ id: 'T002', attempts: [attempt(['a', 'b']), attempt(['a'])] }),        // 2 → 1: progress
    ], { maxAttempts: 99, thrash: 2 });
    expect(f.stuck).toEqual([{ ticket: 'T001', window: 2 }]);
  });

  test('an empty failing set never reads as thrash', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', attempts: [attempt([]), attempt([])] }),
    ], { maxAttempts: 99, thrash: 2 });
    expect(f.stuck).toEqual([]);
  });

  test('infra attempts are invisible to the thrash window', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', attempts: [infra(['x']), attempt(['a', 'b']), infra(['x']), attempt(['a'])] }),
    ], { maxAttempts: 99, thrash: 2 });
    expect(f.stuck).toEqual([]);   // the two merit attempts shrank 2 → 1
  });

  test('the caps default when the backlog omits them', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', attempts: [attempt(['a']), attempt(['b']), attempt(['c'])] }),
    ]);
    expect(f.capped).toEqual([{ ticket: 'T001', attempts: 3 }]);   // maxAttempts 3
  });
});

// Serial dispatch: the primary checkout hosts one worker at a time, so
// `dispatchable` is the next ticket or nothing — never a batch.
describe('pickDispatchable', () => {
  test('the first ready ticket is the whole dispatch, disjoint or not', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', modules: ['src/auth'] }),
      buildTicket({ id: 'T002', modules: ['src/api'] }),
    ], NO_WALLS);
    expect(f.dispatchable).toEqual(['T001']);
  });

  test('anything in flight means nothing else dispatches', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', modules: ['src/auth'], status: 'in-flight' }),
      buildTicket({ id: 'T002', modules: ['src/api'] }),
    ], NO_WALLS);
    expect(f.inFlight).toEqual(['T001']);
    expect(f.dispatchable).toEqual([]);
  });

  test('a ticket whose deps are not closed never reaches admission', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', modules: ['src/a'] }),
      buildTicket({ id: 'T002', modules: ['src/b'], depends_on: ['T001'] }),
      buildTicket({ id: 'T003', modules: ['src/c'], depends_on: ['T004'] }),
      buildTicket({ id: 'T004', modules: ['src/d'], status: 'closed' }),
    ], NO_WALLS);
    expect(f.ready).toEqual(['T001', 'T003']);
    expect(f.waiting).toEqual(['T002']);
    expect(f.dispatchable).toEqual(['T001']);
  });

  test('an undeclared footprint is held out of dispatch, not admitted freely', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', modules: [] }),
      buildTicket({ id: 'T002', modules: ['src/api'] }),
    ], NO_WALLS);
    expect(f.problems).toEqual([{ ticket: 'T001', issue: 'empty modules declaration — unknown footprint' }]);
    expect(f.dispatchable).toEqual(['T002']);
  });
});

// Closed tickets measure the backlog against itself. Coverage measures it
// against the spec enumeration kickoff made, and the two disagree exactly when
// the decomposition missed something — which is the case worth catching.
describe('coverage', () => {
  const withReqs = (tickets: Ticket[], requirements: { id: string; clause: string }[]) => {
    let f!: ReturnType<typeof frontier>;
    withScratchCampaign({ backlog: { tickets, requirements, caps: NO_WALLS } }, () => { f = frontier(); });
    return f.coverage;
  };

  const REQS = [{ id: 'R1', clause: 'a' }, { id: 'R2', clause: 'b' }];

  test('a requirement no ticket claims is unmapped', () => {
    const cov = withReqs([buildTicket({ id: 'T001', satisfies: ['R1'] })], REQS);
    expect(cov).toEqual({ requirements: 2, unmapped: ['R2'], proven: [] });
  });

  test('a requirement is proven when its claiming ticket closed', () => {
    const cov = withReqs([
      buildTicket({ id: 'T001', satisfies: ['R1'], status: 'closed' }),
      buildTicket({ id: 'T002', satisfies: ['R2'] }),
    ], REQS);
    expect(cov.proven).toEqual(['R1']);
    expect(cov.unmapped).toEqual([]);
  });

  test('two tickets sharing a requirement prove it only once BOTH close', () => {
    const half = withReqs([
      buildTicket({ id: 'T001', satisfies: ['R1'], status: 'closed' }),
      buildTicket({ id: 'T002', satisfies: ['R1'] }),
      buildTicket({ id: 'T003', satisfies: ['R2'], status: 'closed' }),
    ], REQS);
    expect(half.proven).toEqual(['R2']);

    const both = withReqs([
      buildTicket({ id: 'T001', satisfies: ['R1'], status: 'closed' }),
      buildTicket({ id: 'T002', satisfies: ['R1'], status: 'closed' }),
      buildTicket({ id: 'T003', satisfies: ['R2'], status: 'closed' }),
    ], REQS);
    expect(both.proven).toEqual(['R1', 'R2']);
  });

  // The parent delegated the work; its children carry their own claims. Counting
  // the parent would report a clause as mapped when nothing is building it.
  test('a decomposed parent stops claiming — its children must re-claim', () => {
    const orphaned = withReqs([
      buildTicket({ id: 'T001', satisfies: ['R1'], status: 'decomposed' }),
      buildTicket({ id: 'T002' }), // a child that forgot to claim
      buildTicket({ id: 'T003', satisfies: ['R2'] }),
    ], REQS);
    expect(orphaned.unmapped).toEqual(['R1']);

    const rewired = withReqs([
      buildTicket({ id: 'T001', satisfies: ['R1'], status: 'decomposed' }),
      buildTicket({ id: 'T002', satisfies: ['R1'] }),
      buildTicket({ id: 'T003', satisfies: ['R2'] }),
    ], REQS);
    expect(rewired.unmapped).toEqual([]);
  });

  test('a parked ticket still holds its claim — parked is unfinished, not gone', () => {
    const cov = withReqs([
      buildTicket({ id: 'T001', satisfies: ['R1'], status: 'parked' }),
      buildTicket({ id: 'T002', satisfies: ['R2'], status: 'closed' }),
    ], REQS);
    expect(cov.unmapped).toEqual([]);
    expect(cov.proven).toEqual(['R2']);
  });

  test('a campaign with no enumeration reports nothing rather than everything', () => {
    const cov = withReqs([buildTicket({ id: 'T001', status: 'closed' })], []);
    expect(cov).toEqual({ requirements: 0, unmapped: [], proven: [] });
  });

  test('a ticket claiming nothing does not disturb the count', () => {
    const cov = withReqs([
      buildTicket({ id: 'T001', satisfies: ['R1', 'R2'], status: 'closed' }),
      buildTicket({ id: 'T002' }), // scaffolding
    ], REQS);
    expect(cov.proven).toEqual(['R1', 'R2']);
  });
});

// `idle` names the stalled-coordinator shape: work available, nothing running,
// every other reading healthy. Its mirror (nothing dispatchable, nothing moving)
// belongs to recover(`stalled`) and must NOT trip this flag.
describe('idle', () => {
  test('dispatchable work with nothing in flight is idle', () => {
    const f = onScratch([buildTicket({ id: 'T001' })], NO_WALLS);
    expect(f.dispatchable).toEqual(['T001']);
    expect(f.idle).toBe(true);
  });

  test('a live worker clears it — serial dispatch offers nothing while one runs', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', status: 'in-flight' }),
      buildTicket({ id: 'T002' }),
    ], NO_WALLS);
    expect(f.dispatchable).toEqual([]);
    expect(f.idle).toBe(false);
  });

  test('nothing dispatchable is not idle — that is recover(stalled), not this', () => {
    const f = onScratch([
      buildTicket({ id: 'T001', status: 'closed' }),
      buildTicket({ id: 'T002', depends_on: ['T003'] }),
      buildTicket({ id: 'T003', status: 'in-flight' }),
    ], NO_WALLS);
    expect(f.dispatchable).toEqual([]);
    expect(f.idle).toBe(false);
  });
});

// The sweep trigger. A milestone is the spec's own claim that a coherent slice
// of the product now exists — the moment worth reflecting at, and the only one:
// there is no count-based fallback to paper over a spec that named none.
describe('sweepDue', () => {
  const REQS = [{ id: 'R1', clause: 'a' }, { id: 'R2', clause: 'b' }, { id: 'R3', clause: 'c' }];
  const M1 = { id: 'M1', name: 'auth works', delivers: ['R1', 'R2'] };
  const M2 = { id: 'M2', name: 'data layer', delivers: ['R3'] };

  const withMilestones = (
    tickets: Ticket[],
    milestones: { id: string; name: string; delivers: string[] }[],
    sweep?: { milestones: string[] },
  ) => {
    let f!: ReturnType<typeof frontier>;
    withScratchCampaign(
      { backlog: { tickets, requirements: REQS, milestones, caps: NO_WALLS, ...(sweep ? { sweep } : {}) } },
      () => { f = frontier(); });
    return f.sweepDue;
  };

  const closed = (id: string, satisfies: string[]) => buildTicket({ id, satisfies, status: 'closed' });

  test('a milestone whose every clause is proven is due', () => {
    expect(withMilestones([closed('T001', ['R1']), closed('T002', ['R2'])], [M1, M2])).toBe('M1');
  });

  test('one clause short is not a checkpoint, however many tickets landed', () => {
    expect(withMilestones([
      closed('T001', ['R1']),
      buildTicket({ id: 'T002', satisfies: ['R2'] }),
      closed('T003', ['R3']),
    ], [M1])).toBe(null);
  });

  // Reaching a milestone is permanent — proven clauses never un-prove — so the
  // spend is the only thing that can stop it triggering on every later pass.
  test('a swept milestone does not re-trigger', () => {
    const tickets = [closed('T001', ['R1']), closed('T002', ['R2'])];
    expect(withMilestones(tickets, [M1], { milestones: ['M1'] })).toBe(null);
  });

  test('the earliest unspent milestone is reported — two arriving together are two moments', () => {
    const tickets = [closed('T001', ['R1']), closed('T002', ['R2']), closed('T003', ['R3'])];
    expect(withMilestones(tickets, [M1, M2])).toBe('M1');
    expect(withMilestones(tickets, [M1, M2], { milestones: ['M1'] })).toBe('M2');
  });

  // Stronger than "its tickets closed": the milestone cannot arrive over a gap
  // in its own coverage, because a slice with an unclaimed clause is not a slice.
  test('an unclaimed clause holds the milestone back, with no ticket to point at', () => {
    expect(withMilestones([closed('T001', ['R1'])], [M1])).toBe(null);
  });

  test('a spec that declared no milestones never falls due — closes alone are not a moment', () => {
    const many = ['T001', 'T002', 'T003', 'T004', 'T005'].map(id => closed(id, ['R1']));
    expect(withMilestones(many, [])).toBe(null);
  });
});
