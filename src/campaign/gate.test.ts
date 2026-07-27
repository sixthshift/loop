// The gate amendment split: an addition is coverage, a same-name upsert is a
// swap of the command currently deciding correctness. Each case drives the real
// `amendGate` against a scratch campaign and reads back both halves of the
// record — the gate in force, and the journal entry that has to survive into the
// post-mortem.

import { describe, expect, test } from 'bun:test';
import { amendGate, classifyGateEdit } from './gate.ts';
import { backlog, backlogWrite } from './backlog.ts';
import { journalEntries } from './journal.ts';
import { withScratchCampaign } from './scratch-campaign.ts';
import type { Check } from '../agent/schemas.ts';

const E2E = { name: 'e2e', cmd: 'bun test:e2e' };

const amend = (inForce: Check[], proposed: Check[], replacements: 'apply' | 'refuse') => {
  let out!: { gate: Check[]; kinds: { kind: string; body: string }[]; returned: string };
  withScratchCampaign({ backlog: { tickets: [], gate: inForce }, journal: [] }, () => {
    const returned = amendGate(proposed, { by: 'recover(campaign-gate-red)', note: 'why', replacements });
    out = {
      gate: backlog().gate ?? [],
      kinds: journalEntries().map(e => ({ kind: e.kind, body: e.body ?? '' })),
      returned,
    };
  });
  return out;
};

describe('classifyGateEdit', () => {
  test('a name not in force is an addition; a changed cmd under a live name is a replacement', () => {
    withScratchCampaign({ backlog: { tickets: [], gate: [E2E] } }, () => {
      const edit = classifyGateEdit([{ name: 'lint', cmd: 'bun run lint' }, { name: 'e2e', cmd: 'bun test:e2e --only smoke' }]);
      expect(edit.added).toEqual([{ name: 'lint', cmd: 'bun run lint' }]);
      expect(edit.replaced).toEqual([{ gate: { name: 'e2e', cmd: 'bun test:e2e --only smoke' }, was: 'bun test:e2e' }]);
    });
  });

  test('re-proposing the gate in force is neither act', () => {
    withScratchCampaign({ backlog: { tickets: [], gate: [E2E] } }, () => {
      expect(classifyGateEdit([E2E])).toEqual({ added: [], replaced: [] });
    });
  });

  test('a gate is classified by name, not by whether the command looks stronger', () => {
    withScratchCampaign({ backlog: { tickets: [], gate: [E2E] } }, () => {
      // Superset command, same name — still a replacement, because no string
      // comparison can prove it is one.
      expect(classifyGateEdit([{ name: 'e2e', cmd: 'bun test:e2e && bun run lint' }]).replaced).toHaveLength(1);
    });
  });
});

describe('amendGate under an arm that may replace', () => {
  test('an addition applies with no audit entry of its own', () => {
    const out = amend([E2E], [{ name: 'lint', cmd: 'bun run lint' }], 'apply');
    expect(out.gate).toEqual([E2E, { name: 'lint', cmd: 'bun run lint' }]);
    expect(out.kinds.map(k => k.kind)).toEqual(['gate-amendment']);
  });

  test('a replacement applies, but lands under gate-replaced carrying the command it displaced', () => {
    const out = amend([E2E], [{ name: 'e2e', cmd: 'bun test:e2e --only smoke' }], 'apply');
    expect(out.gate).toEqual([{ name: 'e2e', cmd: 'bun test:e2e --only smoke' }]);
    const audit = out.kinds.find(k => k.kind === 'gate-replaced');
    expect(audit?.body).toContain('was: bun test:e2e');
    expect(audit?.body).toContain('now: bun test:e2e --only smoke');
    // Journaled BEFORE the amendment, so a refused write leaves the record.
    expect(out.kinds.map(k => k.kind)).toEqual(['gate-replaced', 'gate-amendment']);
  });
});

describe('the park latch', () => {
  const latchAfter = (replacements: 'apply' | 'refuse') => {
    let parked: unknown;
    withScratchCampaign({ backlog: { tickets: [], gate: [E2E] } }, () => {
      backlogWrite(['gate-park', '--reason', 'held for a human']);
      amendGate([{ name: 'lint', cmd: 'bun run lint' }], { by: 'x', note: 'why', replacements });
      parked = backlog().gateState?.parked;
    });
    return parked;
  };

  test('the arm answering the red gate releases it', () => {
    expect(latchAfter('apply')).toBeUndefined();
  });

  test('an advisory addition leaves the human holding it', () => {
    expect(latchAfter('refuse')).toEqual({ reason: 'held for a human' });
  });
});

describe('amendGate under an arm that may not replace', () => {
  test('the addition still lands and the replacement is dropped on the record', () => {
    const out = amend(
      [E2E],
      [{ name: 'lint', cmd: 'bun run lint' }, { name: 'e2e', cmd: 'bun test:e2e --only smoke' }],
      'refuse',
    );
    expect(out.gate).toEqual([E2E, { name: 'lint', cmd: 'bun run lint' }]);
    expect(out.kinds.map(k => k.kind)).toEqual(['gate-refused', 'gate-amendment']);
    expect(out.returned).toBe('gate [+lint, ✗e2e]');
  });

  test('a refused-only proposal touches neither the gate nor the amendment log', () => {
    const out = amend([E2E], [{ name: 'e2e', cmd: 'true' }], 'refuse');
    expect(out.gate).toEqual([E2E]);
    expect(out.kinds.map(k => k.kind)).toEqual(['gate-refused']);
    expect(out.returned).toBe('gate [✗e2e]');
  });
});
