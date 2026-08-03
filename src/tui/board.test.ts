// The board's arithmetic: which column a ticket lands in, what selection can
// reach, and how a cell is cut to its column. Wrong answers here are silent —
// a ticket rendered in the wrong stage, a selectable the frame isn't showing —
// so they're pinned the same way layout.ts's are: pure functions, no terminal.

import { describe, expect, test } from 'bun:test';
import type { Backlog, Ticket } from '../campaign/backlog.ts';
import type { LiveRun } from '../campaign/live.ts';
import {
  buildBoard, capCells, columnWidths, fitSpans, jumpColumn, needsYou,
  recentNotable, selectables, stageOf,
} from './board.ts';

const ticket = (id: string, over: Partial<Ticket> = {}): Ticket => ({
  id, title: id, modules: ['src'], origin: 'spec', context: '', acceptance: '',
  acceptanceChecks: [], status: 'open', ...over,
});
const backlog = (tickets: Ticket[], over: Partial<Backlog> = {}): Backlog =>
  ({ project: 'p', tickets, ...over });
const run = (label: string, over: Partial<LiveRun> = {}): LiveRun =>
  ({ label, cmd: 'x', startedAt: 0, tail: [], partial: '', ...over });

const NOW = Date.parse('2026-01-01T00:10:00Z');
const AT = '2026-01-01T00:08:00Z';

describe('stageOf', () => {
  const byId = (ts: Ticket[]) => new Map(ts.map(t => [t.id, t]));

  test('open with closed deps is ready; with a live dep, waiting', () => {
    const dep = ticket('T1', { status: 'closed' });
    const live = ticket('T2');
    const a = ticket('T3', { depends_on: ['T1'] });
    const b = ticket('T4', { depends_on: ['T2'] });
    const map = byId([dep, live, a, b]);
    expect(stageOf(a, map)).toBe('ready');
    expect(stageOf(b, map)).toBe('waiting');
  });

  test('in-flight maps by phase, unstamped counts as building', () => {
    const at = AT;
    const phase = (name: string) =>
      stageOf(ticket('T1', { status: 'in-flight', phase: { name: name as any, at } }), byId([]));
    expect(stageOf(ticket('T1', { status: 'in-flight' }), byId([]))).toBe('building');
    expect(phase('dispatched')).toBe('building');
    expect(phase('verifying')).toBe('verify');
    expect(phase('probing')).toBe('verify');
    expect(phase('under-review')).toBe('review');
    expect(phase('merging')).toBe('review'); // shares the column; its cell carries the ⇢
  });

  test('closed and parked leave the pipeline columns', () => {
    expect(stageOf(ticket('T1', { status: 'closed' }), byId([]))).toBe('closed');
    expect(stageOf(ticket('T1', { status: 'parked' }), byId([]))).toBe('parked');
  });
});

describe('buildBoard', () => {
  const b = backlog([
    ticket('T1', { status: 'closed' }),
    ticket('T2', { status: 'in-flight', phase: { name: 'verifying', at: AT } }),
    ticket('T3', { depends_on: ['T1'] }),
    ticket('T4', { depends_on: ['T2'] }),
    ticket('T5', { status: 'in-flight', dispatch: { model: 'm', rung: 0, at: AT } }),
    ticket('T6', { status: 'parked', parkReason: 'needs a human' }),
    ticket('T7', { status: 'decomposed' }),
  ]);
  const runs = [
    run('verify:T2', { ticketId: 'T2', tail: [{ ts: 0, line: '12 passed' }] }),
    run('gate:e2e'),
  ];
  const board = buildBoard(b, runs, NOW, 14);

  test('columns hold the right tickets; parked and decomposed are absent', () => {
    const ids = board.columns.map(c => c.cells.map(x => x.key));
    expect(ids[0]).toEqual(['T3', 'T4']);            // ready, then waiting
    expect(ids[1]).toEqual(['T5']);                  // building
    expect(ids[2]).toEqual(['T2', 'run:verify:T2']); // verify, its check under it
    expect(ids[3]).toEqual([]);                      // review
    expect(ids[4]).toContain('T1');                  // closed
    expect(ids.flat().join()).not.toMatch(/T6|T7/);
  });

  test('titles carry the counts, waiting separate from ready', () => {
    expect(board.columns[0]!.title).toBe('ready 1 +1⋯');
    expect(board.columns[4]!.title).toBe('closed 1/6');
  });

  test('an unstamped in-flight ticket is flagged and still aged from dispatch', () => {
    const text = board.columns[1]!.cells[0]!.spans.map(s => s.text).join('');
    expect(text).toContain('⚠');
    expect(text).toContain('2m'); // held since dispatch.at
  });

  test('a check owned by no ticket is a loose run, not a cell', () => {
    expect(board.looseRuns.map(r => r.label)).toEqual(['gate:e2e']);
  });

  test('selection walks columns left to right, loose runs last', () => {
    expect(selectables(board).map(s => s.key)).toEqual(
      ['T3', 'T4', 'T5', 'T2', 'run:verify:T2', 'T1', 'run:gate:e2e']);
  });
});

describe('columnWidths', () => {
  test('widths plus separators land exactly on the frame', () => {
    const w = columnWidths(100, 5);
    expect(w.reduce((a, x) => a + x, 0)).toBe(100 - 4);
    expect(Math.max(...w) - Math.min(...w)).toBeLessThanOrEqual(1);
  });
});

describe('fitSpans', () => {
  test('pads to the width so separators align', () => {
    const out = fitSpans([{ text: 'T1' }], 8);
    expect(out.map(s => s.text).join('')).toBe('T1      ');
  });

  test('cuts with an ellipsis instead of overflowing', () => {
    const out = fitSpans([{ text: 'T1 ' }, { text: 'a very long tail' }], 8);
    const joined = out.map(s => s.text).join('');
    expect(joined.length).toBe(8);
    expect(joined.endsWith('…')).toBe(true);
  });
});

describe('capCells', () => {
  const cells = Array.from({ length: 6 }, (_, i) => ({ key: `T${i}`, spans: [{ text: `T${i}` }] }));

  test('within budget, untouched', () => {
    expect(capCells(cells, 6)).toBe(cells);
  });

  test('over budget, the drop is declared', () => {
    const capped = capCells(cells, 4);
    expect(capped.length).toBe(4);
    expect(capped.at(-1)!.spans[0]!.text).toBe('+3 more');
    expect(capped.at(-1)!.target).toBeUndefined(); // furniture, not selectable
  });
});

describe('jumpColumn', () => {
  const flat = [{ col: 0 }, { col: 0 }, { col: 2 }, { col: 4 }];

  test('lands on the first selectable of the next non-empty column', () => {
    expect(jumpColumn(flat, 0, 1)).toBe(2);  // skips empty col 1
    expect(jumpColumn(flat, 2, -1)).toBe(0);
  });

  test('the edge holds instead of wrapping', () => {
    expect(jumpColumn(flat, 3, 1)).toBe(3);
    expect(jumpColumn(flat, 0, -1)).toBe(0);
  });
});

describe('needsYou', () => {
  test('nothing pending is said, not left blank', () => {
    expect(needsYou(backlog([ticket('T1')]))[0]!.text).toContain('nothing needs you');
  });

  test('parked tickets, a parked gate, and unclaimed clauses all surface', () => {
    const b = backlog(
      [ticket('T1', { status: 'parked', parkReason: 'flaky ws test' }),
        ticket('T2', { status: 'closed', satisfies: ['R1'] })],
      {
        gateState: { parked: { reason: 'gate contention' } },
        requirements: [{ id: 'R1', clause: 'a' }, { id: 'R2', clause: 'b' }],
      });
    const texts = needsYou(b).map(r => r.text);
    expect(texts.some(t => t.includes('gate contention'))).toBe(true);
    expect(texts.some(t => t.includes('T1') && t.includes('flaky ws test'))).toBe(true);
    expect(texts.some(t => t.includes('R2'))).toBe(true);
  });
});

describe('recentNotable', () => {
  test('keeps story events, drops verify and status noise', () => {
    const j = (kind: string) => ({ ts: '2026-01-01T00:00:00Z', kind });
    const out = recentNotable(
      [j('verify'), j('close'), j('status'), j('attempt'), j('close')], 2);
    expect(out.map(e => e.kind)).toEqual(['attempt', 'close']);
  });
});
