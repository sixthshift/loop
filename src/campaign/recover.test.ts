// The two things the coordinator keeps for itself when it applies a recover
// verdict. `renumber` takes id allocation back from the agent: proposed ids are
// placeholders, and any edge between two proposals has to follow its endpoints
// to the ids actually allocated. `gateAuthority` takes the right to replace a
// live gate command, granting it by the anomaly the seat was opened for.

import { describe, expect, test } from 'bun:test';
import { gateAuthority, priorRecoveries, recoverKey, renumber } from './recover.ts';
import { GATE_RED } from './gate.ts';
import { buildEntry, buildTicket, withScratchCampaign } from './scratch-campaign.ts';
import type { Ticket } from './backlog.ts';

const onScratch = (existing: Ticket[], drafts: Ticket[]) => {
  let out!: ReturnType<typeof renumber>;
  withScratchCampaign({ backlog: { tickets: existing } }, () => { out = renumber(drafts); });
  return out.map(t => ({ id: t.id, depends_on: t.depends_on }));
};

describe('renumber', () => {
  test('an edge onto a sibling draft follows that sibling to its allocated id', () => {
    const out = onScratch(
      [buildTicket({ id: 'T001' }), buildTicket({ id: 'T002' })],
      [
        buildTicket({ id: 'T900' }),
        buildTicket({ id: 'T901', depends_on: ['T900'] }),
      ],
    );
    expect(out).toEqual([
      { id: 'T003', depends_on: [] },
      { id: 'T004', depends_on: ['T003'] },
    ]);
  });

  test('a chain of sibling edges survives, including a forward reference', () => {
    const out = onScratch(
      [buildTicket({ id: 'T001' })],
      [
        buildTicket({ id: 'A', depends_on: ['B'] }),   // points at a later sibling
        buildTicket({ id: 'B', depends_on: ['C'] }),
        buildTicket({ id: 'C' }),
      ],
    );
    expect(out).toEqual([
      { id: 'T002', depends_on: ['T003'] },
      { id: 'T003', depends_on: ['T004'] },
      { id: 'T004', depends_on: [] },
    ]);
  });

  test('an edge onto a ticket already in the backlog is left alone', () => {
    const out = onScratch(
      [buildTicket({ id: 'T001' })],
      [buildTicket({ id: 'T900', depends_on: ['T001'] })],
    );
    expect(out).toEqual([{ id: 'T002', depends_on: ['T001'] }]);
  });

  test('allocation fills gaps left by the ids in use', () => {
    const out = onScratch(
      [buildTicket({ id: 'T001' }), buildTicket({ id: 'T003' })],
      [buildTicket({ id: 'X' }), buildTicket({ id: 'Y' }), buildTicket({ id: 'Z' })],
    );
    expect(out.map(t => t.id)).toEqual(['T002', 'T004', 'T005']);
  });

  // A draft may propose an id that a live ticket already holds, which makes an
  // edge on that id ambiguous — sibling placeholder or real dependency? The remap
  // is consulted first, so the sibling reading wins and the edge becomes a
  // self-dependency the frontier will report as a cycle. Pinned as behaviour, not
  // endorsed: the alternative (prefer the live ticket) is equally guessable, and
  // only the agent's intent settles it.
  test('a draft proposing a live id resolves its own edge to itself', () => {
    const out = onScratch(
      [buildTicket({ id: 'T001' })],
      [buildTicket({ id: 'T001', depends_on: ['T001'] })],
    );
    expect(out).toEqual([{ id: 'T002', depends_on: ['T002'] }]);
  });

  test('nothing proposed allocates nothing', () => {
    expect(onScratch([buildTicket({ id: 'T001' })], [])).toEqual([]);
  });
});

// Recover is fresh-context every time, so it cannot notice that it has answered
// this exact anomaly before. The budget is the coordinator's memory on its
// behalf, and it is keyed by what "the same anomaly" means for that kind.
describe('the recover budget', () => {
  const recovered = (key: string, body = 'fixed it') =>
    buildEntry({ kind: 'recovered', subject: key.split(':')[0], body, data: { key } });

  const spent = (journal: ReturnType<typeof buildEntry>[], key: string) => {
    let n = 0;
    withScratchCampaign({ journal }, () => { n = priorRecoveries(key).length; });
    return n;
  };

  test('a ticket-scoped anomaly is budgeted per ticket, so two tickets walling once each is not a pattern', () => {
    expect(recoverKey({ kind: 'attempt-wall', ticketId: 'T007' })).toBe('attempt-wall:T007');
    const journal = [recovered('attempt-wall:T007'), recovered('attempt-wall:T009')];
    expect(spent(journal, 'attempt-wall:T007')).toBe(1);
  });

  test('a campaign-scoped anomaly is budgeted per campaign', () => {
    expect(recoverKey({ kind: GATE_RED, results: [] })).toBe(GATE_RED);
    expect(spent([recovered(GATE_RED), recovered(GATE_RED)], GATE_RED)).toBe(2);
  });

  test('only resolutions count — an unresolved recover parked, and nothing re-arms a park', () => {
    const journal = [
      recovered(GATE_RED),
      buildEntry({ kind: 'parked', subject: 'campaign-gate', body: 'gave up' }),
      buildEntry({ kind: 'recover-refused', subject: 'gate', body: 'illegal action' }),
    ];
    expect(spent(journal, GATE_RED)).toBe(1);
  });

  test('the prior fixes are returned, not just counted — they are the evidence a park cites', () => {
    let bodies: (string | undefined)[] = [];
    withScratchCampaign({ journal: [recovered(GATE_RED, 'narrowed the e2e gate'), recovered(GATE_RED, 'narrowed it again')] }, () => {
      bodies = priorRecoveries(GATE_RED).map(e => e.body);
    });
    expect(bodies).toEqual(['narrowed the e2e gate', 'narrowed it again']);
  });
});

// One recover seat serves every anomaly, but only one of them arrives holding a
// gate's own failure. The authority to replace a live gate command tracks that
// distinction rather than the seat.
describe('gateAuthority', () => {
  test('the gate\'s own red run may replace the command that produced it', () => {
    expect(gateAuthority({ kind: GATE_RED, results: [] })).toBe('apply');
  });

  test('every other anomaly reaches recover without having run the gate, so it may only add', () => {
    for (const kind of ['stalled', 'attempt-wall', 'dirty-mainline', 'worker-blocked', 'coordinator-error']) {
      expect(gateAuthority({ kind })).toBe('refuse');
    }
  });

  test('a kind that merely mentions the gate is not the gate anomaly', () => {
    expect(gateAuthority({ kind: 'gate-red' })).toBe('refuse');
  });
});
