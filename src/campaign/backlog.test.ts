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
import { backlog, backlogWrite, wantsStdinPayload } from './backlog.ts';
import type { Backlog } from './backlog.ts';
import { journalEntries } from './journal.ts';
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
    expect(b.gateState?.lastRun).toEqual({
      result: 'green',
      tickets: 3,
      closed: 2,
      evidence: 'gate green: [e2e]',
    });
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
    expect(b.tickets[0]).toMatchObject({ status: 'open', depends_on: [], attempts: [], evidence: null });
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

describe('persistent coordinator state', () => {
  test('init stores the locked contract in the backlog, not only the kickoff audit', () => {
    let b!: Backlog;
    withScratchCampaign({}, () => {
      backlogWrite([
        'init',
        '--project', 'example',
        '--mainline', 'main',
        '--spec-path', 'spec.md',
        '--spec-sha', 'abc123',
      ]);
      b = backlog();
    });
    expect(b.contract).toEqual({ specPath: 'spec.md', sha256: 'abc123' });
  });

  test('a recover resolution persists its budget and evidence summary', () => {
    const b = afterWrites({ tickets: [] }, () => {
      backlogWrite(['recover-resolution', '--key', 'attempt-wall:T001',
        '--subject', 'attempt-wall', '--body', 'corrected the ticket contract']);
    });
    expect(b.recoveries?.['attempt-wall:T001']).toEqual({
      count: 1,
      summaries: ['corrected the ticket contract'],
    });
  });

  test('a parked ticket carries the human-facing reason in backlog state', () => {
    const b = afterWrites({
      tickets: [buildTicket({ id: 'T001' })],
    }, () => {
      backlogWrite(['set-status', 'T001', 'parked', '--note', 'scope decision needed']);
    });
    expect(b.tickets[0]!.parkReason).toBe('scope decision needed');
  });

  test('an unavailable audit sink cannot roll back a state transition', () => {
    let b!: Backlog;
    withScratchCampaign({
      backlog: { tickets: [buildTicket({ id: 'T001' })] },
      journal: [],
    }, () => {
      const audit = '.ailoop/campaign/journal.jsonl';
      fs.rmSync(audit);
      fs.mkdirSync(audit);
      const report = console.error;
      console.error = () => {};
      try {
        backlogWrite(['set-status', 'T001', 'in-flight', '--base-sha', 'abc123']);
      } finally {
        console.error = report;
      }
      b = backlog();
    });
    expect(b.tickets[0]!.status).toBe('in-flight');
    expect(b.tickets[0]!.baseSha).toBe('abc123');
  });
});

describe('wantsStdinPayload', () => {
  // The CLI reads stdin only when asked. A payload-less command under an
  // inherited pipe that never closes (a harness-spawned shell) would otherwise
  // block forever on EOF it has no use for.
  test('a positional `-` asks for stdin', () => {
    expect(wantsStdinPayload(['update', 'T001', '-', '--note', 'sharpen'])).toBe(true);
  });

  test('a payload-less command never touches stdin', () => {
    expect(wantsStdinPayload(['attempt', 'T001', '--failed', 'lint', '--hypothesis', 'blind: unproven clause'])).toBe(false);
  });

  test('a file-path payload never touches stdin', () => {
    expect(wantsStdinPayload(['update', 'T001', '/tmp/patch.json'])).toBe(false);
  });

  test("an option's value is never mistaken for the marker", () => {
    expect(wantsStdinPayload(['set-status', 'T001', 'open', '--note', '-'])).toBe(false);
  });
});

describe('note', () => {
  // The campaign report arrives as a stdin payload: document-sized markdown
  // routed through a shell argument gets mangled by the shell's own vocabulary
  // ($, backticks), invisibly to everything downstream.
  test('a stdin payload carries a document-sized body verbatim', () => {
    const body = '# Report\n\nSpent `$COST` on **T001** | table | row |';
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      backlogWrite(['note', '--kind', 'campaign-report', '--subject', 'campaign', '-'], { body });
      expect(journalEntries().at(-1)).toMatchObject({ kind: 'campaign-report', subject: 'campaign', body });
    });
  });

  test('a payload and --body together are refused, and the payload must be {body}', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      expect(() => backlogWrite(['note', '--kind', 'k', '--subject', 's', '--body', 'b', '-'], { body: 'x' }))
        .toThrow(/not both/);
      expect(() => backlogWrite(['note', '--kind', 'k', '--subject', 's', '-'], { text: 'x' }))
        .toThrow(/single \{"body"/);
    });
  });

  test('a body passed as a bare positional is refused with guidance, not a raw fs error', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      expect(() => backlogWrite(['note', '--kind', 'campaign-report', '--subject', 'campaign', '# Report…']))
        .toThrow(/REFUSED.*not as a bare positional/);
    });
  });
});

// Milestones are the spec's checkpoints over the requirement enumeration. The
// writer's whole job here is that one can never be silently unreachable: the
// frontier cannot tell a checkpoint that will never arrive from one with work
// left, so the only place to catch it is the seed that admits it.
describe('milestones', () => {
  const REQS = [{ id: 'R1', clause: 'a' }, { id: 'R2', clause: 'b' }];
  const seedCfg = (cfg: unknown) => backlogWrite(['seed', '-'], [cfg]);

  test('a milestone citing the same seed\'s requirements is admitted', () => {
    const b = afterWrites({ tickets: [] }, () => {
      seedCfg({ requirements: REQS, milestones: [{ id: 'M1', name: 'auth', delivers: ['R1', 'R2'] }] });
    });
    expect(b.milestones).toEqual([{ id: 'M1', name: 'auth', delivers: ['R1', 'R2'] }]);
  });

  test('a clause outside the enumeration is refused — the checkpoint could never arrive', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      expect(() => seedCfg({ requirements: REQS, milestones: [{ id: 'M1', name: 'auth', delivers: ['R9'] }] }))
        .toThrow(/M1 delivers unknown requirement R9/);
    });
  });

  test('a milestone over no clause is refused', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      expect(() => seedCfg({ requirements: REQS, milestones: [{ id: 'M1', name: 'auth', delivers: [] }] }))
        .toThrow(/delivers nothing/);
    });
  });

  test('duplicate ids are refused — the id is what the sweep spends', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      expect(() => seedCfg({
        requirements: REQS,
        milestones: [{ id: 'M1', name: 'a', delivers: ['R1'] }, { id: 'M1', name: 'b', delivers: ['R2'] }],
      })).toThrow(/duplicate milestone id: M1/);
    });
  });

  // An amendment that carries only milestones has no enumeration in its payload,
  // so the check falls back to the one already in force rather than rejecting
  // every id for not being in an empty set.
  test('an amendment checks against the enumeration already seeded', () => {
    const b = afterWrites({ tickets: [], requirements: REQS }, () => {
      backlogWrite(['seed', '-', '--amend', '--note', 'late checkpoint'],
        [{ milestones: [{ id: 'M1', name: 'auth', delivers: ['R1'] }] }]);
    });
    expect(b.milestones?.[0]?.id).toBe('M1');
    expect(b.requirements).toEqual(REQS);
  });
});

describe('sweep-run', () => {
  const MS = [{ id: 'M1', name: 'auth', delivers: ['R1'] }];
  const seeded = { tickets: [buildTicket({ id: 'T001', status: 'closed' })], milestones: MS };

  test('spending a milestone records it', () => {
    withScratchCampaign({ backlog: seeded }, () => {
      backlogWrite(['sweep-run', '--milestone', 'M1', '--body', 'the slice holds']);
      expect(backlog().sweep).toEqual({ milestones: ['M1'] });
      // Which checkpoint a sweep answered is the post-mortem's only reading of
      // where the campaign's reflection actually landed.
      expect(journalEntries().at(-1)?.data).toEqual({ milestone: 'M1' });
    });
  });

  // An off-trigger sweep is a reflection worth keeping in the rolling memory,
  // but it answers no checkpoint and must not consume one.
  test('an off-trigger sweep journals without spending anything', () => {
    withScratchCampaign({ backlog: seeded }, () => {
      backlogWrite(['sweep-run', '--body', 'three tickets failed the same way']);
      expect(backlog().sweep).toBeUndefined();
      expect(journalEntries().at(-1)?.data).toBeUndefined();
    });
  });

  test('the summary is mandatory — it is the rolling memory', () => {
    withScratchCampaign({ backlog: seeded }, () => {
      expect(() => backlogWrite(['sweep-run', '--milestone', 'M1'])).toThrow(/requires --body/);
    });
  });

  test('a milestone is spent once — a second spend is refused', () => {
    withScratchCampaign({ backlog: seeded }, () => {
      backlogWrite(['sweep-run', '--milestone', 'M1', '--body', 'first']);
      expect(() => backlogWrite(['sweep-run', '--milestone', 'M1', '--body', 'again']))
        .toThrow(/M1 was already swept/);
    });
  });

  test('an undeclared milestone is refused', () => {
    withScratchCampaign({ backlog: seeded }, () => {
      expect(() => backlogWrite(['sweep-run', '--milestone', 'M9', '--body', 'b']))
        .toThrow(/no milestone M9/);
    });
  });

  test('spending a second milestone keeps the first', () => {
    const b = afterWrites({
      tickets: [buildTicket({ id: 'T001', status: 'closed' })],
      milestones: [...MS, { id: 'M2', name: 'data', delivers: ['R2'] }],
    }, () => {
      backlogWrite(['sweep-run', '--milestone', 'M1', '--body', 'a']);
      backlogWrite(['sweep-run', '--milestone', 'M2', '--body', 'b']);
    });
    expect(b.sweep?.milestones).toEqual(['M1', 'M2']);
  });
});

// The infra flag decides whether an attempt spends merit budget. backlog.json is
// deleted at campaign close, so a flag that lives only there cannot be audited
// afterwards — and campaigns have already walled tickets for machine faults.
describe('attempt telemetry', () => {
  const seeded = { tickets: [buildTicket({ id: 'T001', status: 'in-flight' })] };

  test('an infra attempt says so in the journal, not only in the ticket', () => {
    withScratchCampaign({ backlog: seeded }, () => {
      backlogWrite(['attempt', 'T001', '--failed', 'dead-engine', '--hypothesis', 'engine died', '--infra']);
      expect((backlog().tickets[0]!.attempts![0] as any).infra).toBe(true);
      expect((journalEntries().at(-1)!.data as any).infra).toBe(true);
    });
  });

  test('the flag rides alongside the settle telemetry rather than replacing it', () => {
    withScratchCampaign({ backlog: seeded }, () => {
      backlogWrite(['attempt', 'T001', '--failed', 'worker-channel', '--hypothesis', 'h',
        '--infra', '--data', '{"workerTokens":1200,"model":"claude-opus"}']);
      expect(journalEntries().at(-1)!.data).toEqual({ workerTokens: 1200, model: 'claude-opus', infra: true });
    });
  });

  test('a merit attempt carries no infra key at all', () => {
    withScratchCampaign({ backlog: seeded }, () => {
      backlogWrite(['attempt', 'T001', '--failed', 'typecheck', '--hypothesis', 'h', '--data', '{"workerTokens":9}']);
      expect(journalEntries().at(-1)!.data).toEqual({ workerTokens: 9 });
    });
  });
});

// Invariant 4's two per-ticket allowances. Both used to be enforced only by a
// coordinator's memory, which is compacted mid-campaign — and a budget that
// silently stops existing looks exactly like a budget with room left.
describe('per-ticket amendment budgets', () => {
  const open = { tickets: [buildTicket({ id: 'T001', status: 'open' })] };
  const amend = (flag = true) => backlogWrite(
    ['update', 'T001', '-', ...(flag ? ['--typo-amendment'] : []), '--note', 'n'],
    [{ acceptanceChecks: [{ name: 'u', cmd: 'true' }] }]);

  test('the first typo amendment is spent and recorded', () => {
    withScratchCampaign({ backlog: open }, () => {
      amend();
      expect(backlog().tickets[0]!.amendments?.typo).toBe(1);
    });
  });

  test('the second is refused — it is a meaning-level change wearing a smaller word', () => {
    withScratchCampaign({ backlog: open }, () => {
      amend();
      expect(() => amend()).toThrow(/already spent its typo amendment/);
      expect(backlog().tickets[0]!.amendments?.typo).toBe(1);
    });
  });

  // The gamed/sharpen path amends checks too and must stay unbounded: those
  // cost an attempt and a re-dispatch, which is the bound.
  test('an ordinary check amendment spends nothing', () => {
    withScratchCampaign({ backlog: open }, () => {
      amend(false); amend(false);
      expect(backlog().tickets[0]!.amendments).toBeUndefined();
    });
  });

  test('a flake probe is spent once and refused twice', () => {
    withScratchCampaign({ backlog: open }, () => {
      backlogWrite(['probe-spent', 'T001']);
      expect(backlog().tickets[0]!.amendments?.probe).toBe(1);
      expect(() => backlogWrite(['probe-spent', 'T001'])).toThrow(/already spent its flake probe/);
    });
  });

  test('the two budgets are independent', () => {
    withScratchCampaign({ backlog: open }, () => {
      backlogWrite(['probe-spent', 'T001']);
      amend();
      expect(backlog().tickets[0]!.amendments).toEqual({ probe: 1, typo: 1 });
    });
  });
});

// The spend policy the spec declares. It decides how many times a ticket may
// fail before the answer becomes the human's, so a nonsense value does not fail
// loudly — it produces a campaign that walls everything, or one that never walls
// at all, and both read as the loop simply behaving oddly.
describe('seeded caps', () => {
  const seedCfg = (cfg: unknown) => backlogWrite(['seed', '-'], [cfg]);

  test('a declared policy replaces the defaults', () => {
    const b = afterWrites({ tickets: [] }, () => { seedCfg({ caps: { maxAttempts: 5, thrash: 3 } }); });
    expect(b.caps).toEqual({ maxAttempts: 5, thrash: 3 });
  });

  // `null` is what kickoff returns for a spec that declared nothing, and it must
  // leave the defaults standing rather than blanking them.
  test('a null policy leaves the campaign defaults in force', () => {
    const b = afterWrites({ tickets: [], caps: { maxAttempts: 3, thrash: 2 } }, () => { seedCfg({ caps: null }); });
    expect(b.caps).toEqual({ maxAttempts: 3, thrash: 2 });
  });

  test('a cap below one would wall every ticket on its first attempt', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      expect(() => seedCfg({ caps: { maxAttempts: 0, thrash: 2 } })).toThrow(/maxAttempts must be a positive integer/);
      expect(() => seedCfg({ caps: { maxAttempts: 3, thrash: 1.5 } })).toThrow(/thrash must be a positive integer/);
    });
  });
});
