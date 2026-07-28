// The row arithmetic every pane depends on. These are the two places a display
// bug becomes a silent loss: text cut where it should wrap (unreadable evidence),
// and a window that reports more rows than the frame has (an overflowing screen
// that pushes the footer off). Both are pure functions, so both are checkable
// without a terminal.

import { describe, expect, test } from 'bun:test';
import { wrapText, windowAround } from './layout.ts';

describe('wrapText', () => {
  test('a line that fits is one row, unchanged', () => {
    expect(wrapText('short enough', 40)).toEqual(['short enough']);
  });

  test('wraps at the width instead of cutting, losing no words', () => {
    const text = 'the campaign gate went red and recover could not get it green within jurisdiction';
    const rows = wrapText(text, 30);
    expect(rows.every(r => r.length <= 30)).toBe(true);
    expect(rows.join(' ').split(/ +/)).toEqual(text.split(' ')); // every word survives
  });

  test('continuation rows carry the indent, so the gutter stays a gutter', () => {
    const rows = wrapText('09:15:10 T001 the worker returned a verdict that will not fit', 28, 9);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]!.startsWith('09:15:10')).toBe(true);
    for (const r of rows.slice(1)) expect(r.startsWith(' '.repeat(9))).toBe(true);
  });

  test('preserves the leading indent an entry arrived with', () => {
    const rows = wrapText('    fix: rebuild against current HEAD', 20);
    expect(rows[0]!.startsWith('    fix:')).toBe(true);
  });

  test('the continuation column is absolute, not added to the entry own indent', () => {
    // The distinction call sites depend on: an entry already indented four spaces
    // and asked to continue at column 9 continues at 9 — not at 13.
    const rows = wrapText('    fix: rebuild the ticket against the current HEAD instead', 30, 9);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[1]!.match(/^ */)![0]!.length).toBe(9);
  });

  test('preserves the space runs that are column alignment, not word spacing', () => {
    // A journal line pads its subject to a fixed column; collapsing that run puts
    // every body at a different column, which is the alignment the pane relies on.
    const rows = wrapText('09:15:10 · T001     fail [unit] in 41s', 60);
    expect(rows).toEqual(['09:15:10 · T001     fail [unit] in 41s']);
  });

  test('drops a space run that would trail a wrapped row', () => {
    const rows = wrapText('aaa   bbb   ccc', 8);
    expect(rows).toEqual(['aaa   ', 'bbb   ', 'ccc'].map(r => r.trimEnd()));
  });

  test('a whitespace-only spacer survives as a row', () => {
    // Panes use a blank row for a paragraph break; dropping it silently reflows
    // the pane, and an empty string renders as nothing at all.
    expect(wrapText(' ', 40)).toEqual([' ']);
  });

  test('breaks a word wider than the pane rather than dropping it', () => {
    const sha = 'a'.repeat(75);
    const rows = wrapText(`base ${sha}`, 20);
    expect(rows.every(r => r.length <= 20)).toBe(true);
    expect(rows.join('').replace(/ /g, '')).toBe(`base${sha}`);
  });

  test('honours explicit newlines — a paragraph stays a paragraph', () => {
    expect(wrapText('first\n\nsecond', 40)).toEqual(['first', '', 'second']);
  });

  test('strips escape sequences rather than measuring them', () => {
    // A test runner's coloured output: 30 visible characters wearing 9 invisible
    // ones. Measured naively it wraps early and can split a sequence across rows.
    const coloured = '\x1b[31mFAIL\x1b[0m src/a.test.ts > it works';
    const rows = wrapText(coloured, 40);
    expect(rows).toEqual(['FAIL src/a.test.ts > it works']);
  });

  test('an empty entry still occupies its row, so budgets stay honest', () => {
    expect(wrapText('', 40)).toEqual(['']);
    expect(wrapText(undefined, 40)).toEqual(['']);
  });
});

describe('windowAround', () => {
  const rowsIn = (heights: number[], sel: number, budget: number) => {
    const [start, end] = windowAround(heights, sel, budget);
    return { start, end, used: heights.slice(start, end).reduce((n, h) => n + h, 0) };
  };

  test('never exceeds the budget', () => {
    const heights = [1, 3, 1, 2, 4, 1, 1, 2];
    for (let sel = 0; sel < heights.length; sel++) {
      expect(rowsIn(heights, sel, 6).used).toBeLessThanOrEqual(6);
    }
  });

  test('always contains the selection', () => {
    const heights = [2, 2, 2, 2, 2, 2, 2];
    for (let sel = 0; sel < heights.length; sel++) {
      const { start, end } = rowsIn(heights, sel, 5);
      expect(sel).toBeGreaterThanOrEqual(start);
      expect(sel).toBeLessThan(end);
    }
  });

  test('keeps the selection off the edge when there is room on both sides', () => {
    const { start, end } = rowsIn(Array(9).fill(1), 4, 5);
    expect([start, end]).toEqual([2, 7]); // two entries above, two below
  });

  test('fills the frame at the ends of the list rather than wasting it', () => {
    expect(rowsIn(Array(9).fill(1), 0, 4)).toEqual({ start: 0, end: 4, used: 4 });
    expect(rowsIn(Array(9).fill(1), 8, 4)).toEqual({ start: 5, end: 9, used: 4 });
  });

  test('a selection taller than the whole frame is still shown, clipped', () => {
    const { start, end } = rowsIn([1, 12, 1], 1, 6);
    expect([start, end]).toEqual([1, 2]);
  });

  test('an empty list is an empty window', () => {
    expect(windowAround([], 0, 10)).toEqual([0, 0]);
  });
});
