// `renumber` takes the coordinator's side of id allocation back from the agent:
// proposed ids are placeholders, and any edge between two proposals has to
// follow its endpoints to the ids actually allocated.

import { describe, expect, test } from 'bun:test';
import { renumber } from './recover.ts';
import { buildTicket, withScratchCampaign } from './scratch-campaign.ts';
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
