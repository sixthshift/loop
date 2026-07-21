// Lay out a ticket dependency DAG as a git-log-style "rail" grid: ticket =
// commit, depends_on = parents. A node sits BELOW its dependencies (foundations
// at top), so reading top→bottom is execution order. This is git's lane-tracking
// algorithm over reverse-topological order, then flipped vertically for display.
//
// Pure geometry — no colour, no React. The view renders the returned lines and
// asks litArms()/endpoints() which cells belong to the selected ticket's edges,
// so a shared `┼` crossing that isn't the selection's own edge can be drawn dark
// (killing the crossing-vs-junction ambiguity that plain box-drawing can't).
//
// Correctness rests on two invariants: reverse-topological order guarantees a
// node's deps are always already-open lanes above it, and every parent edge is
// reachable by flood-fill across the rendered box-drawing grid.

import type { Ticket } from '../campaign/backlog.ts';

const U = 1, D = 2, L = 4, R = 8;

// A bit-set of open directions → the box-drawing glyph that carries them. Several
// sets collapse to the same glyph (a bare │ reads as U, D, or U|D).
const BITS: Record<number, string> = {
  0: ' ',
  [U]: '│', [D]: '│', [U | D]: '│',
  [L]: '─', [R]: '─', [L | R]: '─',
  [D | R]: '╭', [D | L]: '╮', [U | R]: '╰', [U | L]: '╯',
  [U | D | R]: '├', [U | D | L]: '┤', [D | L | R]: '┬', [U | L | R]: '┴',
  [U | D | L | R]: '┼',
};
// Inverse: a glyph → its richest direction bits. Used to intersect a rail cell
// with the selected node's lit arms so we can draw only the lit sub-shape.
const GLYPH_BITS: Record<string, number> = {
  '│': U | D, '─': L | R, '╭': D | R, '╮': D | L, '╰': U | R, '╯': U | L,
  '├': U | D | R, '┤': U | D | L, '┬': D | L | R, '┴': U | L | R, '┼': U | D | L | R,
};
const swapUD = (b: number) => (b & ~(U | D)) | (b & U ? D : 0) | (b & D ? U : 0);

export type RailLine =
  | { kind: 'node'; id: string; title: string; status: string; rail: string; nodePos: number }
  | { kind: 'link'; rail: string };

export type RailGraph = {
  lines: RailLine[];                 // flipped, foundations-at-top, node+link interleaved
  order: string[];                   // node ticket ids top→bottom (selection index space)
  gutter: number;                    // rail column width in chars
  nodeLineIndex: Map<string, number>; // ticket id → index into lines
  litArms: (sel: string) => Map<string, number>; // "lineIdx,charPos" → lit bits
  endpoints: (sel: string) => Set<string>;        // direct parents ∪ children of sel
  bitsFor: (ch: string) => number;   // glyph → richest direction bits (0 if none)
  glyph: (bits: number) => string;   // direction bits → glyph
};

// One lane holds the id of a not-yet-emitted parent it leads down to (or null).
type Row = { id: string; col: number; before: (string | null)[]; after: (string | null)[]; taps: number[] };

export function railGraph(tickets: Ticket[]): RailGraph {
  const present = new Set(tickets.map(t => t.id));
  const byId = new Map(tickets.map(t => [t.id, t]));
  const parentsOf = (id: string) => (byId.get(id)!.depends_on ?? []).filter(d => present.has(d));

  const childrenOf = new Map<string, string[]>(tickets.map(t => [t.id, []]));
  for (const t of tickets) for (const p of parentsOf(t.id)) childrenOf.get(p)!.push(t.id);

  const order = printOrder(tickets, parentsOf);
  const rows = computeRows(order, parentsOf);
  const rowById = new Map(rows.map(r => [r.id, r]));

  const maxLanes = rows.reduce((m, r) => Math.max(m, r.before.length, r.after.length, r.col + 1), 1);
  const gutter = 2 * maxLanes - 1;

  // Build in native geometry (node above its deps), recording each node's line.
  const origLines: RailLine[] = [];
  const nodeLineOrig = new Map<string, number>();
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k]!;
    const t = byId.get(row.id)!;
    nodeLineOrig.set(row.id, origLines.length);
    origLines.push({ kind: 'node', id: row.id, title: t.title, status: t.status, rail: renderNodeRow(row), nodePos: row.col * 2 });
    if (k < rows.length - 1) origLines.push({ kind: 'link', rail: renderLinkRow(row, rows[k + 1]!) });
  }

  // Flip to foundations-at-top: reverse rows and mirror corners vertically.
  const N = origLines.length;
  const flipIdx = (i: number) => N - 1 - i;
  const lines = origLines.map(mirrorLine).reverse();
  const nodeLineIndex = new Map([...nodeLineOrig].map(([id, li]) => [id, flipIdx(li)]));

  // A ticket's one edge to a parent: a horizontal stub from the child's column
  // out to the parent's lane, then that lane straight down to the parent node.
  // Marked in native geometry, keyed into the flipped grid (U/D swapped).
  const litArms = (sel: string): Map<string, number> => {
    const arms = new Map<string, number>();
    const mark = (origR: number, p: number, bits: number) => {
      const k = `${flipIdx(origR)},${p}`;
      arms.set(k, (arms.get(k) ?? 0) | swapUD(bits));
    };
    const litEdge = (childId: string, parentId: string) => {
      const child = rowById.get(childId)!;
      const q = child.after.indexOf(parentId);
      if (q < 0) return;
      const cLine = nodeLineOrig.get(childId)!;
      const pLine = nodeLineOrig.get(parentId)!;
      const cCol = child.col;
      if (q === cCol) { for (let r = cLine; r <= pLine; r++) mark(r, cCol * 2, U | D); return; }
      const link = cLine + 1;
      mark(link, cCol * 2, U | (q > cCol ? R : L));
      const [lo, hi] = cCol < q ? [cCol, q] : [q, cCol];
      for (let x = lo * 2 + 1; x < hi * 2; x++) mark(link, x, L | R);
      mark(link, q * 2, q > cCol ? L : R);
      for (let r = link; r <= pLine; r++) mark(r, q * 2, U | D);
    };
    for (const p of parentsOf(sel)) litEdge(sel, p);
    for (const c of childrenOf.get(sel) ?? []) litEdge(c, sel);
    return arms;
  };

  const endpoints = (sel: string) => new Set<string>([...parentsOf(sel), ...(childrenOf.get(sel) ?? [])]);

  return {
    lines, order, gutter, nodeLineIndex, litArms, endpoints,
    bitsFor: ch => GLYPH_BITS[ch] ?? 0,
    glyph: bits => BITS[bits] ?? '?',
  };
}

// --- reverse-topological order (Kahn, deps-first, tie-break by id) -----------

function printOrder(tickets: Ticket[], parentsOf: (id: string) => string[]): string[] {
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tickets) { indeg.set(t.id, parentsOf(t.id).length); dependents.set(t.id, []); }
  for (const t of tickets) for (const p of parentsOf(t.id)) dependents.get(p)!.push(t.id);

  const ready = tickets.filter(t => indeg.get(t.id) === 0).map(t => t.id).sort();
  const depsFirst: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    depsFirst.push(id);
    for (const dep of dependents.get(id)!) {
      indeg.set(dep, indeg.get(dep)! - 1);
      if (indeg.get(dep) === 0) {
        const i = ready.findIndex(r => r > dep);
        i === -1 ? ready.push(dep) : ready.splice(i, 0, dep);
      }
    }
  }
  // Cycle guard: append survivors deterministically rather than loop forever.
  if (depsFirst.length !== tickets.length) {
    const seen = new Set(depsFirst);
    depsFirst.push(...tickets.map(t => t.id).filter(id => !seen.has(id)).sort());
  }
  return depsFirst.reverse();
}

// --- lane tracking -----------------------------------------------------------

function computeRows(order: string[], parentsOf: (id: string) => string[]): Row[] {
  const lanes: (string | null)[] = [];
  const rows: Row[] = [];
  for (const id of order) {
    const before = lanes.slice();
    const incoming: number[] = [];
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === id) incoming.push(i);
    let col = incoming.length ? incoming[0]! : lanes.indexOf(null);
    if (col === -1) col = lanes.length;
    for (const i of incoming) lanes[i] = null;
    lanes[col] = null;

    const taps: number[] = [];
    let first = true;
    for (const p of parentsOf(id)) {
      const existing = lanes.indexOf(p);
      if (existing !== -1) { taps.push(existing); first = false; continue; }
      let lane: number;
      if (first && lanes[col] == null) lane = col;
      else { lane = lanes.indexOf(null); if (lane === -1) lane = lanes.length; }
      lanes[lane] = p;
      first = false;
    }
    trimNulls(lanes);
    rows.push({ id, col, before, after: lanes.slice(), taps });
  }
  return rows;
}

function trimNulls(arr: (string | null)[]): void {
  let n = arr.length;
  while (n > 0 && arr[n - 1] == null) n--;
  arr.length = n;
}

// --- bit-grid → rail string --------------------------------------------------

const ensure = (cell: number[], w: number) => { while (cell.length < w) cell.push(0); };

// A full edge from column `from` (top) to column `to` (bottom): the endpoints
// carry the vertical, the span between carries the horizontal.
function drawLine(cell: number[], from: number, to: number): void {
  if (from === to) { cell[from]! |= U | D; return; }
  const [lo, hi] = from < to ? [from, to] : [to, from];
  cell[from]! |= U | (to > from ? R : L);
  cell[to]! |= D | (to > from ? L : R);
  for (let c = lo + 1; c < hi; c++) cell[c]! |= L | R;
}

// A tap: the node column reaches sideways INTO a continuing lane, which keeps
// carrying its own vertical (so no D added at the lane column).
function drawTap(cell: number[], from: number, lane: number): void {
  cell[from]! |= U | (lane > from ? R : L);
  const [lo, hi] = from < lane ? [from, lane] : [lane, from];
  cell[lane]! |= lane > from ? L : R;
  for (let c = lo + 1; c < hi; c++) cell[c]! |= L | R;
}

function renderLinkRow(topRow: Row, bottomRow: Row): string {
  const state = topRow.after;
  const ci = topRow.col;
  const B = bottomRow.id;
  let cj = -1;
  for (let i = 0; i < state.length; i++) if (state[i] === B) { cj = i; break; }

  const cell: number[] = [];
  ensure(cell, Math.max(state.length, ci + 1, cj + 1));
  for (let lane = 0; lane < state.length; lane++) {
    const t = state[lane];
    if (t == null) continue;
    const newborn = topRow.before[lane] !== t;        // fans out from the node above
    const converging = t === B && lane !== cj;        // merges into the node below
    if (newborn) drawLine(cell, ci, lane);
    else if (converging) drawLine(cell, lane, cj);
    else drawLine(cell, lane, lane);
  }
  for (const lane of topRow.taps) drawTap(cell, ci, lane);
  return paint(cell);
}

function paint(cell: number[]): string {
  let out = '';
  for (let c = 0; c < cell.length; c++) {
    out += BITS[cell[c]!] ?? '?';
    if (c < cell.length - 1) out += (cell[c]! & R && cell[c + 1]! & L) ? '─' : ' ';
  }
  return out.replace(/\s+$/, '');
}

// The node's own row: its glyph column is filled by the view (status-coloured);
// here we lay only the pass-through lanes flanking it.
function renderNodeRow(row: Row): string {
  const w = Math.max(row.before.length, row.after.length, row.col + 1);
  const chars = new Array(w).fill(' ');
  for (let j = 0; j < w; j++) {
    if (j === row.col) continue;
    if (row.before[j] != null && row.before[j] === row.after[j]) chars[j] = '│';
  }
  chars[row.col] = ' '; // node-glyph slot; the view overwrites it
  return chars.join(' ').replace(/\s+$/, '');
}

// Mirror a rail line's corners vertically (swap the up/down half) so rails still
// connect after the row order is reversed.
const MIRROR: Record<string, string> = { '╭': '╰', '╰': '╭', '╮': '╯', '╯': '╮', '┬': '┴', '┴': '┬' };
function mirrorLine(l: RailLine): RailLine {
  const rail = [...l.rail].map(c => MIRROR[c] ?? c).join('');
  return l.kind === 'node' ? { ...l, rail } : { kind: 'link', rail };
}
