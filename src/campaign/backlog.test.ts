// The sole writer — the single guard on every campaign state change, and the
// only thing standing between a confused agent and a corrupt backlog. Two
// halves: the campaign-level fields the coordinator reads straight off the
// backlog (gate verdict, park latch, dispatch base), and the per-ticket
// transition rules every arm of the drive rides. Each case drives the real
// `backlogWrite` against a scratch campaign and reads the resulting file back.
//
// A refusal is asserted for its message AND, where the command mutates more
// than one thing, for leaving no residue — a half-applied refusal is the
// failure mode that would be invisible in production.

import fs from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { backlog, backlogWrite } from './backlog.ts';
import type { Backlog } from './backlog.ts';
import { buildTicket, withScratchCampaign } from './scratch-campaign.ts';

const afterWrites = (seed: Partial<Backlog>, writes: () => void): Backlog => {
  let out!: Backlog;
  withScratchCampaign({ backlog: seed }, () => { writes(); out = backlog(); });
  return out;
};

const GATE = [{ name: 'e2e', cmd: 'bun test:e2e' }];

describe('gate-run', () => {
  test('a run stamps the verdict and the counts it measured', () => {
    const b = afterWrites({
      tickets: [
        buildTicket({ id: 'T001', status: 'closed' }),
        buildTicket({ id: 'T002', status: 'closed' }),
        buildTicket({ id: 'T003', status: 'open' }),
      ],
      gate: GATE,
    }, () => { backlogWrite(['gate-run', 'green', '--note', 'gate green: [e2e]']); });
    expect(b.gateState?.lastRun).toEqual({ result: 'green', tickets: 3, closed: 2 });
  });

  test('a later run overwrites the earlier verdict', () => {
    const b = afterWrites({ tickets: [], gate: GATE }, () => {
      backlogWrite(['gate-run', 'green', '--note', 'gate green: [e2e]']);
      backlogWrite(['gate-run', 'red', '--note', 'gate red: [e2e]']);
    });
    expect(b.gateState?.lastRun?.result).toBe('red');
  });

  test('only green and red are verdicts, and the note is mandatory', () => {
    withScratchCampaign({ backlog: { tickets: [], gate: GATE } }, () => {
      expect(() => backlogWrite(['gate-run', 'amber', '--note', 'n'])).toThrow(/green \| red/);
      expect(() => backlogWrite(['gate-run', 'green'])).toThrow(/requires --note/);
    });
  });
});

describe('the gate park latch', () => {
  test('gate-park records the reason the human has to answer', () => {
    const b = afterWrites({ tickets: [], gate: GATE }, () => {
      backlogWrite(['gate-park', '--reason', 'e2e red against a spec clause nobody owns']);
    });
    expect(b.gateState?.parked?.reason).toBe('e2e red against a spec clause nobody owns');
  });

  test('gate-park without a reason is refused — the reason IS the record', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      expect(() => backlogWrite(['gate-park'])).toThrow(/requires --reason/);
    });
  });

  test('an amendment claiming the authority releases the latch — the answer to the park', () => {
    const b = afterWrites({ tickets: [], gate: [] }, () => {
      backlogWrite(['gate-park', '--reason', 'recover out of jurisdiction']);
      backlogWrite(['gate', '-', '--note', 'narrowed to the suite it should own', '--release-latch'], GATE);
    });
    expect(b.gateState?.parked).toBeUndefined();
    expect(b.gate).toEqual(GATE);
  });

  test('an amendment that does not claim it leaves the latch — adding a check is not answering the human', () => {
    const b = afterWrites({ tickets: [], gate: [] }, () => {
      backlogWrite(['gate-park', '--reason', 'e2e red against a spec clause nobody owns']);
      backlogWrite(['gate', '-', '--note', 'sweep: merged-tree invariant nothing owns'], GATE);
    });
    expect(b.gateState?.parked?.reason).toBe('e2e red against a spec clause nobody owns');
    expect(b.gate).toEqual(GATE); // the edit still landed
  });

  test('a park after an amendment latches again', () => {
    const b = afterWrites({ tickets: [], gate: [] }, () => {
      backlogWrite(['gate-park', '--reason', 'first']);
      backlogWrite(['gate', '-', '--note', 'amended', '--release-latch'], GATE);
      backlogWrite(['gate-park', '--reason', 'second']);
    });
    expect(b.gateState?.parked?.reason).toBe('second');
  });

  test('a gate run never touches the latch — only an amendment answers a park', () => {
    const b = afterWrites({ tickets: [], gate: GATE }, () => {
      backlogWrite(['gate-park', '--reason', 'held for a human']);
      backlogWrite(['gate-run', 'green', '--note', 'gate green: [e2e]']);
    });
    expect(b.gateState?.parked?.reason).toBe('held for a human');
  });
});

describe('the dispatch base sha', () => {
  const dispatched = (id: string, sha: string) =>
    backlogWrite(['set-status', id, 'in-flight', '--note', `dispatched on loop/${id}`, '--base-sha', sha]);

  test('a dispatch stamps the base its worktree was cut from', () => {
    const b = afterWrites({ tickets: [buildTicket({ id: 'T001' })] },
      () => { dispatched('T001', 'abc1234'); });
    expect(b.tickets[0]!.baseSha).toBe('abc1234');
  });

  test('the in-flight round trip a check amendment makes preserves it', () => {
    // reviewReturn's amend-typo path: in-flight → open (to patch the checks) →
    // in-flight, all against the same worktree. Nothing was re-cut, so the
    // original base must survive to be re-verified against.
    const b = afterWrites({ tickets: [buildTicket({ id: 'T001' })] }, () => {
      dispatched('T001', 'abc1234');
      backlogWrite(['set-status', 'T001', 'open', '--note', 'check amendment']);
      backlogWrite(['set-status', 'T001', 'in-flight', '--note', 're-verify after typo amendment']);
    });
    expect(b.tickets[0]!.baseSha).toBe('abc1234');
  });

  test('a re-dispatch overwrites it — the new worktree has a new base', () => {
    const b = afterWrites({ tickets: [buildTicket({ id: 'T001' })] }, () => {
      dispatched('T001', 'abc1234');
      backlogWrite(['set-status', 'T001', 'open', '--note', 'attempt failed']);
      dispatched('T001', 'def5678');
    });
    expect(b.tickets[0]!.baseSha).toBe('def5678');
  });

  test('only a dispatch carries a base — any other transition is refused', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })] } }, () => {
      expect(() => backlogWrite(['set-status', 'T001', 'parked', '--base-sha', 'abc1234']))
        .toThrow(/only legal on → in-flight/);
      // …and the refusal is total: the illegal write left no residue.
      expect(backlog().tickets[0]!.baseSha).toBeUndefined();
    });
  });
});

// --- the transition table --------------------------------------------------

// `close` demands an evidence file that exists; the scratch campaign is the cwd,
// so a real one is written beside it.
const withEvidence = (name = 'evidence.txt'): string => (fs.writeFileSync(name, 'independent re-verify output'), name);

describe('the transition table', () => {
  test('the dispatch round trip is legal in both directions', () => {
    const b = afterWrites({ tickets: [buildTicket({ id: 'T001' })] }, () => {
      backlogWrite(['set-status', 'T001', 'in-flight', '--note', 'dispatched']);
      backlogWrite(['set-status', 'T001', 'open', '--note', 'attempt failed']);
    });
    expect(b.tickets[0]!.status).toBe('open');
  });

  test('a park is reachable from open and in-flight, and releases only to open', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })] } }, () => {
      backlogWrite(['set-status', 'T001', 'parked', '--note', 'human call']);
      expect(() => backlogWrite(['set-status', 'T001', 'in-flight', '--note', 'go']))
        .toThrow(/illegal transition T001: parked → in-flight/);
      backlogWrite(['set-status', 'T001', 'open', '--note', 'human answered']);
      expect(backlog().tickets[0]!.status).toBe('open');
    });
  });

  test('closed is terminal — nothing reopens delivered work', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001', status: 'in-flight' })] } }, () => {
      backlogWrite(['close', 'T001', '--evidence', withEvidence()]);
      for (const to of ['open', 'in-flight', 'parked']) {
        expect(() => backlogWrite(['set-status', 'T001', to, '--note', 'reopen'])).toThrow(/illegal transition/);
      }
      expect(backlog().tickets[0]!.status).toBe('closed');
    });
  });

  test('the two terminal states are reachable only through their own commands', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001', status: 'in-flight' })] } }, () => {
      expect(() => backlogWrite(['set-status', 'T001', 'closed'])).toThrow(/use the close command/);
      expect(() => backlogWrite(['set-status', 'T001', 'decomposed'])).toThrow(/use the decompose command/);
      expect(backlog().tickets[0]!.status).toBe('in-flight');
    });
  });

  test('a status outside the vocabulary is refused before any transition check', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })] } }, () => {
      expect(() => backlogWrite(['set-status', 'T001', 'done'])).toThrow(/unknown status done/);
    });
  });
});

describe('close', () => {
  test('evidence is mandatory and must exist — a close is a claim about a file', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001', status: 'in-flight' })] } }, () => {
      expect(() => backlogWrite(['close', 'T001'])).toThrow(/requires --evidence/);
      expect(() => backlogWrite(['close', 'T001', '--evidence', 'nowhere.txt'])).toThrow(/evidence file not found/);
      expect(backlog().tickets[0]!.status).toBe('in-flight');
    });
  });

  test('a close records the path the verdict rests on', () => {
    const b = afterWrites({ tickets: [buildTicket({ id: 'T001', status: 'in-flight' })] }, () => {
      backlogWrite(['close', 'T001', '--evidence', withEvidence('T001.txt'), '--note', 'judged close']);
    });
    expect(b.tickets[0]).toMatchObject({ status: 'closed', evidence: 'T001.txt' });
  });
});

describe('decompose', () => {
  const CHILDREN = [
    buildTicket({ id: 'T003', title: 'first half' }),
    buildTicket({ id: 'T004', title: 'second half' }),
  ];
  // A parent, a live dependent, and a dependent already delivered against it.
  const seed = () => ({
    tickets: [
      buildTicket({ id: 'T001' }),
      buildTicket({ id: 'T002', depends_on: ['T001'] }),
      buildTicket({ id: 'T005', depends_on: ['T001'], status: 'closed' }),
    ],
  });

  test('the parent retires and its children arrive open', () => {
    const b = afterWrites(seed(), () => { backlogWrite(['decompose', 'T001', '-'], CHILDREN); });
    expect(b.tickets.find(t => t.id === 'T001')!.status).toBe('decomposed');
    expect(b.tickets.filter(t => ['T003', 'T004'].includes(t.id)).map(t => t.status)).toEqual(['open', 'open']);
  });

  test('a child must carry its own provenance — none is inherited', () => {
    // Callers stamp the origin (drive's tooBig path names the parent); the
    // writer refuses rather than inventing one, like every other required field.
    withScratchCampaign({ backlog: seed() }, () => {
      expect(() => backlogWrite(['decompose', 'T001', '-'], [{ ...CHILDREN[0]!, origin: undefined }]))
        .toThrow(/missing origin/);
    });
  });

  test('live dependents rewire onto every child — never left stranded on the parent', () => {
    const b = afterWrites(seed(), () => { backlogWrite(['decompose', 'T001', '-'], CHILDREN); });
    expect(b.tickets.find(t => t.id === 'T002')!.depends_on).toEqual(['T003', 'T004']);
  });

  test('a closed dependent keeps its history — it was delivered against the parent', () => {
    const b = afterWrites(seed(), () => { backlogWrite(['decompose', 'T001', '-'], CHILDREN); });
    expect(b.tickets.find(t => t.id === 'T005')!.depends_on).toEqual(['T001']);
  });

  test('a split with no children, or with an invalid one, leaves the parent whole', () => {
    withScratchCampaign({ backlog: seed() }, () => {
      expect(() => backlogWrite(['decompose', 'T001', '-'], [])).toThrow(/requires child tickets/);
      expect(() => backlogWrite(['decompose', 'T001', '-'], [{ ...CHILDREN[0]!, acceptanceChecks: [] }]))
        .toThrow(/acceptanceChecks must be a non-empty array/);
      expect(backlog().tickets.find(t => t.id === 'T001')!.status).toBe('open');
      expect(backlog().tickets).toHaveLength(3); // no child slipped in beside the refusal
    });
  });

  test('a child reusing a live id is refused — decompose cannot overwrite a ticket', () => {
    withScratchCampaign({ backlog: seed() }, () => {
      expect(() => backlogWrite(['decompose', 'T001', '-'], [buildTicket({ id: 'T002' })]))
        .toThrow(/duplicate id: T002/);
    });
  });
});

describe('update', () => {
  test('only an open ticket takes a patch — in-flight work must not diverge from its contract', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001', status: 'in-flight' })] } }, () => {
      expect(() => backlogWrite(['update', 'T001', '-'], { title: 'new' })).toThrow(/only open tickets can be updated/);
    });
  });

  test('the mutable set is closed — identity and history are not patchable', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })] } }, () => {
      for (const patch of [{ id: 'T009' }, { origin: 'rewritten' }, { status: 'closed' }, { attempts: [] }, { evidence: 'x' }]) {
        expect(() => backlogWrite(['update', 'T001', '-'], patch)).toThrow(/immutable or unknown field/);
      }
      expect(backlog().tickets[0]!.id).toBe('T001');
    });
  });

  test('a patch that would leave the ticket invalid is refused whole', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })] } }, () => {
      expect(() => backlogWrite(['update', 'T001', '-'], { acceptance: '', context: 'too thin' }))
        .toThrow(/patch leaves T001 invalid/);
      // Neither field landed: the ticket still has the contract it started with.
      expect(backlog().tickets[0]!.acceptance).toBe('the check passes');
      expect(backlog().tickets[0]!.context).toMatch(/40-char floor/);
    });
  });

  test('attempts survive a patch by default and clear only when the contract changed', () => {
    const attempts = [{ failed: ['unit'], hypothesis: 'wrong boundary' }];
    const kept = afterWrites({ tickets: [buildTicket({ id: 'T001', attempts })] },
      () => { backlogWrite(['update', 'T001', '-', '--note', 'sharpen'], { acceptanceChecks: [{ name: 'unit', cmd: 'false' }] }); });
    expect(kept.tickets[0]!.attempts).toHaveLength(1);

    const reset = afterWrites({ tickets: [buildTicket({ id: 'T001', attempts })] },
      () => { backlogWrite(['update', 'T001', '-', '--reset-attempts', '--note', 'contract changed'], { acceptance: 'something else entirely' }); });
    expect(reset.tickets[0]!.attempts).toEqual([]);
  });
});

describe('add', () => {
  test('a new ticket arrives open with its collections initialised', () => {
    const b = afterWrites({ tickets: [] }, () => { backlogWrite(['add', '-'], [buildTicket({ id: 'T001' })]); });
    expect(b.tickets[0]).toMatchObject({ status: 'open', depends_on: [], resources: [], attempts: [], evidence: null });
  });

  test('a duplicate id is refused, and the batch it rode in on lands nothing', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })] } }, () => {
      expect(() => backlogWrite(['add', '-'], [buildTicket({ id: 'T002' }), buildTicket({ id: 'T001' })]))
        .toThrow(/duplicate id: T001/);
      expect(backlog().tickets).toHaveLength(1); // T002 did not slip in beside the refusal
    });
  });

  test('every under-specification is reported at once, not one per round trip', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      let message = '';
      try {
        backlogWrite(['add', '-'], [{ id: 'T001', title: 'thin', modules: ['src/a'], origin: 'spec §1' }]);
      } catch (e: any) { message = e.message; }
      expect(message).toMatch(/context too thin/);
      expect(message).toMatch(/missing acceptance/);
      expect(message).toMatch(/acceptanceChecks must be a non-empty array/);
    });
  });

  test('a malformed id is refused — the coordinator owns the numbering', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      expect(() => backlogWrite(['add', '-'], [buildTicket({ id: 'ticket-one' })])).toThrow(/bad or missing id/);
    });
  });
});

describe('attempt', () => {
  test('a failed attempt numbers itself and puts the ticket back in the queue', () => {
    const b = afterWrites({ tickets: [buildTicket({ id: 'T001', status: 'in-flight' })] }, () => {
      backlogWrite(['attempt', 'T001', '--failed', 'unit,scope', '--hypothesis', 'wrong boundary', '--fix', 'try the seam']);
    });
    expect(b.tickets[0]!.status).toBe('open');
    expect(b.tickets[0]!.attempts).toEqual([expect.objectContaining({
      n: 1, failed: ['unit', 'scope'], hypothesis: 'wrong boundary', fixNote: 'try the seam',
    })]);
  });

  test('an infra attempt is marked as such — the merit wall must not count it', () => {
    const b = afterWrites({ tickets: [buildTicket({ id: 'T001', status: 'in-flight' })] }, () => {
      backlogWrite(['attempt', 'T001', '--failed', 'worker-channel', '--infra', '--hypothesis', 'session died']);
    });
    expect(b.tickets[0]!.attempts![0]).toMatchObject({ infra: true });
  });

  test('an attempt without its failing set or its hypothesis is refused — both are the record', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001', status: 'in-flight' })] } }, () => {
      expect(() => backlogWrite(['attempt', 'T001', '--hypothesis', 'h'])).toThrow(/requires --failed/);
      expect(() => backlogWrite(['attempt', 'T001', '--failed', 'unit'])).toThrow(/requires --hypothesis/);
      expect(backlog().tickets[0]!.status).toBe('in-flight');
    });
  });
});

// The enumeration is the join key between the spec and the backlog. A claim on
// an id that does not exist would leave the frontier reporting the clause as
// unmapped while the ticket reads as covering it — a disagreement no arm would
// ever voice, so the sole writer refuses it at the door.
describe('requirement claims', () => {
  const REQS = [{ id: 'R1', clause: 'tokens expire' }, { id: 'R2', clause: 'refresh rotates' }];

  test('seed stores the enumeration', () => {
    const b = afterWrites({ tickets: [] }, () => {
      backlogWrite(['seed', '-'], { requirements: REQS });
    });
    expect(b.requirements).toEqual(REQS);
  });

  test('seed refuses a duplicate requirement id — a corrupt join key, not a typo', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      expect(() => backlogWrite(['seed', '-'], {
        requirements: [{ id: 'R1', clause: 'a' }, { id: 'R1', clause: 'b' }],
      })).toThrow(/duplicate requirement id: R1/);
    });
  });

  test('seed refuses a requirement missing its clause', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      expect(() => backlogWrite(['seed', '-'], { requirements: [{ id: 'R1' }] }))
        .toThrow(/requirement needs id and clause/);
    });
  });

  test('a ticket may claim an enumerated requirement', () => {
    const b = afterWrites({ tickets: [], requirements: REQS }, () => {
      backlogWrite(['add', '-'], [buildTicket({ id: 'T001', satisfies: ['R1', 'R2'] })]);
    });
    expect(b.tickets[0]!.satisfies).toEqual(['R1', 'R2']);
  });

  test('a ticket claiming an unknown requirement is refused, and lands nothing', () => {
    withScratchCampaign({ backlog: { tickets: [], requirements: REQS } }, () => {
      expect(() => backlogWrite(['add', '-'], [buildTicket({ id: 'T001', satisfies: ['R9'] })]))
        .toThrow(/satisfies unknown requirement "R9"/);
      expect(backlog().tickets).toEqual([]);
    });
  });

  test('a decomposition child claiming an unknown requirement is refused too', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })], requirements: REQS } }, () => {
      expect(() => backlogWrite(['decompose', 'T001', '-', '--note', 'split'],
        [buildTicket({ id: 'T002', satisfies: ['nope'] })])).toThrow(/satisfies unknown requirement/);
      expect(backlog().tickets.map(t => t.status)).toEqual(['open']); // parent untouched
    });
  });

  test('a claim survives an update — the patch cannot reach it', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001', satisfies: ['R1'] })], requirements: REQS } }, () => {
      expect(() => backlogWrite(['update', 'T001', '-', '--note', 'rewire'], { satisfies: [] }))
        .toThrow(/immutable or unknown field/);
      expect(backlog().tickets[0]!.satisfies).toEqual(['R1']);
    });
  });
});
