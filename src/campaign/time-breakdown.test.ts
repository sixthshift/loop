// The time-breakdown extraction is arithmetic over journal events, and every
// case here is a shape a real campaign produced: clean closes, verify-red
// rejections, the amend-typo round trip that re-stamps in-flight mid-settle,
// decomposition, and the crash that leaves a span open. Wrong handling of any
// of these produced wrong numbers in real post-hoc analysis (negative builds,
// verify time filed as land time), which is exactly what the module exists to
// prevent.

import { describe, expect, test } from 'bun:test';
import type { JournalEntry } from './journal.ts';
import { campaignShape, parkWindows, ticketBreakdowns } from './time-breakdown.ts';

const T0 = Date.parse('2026-08-10T10:00:00Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const e = (min: number, kind: string, subject: string, body = '', data?: unknown): JournalEntry =>
  ({ ts: at(min), kind, subject, body, ...(data !== undefined ? { data } : {}) });

const MIN = 60_000;

describe('ticketBreakdowns', () => {
  test('a clean close tiles the span into build / verify / review / land', () => {
    const [t] = ticketBreakdowns([
      e(0, 'status', 'T001', '→ in-flight'),
      e(10, 'phase', 'T001', 'verifying'),
      e(11, 'verify', 'T001', 'pass', { durationMs: 90_000, pass: true }),
      e(14, 'phase', 'T001', 'under-review'),
      e(19, 'phase', 'T001', 'merging'),
      e(20, 'close', 'T001', 'closed', { workerTokens: 62_000, workerSeconds: 580, model: 'opus', agent: 'aaa111' }),
    ]);
    const s = t!.spans[0]!;
    expect(s.outcome).toBe('close');
    expect(s.walls).toEqual({ build: 10 * MIN, verify: 4 * MIN, review: 5 * MIN, land: 1 * MIN, blocked: 0 });
    expect(s.verifyScriptMs).toBe(90_000);
    expect(s.telemetry).toEqual({ workerTokens: 62_000, workerSeconds: 580, model: 'opus', agent: 'aaa111' });
  });

  test('a build rejected at verify files its tail under verify, never land', () => {
    const [t] = ticketBreakdowns([
      e(0, 'status', 'T002', '→ in-flight'),
      e(8, 'phase', 'T002', 'verifying'),
      e(12, 'attempt', 'T002', 'attempt 1 failed [unit]: …', { workerTokens: 30_000 }),
    ]);
    const s = t!.spans[0]!;
    expect(s.outcome).toBe('attempt');
    expect(s.walls).toEqual({ build: 8 * MIN, verify: 4 * MIN, review: 0, land: 0, blocked: 0 });
    expect(s.telemetry).toEqual({ workerTokens: 30_000 });
  });

  test('the amend-typo round trip (open → in-flight mid-settle) stays one attempt', () => {
    const [t] = ticketBreakdowns([
      e(0, 'status', 'T003', '→ in-flight'),
      e(10, 'phase', 'T003', 'verifying'),
      e(12, 'phase', 'T003', 'under-review'),
      e(15, 'status', 'T003', '→ open — check amendment'),
      e(16, 'status', 'T003', '→ in-flight'),
      e(17, 'phase', 'T003', 'verifying'),
      e(20, 'close', 'T003', 'closed'),
    ]);
    expect(t!.spans).toHaveLength(1);
    expect(t!.spans[0]!.walls.build).toBe(10 * MIN); // the re-stamp did not reopen a span
  });

  test('retries key spans per attempt, each carrying its own telemetry', () => {
    const [t] = ticketBreakdowns([
      e(0, 'status', 'T004', '→ in-flight'),
      e(9, 'attempt', 'T004', 'attempt 1 failed', { workerTokens: 20_000 }),
      e(10, 'status', 'T004', '→ in-flight'),
      e(25, 'close', 'T004', 'closed', { workerTokens: 45_000 }),
    ]);
    expect(t!.spans.map(s => [s.n, s.outcome, s.telemetry?.workerTokens])).toEqual([
      [1, 'attempt', 20_000],
      [2, 'close', 45_000],
    ]);
  });

  test('decompose settles the open span; a span never settled ends open at the journal tail', () => {
    const rows = ticketBreakdowns([
      e(0, 'status', 'T005', '→ in-flight'),
      e(5, 'decompose', 'T005', '→ [T006, T007]'),
      e(6, 'status', 'T006', '→ in-flight'),
      e(9, 'note', 'campaign', 'journal ends here'),
    ]);
    expect(rows.find(t => t.id === 'T005')!.spans[0]!.outcome).toBe('decomposed');
    const open = rows.find(t => t.id === 'T006')!.spans[0]!;
    expect(open.outcome).toBe('open');
    expect(open.end).toBe(at(9));
  });
});

describe('campaignShape', () => {
  test('a serial campaign reports maxInFlight 1 and the inter-ticket gap as idle', () => {
    const shape = campaignShape(ticketBreakdowns([
      e(0, 'status', 'T001', '→ in-flight'),
      e(20, 'close', 'T001', 'closed'),
      e(21, 'status', 'T002', '→ in-flight'),
      e(50, 'close', 'T002', 'closed'),
    ]), []);
    expect(shape.maxInFlight).toBe(1);
    expect(shape.idleMs).toBe(1 * MIN);
    expect(shape.spannedMs).toBe(50 * MIN);
  });

  test('a close and the next dispatch at the same instant is still serial', () => {
    const shape = campaignShape(ticketBreakdowns([
      e(0, 'status', 'T001', '→ in-flight'),
      e(20, 'close', 'T001', 'closed'),
      e(20, 'status', 'T002', '→ in-flight'),
      e(50, 'close', 'T002', 'closed'),
    ]), []);
    expect(shape.maxInFlight).toBe(1);
    expect(shape.idleMs).toBe(0);
  });

  test('overlapping spans raise maxInFlight and leave no idle inside the overlap', () => {
    const shape = campaignShape(ticketBreakdowns([
      e(0, 'status', 'T001', '→ in-flight'),
      e(5, 'status', 'T002', '→ in-flight'),
      e(20, 'close', 'T001', 'closed'),
      e(30, 'close', 'T002', 'closed'),
    ]), []);
    expect(shape.maxInFlight).toBe(2);
    expect(shape.idleMs).toBe(0);
  });

  test('heldMs unions concurrent parks rather than summing them', () => {
    const journal = [
      e(0, 'status', 'T001', '→ in-flight'),
      e(10, 'parked', 'T001', 'human ruling'),
      e(30, 'status', 'T002', '→ in-flight'),
      e(35, 'parked', 'T002', 'human ruling'),
      e(50, 'status', 'T001', '→ open — ruled'),
      e(70, 'status', 'T002', '→ open — ruled'),
      e(80, 'close', 'T001', 'closed'),
      e(81, 'close', 'T002', 'closed'),
    ];
    // sum would be 40 + 35 = 75; the campaign only lost 10 → 70.
    expect(campaignShape(ticketBreakdowns(journal), parkWindows(journal)).heldMs).toBe(60 * MIN);
  });
});

// The bucket that exists because a real campaign reported 50% "review" of which
// 88% was three overnight parks — the difference between "tune the judge" and
// "you are blocked on yourself".
describe('parks', () => {
  test('a park inside review is carved out of review, not counted as judge time', () => {
    const [t] = ticketBreakdowns([
      e(0, 'status', 'T001', '→ in-flight'),
      e(10, 'phase', 'T001', 'verifying'),
      e(12, 'phase', 'T001', 'under-review'),
      e(15, 'parked', 'T001', 'MEANING-LEVEL CHECK AMENDMENT — the human‘s by construction'),
      e(75, 'status', 'T001', '→ open — HUMAN RULING applied'),
      e(76, 'status', 'T001', '→ in-flight'),
      e(80, 'close', 'T001', 'closed'),
    ]);
    expect(t!.spans).toHaveLength(1);
    expect(t!.spans[0]!.walls)
      .toEqual({ build: 10 * MIN, verify: 2 * MIN, review: 8 * MIN, land: 0, blocked: 60 * MIN });
  });

  test('a park never released ends at the journal tail and says so', () => {
    const journal = [
      e(0, 'status', 'T002', '→ in-flight'),
      e(5, 'phase', 'T002', 'verifying'),
      e(10, 'parked', 'T002', 'BLOCKED BY AN EXTERNAL ENVIRONMENT FAULT'),
      e(40, 'note', 'campaign', 'journal ends here'),
    ];
    expect(parkWindows(journal)).toEqual([
      { ticket: 'T002', start: at(10), end: at(40), released: false },
    ]);
    const [t] = ticketBreakdowns(journal);
    expect(t!.spans[0]!.walls)
      .toEqual({ build: 5 * MIN, verify: 5 * MIN, review: 0, land: 0, blocked: 30 * MIN });
  });

  test('the amend-typo → open is not a park — only a `parked` entry opens one', () => {
    expect(parkWindows([
      e(0, 'status', 'T003', '→ in-flight'),
      e(15, 'status', 'T003', '→ open — check amendment'),
      e(16, 'status', 'T003', '→ in-flight'),
      e(20, 'close', 'T003', 'closed'),
    ])).toEqual([]);
  });
});
