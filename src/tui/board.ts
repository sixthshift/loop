// The active pane as a pipeline — the pure half. dashboard.tsx composes; this
// file decides what lands in which column, how a cell is spanned and cut, and
// the order selection walks, which is everything worth testing without a
// terminal.
//
// Why a board at all: the loop IS a pipeline (ready → building → verify →
// review → closed), and the flat list this replaced showed the same tickets as
// rows plus counters — leaving the operator to reconstruct the motion in their
// head. Making the stages the layout makes the motion the thing you see: a
// ticket's life is a walk from left to right, and a stuck campaign is a column
// that stopped emptying.

import type { Backlog, Ticket, TicketPhase } from '../campaign/backlog.ts';
import type { JournalEntry } from '../campaign/journal.ts';
import type { LiveRun } from '../campaign/live.ts';
import { coverage } from '../campaign/frontier.ts';
import { dur } from './layout.ts';

// A styled run of text. Cells carry these instead of rendered strings so the
// view can apply the selection highlight without re-parsing its own output.
export type Span = { text: string; color?: string; dim?: boolean; bold?: boolean };

// What ↵ opens for a cell: a ticket's detail, or a running check's tail. The
// two grains the old flat list had, kept — a cell without a target (the bar,
// the gate, a "+N more") is furniture, and selection skips it.
export type Target = { kind: 'ticket'; id: string } | { kind: 'run'; label: string };
export type Cell = { key: string; spans: Span[]; target?: Target };
export type Column = { title: string; cells: Cell[] };

// Loose runs are checks owned by no in-flight ticket — the campaign gate, a
// fast-tier probe at the root. They render full-width under the board because
// a gate run is the single most important thing on screen while it exists,
// and a fifth-column cell is the wrong size for it.
export type Board = { columns: Column[]; looseRuns: LiveRun[] };

export const PHASE_COLOR: Record<TicketPhase, string> = {
  dispatched: 'cyan', verifying: 'blue', 'under-review': 'magenta',
  probing: 'yellow', merging: 'green',
};

// Where a ticket sits in the pipeline. `waiting` is derived, not stored
// (frontier.ts owns the same split); `merging` shares the review column below
// because it lasts seconds, and a column that is almost always empty spends a
// fifth of the frame saying nothing.
export type Stage = 'ready' | 'waiting' | 'building' | 'verify' | 'review' | 'closed' | 'parked';

export function stageOf(t: Ticket, byId: Map<string, Ticket>): Stage {
  if (t.status === 'closed') return 'closed';
  if (t.status === 'parked') return 'parked';
  if (t.status === 'in-flight') {
    const phase = t.phase?.name;
    if (phase === 'verifying' || phase === 'probing') return 'verify';
    if (phase === 'under-review' || phase === 'merging') return 'review';
    return 'building'; // dispatched, or never stamped
  }
  return (t.depends_on ?? []).every(d => byId.get(d)?.status === 'closed') ? 'ready' : 'waiting';
}

// `colWidth` sizes the closed column's progress bar — the one cell whose text
// depends on how wide it will render.
export function buildBoard(b: Backlog, runs: LiveRun[], now: number, colWidth: number): Board {
  const tickets = b.tickets.filter(t => t.status !== 'decomposed');
  const byId = new Map(tickets.map(t => [t.id, t]));
  const maxAttempts = b.caps?.maxAttempts ?? 3;
  const closed = tickets.filter(t => t.status === 'closed');

  const stages: Record<'ready' | 'waiting' | 'building' | 'verify' | 'review', Ticket[]> =
    { ready: [], waiting: [], building: [], verify: [], review: [] };
  for (const t of tickets) {
    const s = stageOf(t, byId);
    if (s !== 'closed' && s !== 'parked') stages[s].push(t);
  }

  // Merit attempts only, same as everywhere: an engine that died three times
  // spent nothing, and a cell reading ✗3/3 for it points at the wrong suspect.
  const merit = (t: Ticket) => (t.attempts ?? []).filter(a => !a.infra).length;
  const meritSpan = (t: Ticket): Span[] => {
    const m = merit(t);
    return m ? [{ text: ` ✗${m}/${maxAttempts}`, color: 'red', dim: true }] : [];
  };

  // How long the ticket has been where it is: the phase stamp when there is
  // one, the dispatch otherwise — so an unstamped ticket still shows its age.
  const held = (t: Ticket): string => {
    const at = t.phase?.at ?? t.dispatch?.at;
    return at ? dur(Math.max(0, now - Date.parse(at))) : '';
  };

  const flightCell = (t: Ticket): Cell => {
    const phase = t.phase?.name;
    const spans: Span[] = [{ text: `${t.id} `, color: phase ? PHASE_COLOR[phase] : 'cyan', bold: true }];
    if (phase === 'merging') spans.push({ text: '⇢ ', color: 'green' });
    const h = held(t);
    if (h) spans.push({ text: h, dim: true });
    // Dispatched but never phase-stamped is invariant 1's only symptom, and
    // this ⚠ is the dashboard's whole coverage of it.
    if (!phase) spans.push({ text: ' ⚠', color: 'yellow' });
    spans.push(...meritSpan(t));
    return { key: t.id, spans, target: { kind: 'ticket', id: t.id } };
  };

  const readyCell = (t: Ticket): Cell =>
    ({ key: t.id, spans: [{ text: t.id }, ...meritSpan(t)], target: { kind: 'ticket', id: t.id } });
  const waitingCell = (t: Ticket): Cell =>
    ({ key: t.id, spans: [{ text: `⋯ ${t.id}`, dim: true }], target: { kind: 'ticket', id: t.id } });

  // A check runs on behalf of some ticket; its cell rides directly under
  // that ticket, whichever column the ticket is in.
  const claimed = new Set<string>();
  const runCell = (r: LiveRun): Cell => {
    const line = r.partial || r.tail.at(-1)?.line;
    return {
      key: `run:${r.label}`,
      spans: [{ text: '$ ', dim: true },
        line ? { text: line.trim(), color: 'cyan' } : { text: '(starting)', dim: true }],
      target: { kind: 'run', label: r.label },
    };
  };
  const withRuns = (ts: Ticket[]): Cell[] => ts.flatMap(t => [
    flightCell(t),
    ...runs.filter(r => r.ticketId === t.id).map(r => (claimed.add(r.label), runCell(r))),
  ]);

  const columns: Column[] = [
    {
      title: `ready ${stages.ready.length}${stages.waiting.length ? ` +${stages.waiting.length}⋯` : ''}`,
      cells: [...stages.ready.map(readyCell), ...stages.waiting.map(waitingCell)],
    },
    { title: `building ${stages.building.length}`, cells: withRuns(stages.building) },
    { title: `verify ${stages.verify.length}`, cells: withRuns(stages.verify) },
    { title: `review ${stages.review.length}`, cells: withRuns(stages.review) },
    { title: `closed ${closed.length}/${tickets.length}`, cells: closedCells(b, closed, tickets.length, colWidth) },
  ];
  return { columns, looseRuns: runs.filter(r => !claimed.has(r.label)) };
}

function closedCells(b: Backlog, closed: Ticket[], total: number, colWidth: number): Cell[] {
  const w = Math.max(4, colWidth - 1);
  const filled = total ? Math.round((closed.length / total) * w) : 0;
  const cells: Cell[] = [
    { key: 'bar', spans: [{ text: '█'.repeat(filled), color: 'green' }, { text: '░'.repeat(w - filled), dim: true }] },
    { key: 'gate', spans: gateSpans(b) },
  ];
  // Newest first. Array order is add order, not close order, but a close edits
  // its ticket in place — reversed is the closest thing the snapshot supports.
  for (const t of [...closed].reverse())
    cells.push({ key: t.id, spans: [{ text: '✓ ', color: 'green' }, { text: t.id, dim: true }], target: { kind: 'ticket', id: t.id } });
  return cells;
}

// A green verdict only covers the tree it measured: `current` is the same
// counts-match arithmetic gate-run stamps for, so a close after the run blanks
// the cell rather than carrying a stale ✓.
function gateSpans(b: Backlog): Span[] {
  if (!b.gate?.length) return [{ text: 'no gate', dim: true }];
  if (b.gateState?.parked) return [{ text: 'gate ⏸', color: 'red' }];
  const last = b.gateState?.lastRun;
  const current = last?.tickets === b.tickets.length
    && last.closed === b.tickets.filter(t => t.status === 'closed').length;
  if (current && last?.result === 'green') return [{ text: 'gate ✓', color: 'green' }];
  if (current && last?.result === 'red') return [{ text: 'gate ✗', color: 'red' }];
  const live = b.tickets.filter(t => t.status !== 'decomposed' && t.status !== 'closed').length;
  if (live === 0) return [{ text: 'gate …', color: 'yellow' }];
  return [{ text: 'gate —', dim: true }];
}

// --- frame arithmetic ---------------------------------------------------------

// Equal columns over the frame, remainder to the left; the n-1 separators are
// paid for here so the render can join with '│' and land exactly on `total`.
export function columnWidths(total: number, n: number): number[] {
  const usable = Math.max(n * 8, total - (n - 1));
  const each = Math.floor(usable / n);
  const extra = usable - each * n;
  return Array.from({ length: n }, (_, i) => each + (i < extra ? 1 : 0));
}

// A column taller than the frame declares what it dropped rather than silently
// ending — same rule as the ticket detail pane.
export function capCells(cells: Cell[], budget: number): Cell[] {
  if (cells.length <= Math.max(1, budget)) return cells;
  const kept = cells.slice(0, Math.max(1, budget) - 1);
  return [...kept, { key: 'more', spans: [{ text: `+${cells.length - kept.length} more`, dim: true }] }];
}

export function capBoard(board: Board, budget: number): Board {
  return { columns: board.columns.map(c => ({ ...c, cells: capCells(c.cells, budget) })), looseRuns: board.looseRuns };
}

// Cut styled spans to a column's width and pad to exactly that width, so every
// row of the grid lands its separators in the same terminal column.
export function fitSpans(spans: Span[], width: number): Span[] {
  const out: Span[] = [];
  let used = 0;
  for (const s of spans) {
    if (used >= width) break;
    const room = width - used;
    const text = s.text.length > room ? s.text.slice(0, Math.max(0, room - 1)) + '…' : s.text;
    if (text) out.push({ ...s, text });
    used += text.length;
  }
  if (used < width) out.push({ text: ' '.repeat(width - used) });
  return out;
}

// --- selection ------------------------------------------------------------------

// The order j/k walks: columns left to right, cells top to bottom, loose runs
// last. Built from the CAPPED board so selection can never point at a cell the
// frame isn't showing.
export function selectables(board: Board): { key: string; col: number; target: Target }[] {
  const out: { key: string; col: number; target: Target }[] = [];
  board.columns.forEach((c, col) => {
    for (const cell of c.cells) if (cell.target) out.push({ key: cell.key, col, target: cell.target });
  });
  for (const r of board.looseRuns)
    out.push({ key: `run:${r.label}`, col: board.columns.length, target: { kind: 'run', label: r.label } });
  return out;
}

// h/l: first selectable of the nearest non-empty column in `dir`; the edge
// holds rather than wrapping.
export function jumpColumn(flat: { col: number }[], sel: number, dir: 1 | -1): number {
  if (!flat.length) return 0;
  const cur = flat[Math.max(0, Math.min(sel, flat.length - 1))]!.col;
  const maxCol = flat.reduce((m, f) => Math.max(m, f.col), 0);
  for (let col = cur + dir; col >= 0 && col <= maxCol; col += dir) {
    const i = flat.findIndex(f => f.col === col);
    if (i !== -1) return i;
  }
  return sel;
}

// --- the two panels under the board ---------------------------------------------

export type NoteRow = { text: string; color?: string; dim?: boolean };

// Everything waiting on a human, or the one line saying nothing is — the
// attention answer, first thing under the work. Park reasons come off the
// ticket (parkReason is durable state), not the journal.
export function needsYou(b: Backlog): NoteRow[] {
  const rows: NoteRow[] = [];
  if (b.gateState?.parked) rows.push({ text: ` ⏸ gate — ${b.gateState.parked.reason}`, color: 'red' });
  for (const t of b.tickets) {
    if (t.status !== 'parked') continue;
    rows.push({ text: ` ⏸ ${t.id} — ${t.parkReason ?? 'parked'}`, color: 'red' });
  }
  const cov = b.requirements?.length ? coverage(b) : null;
  if (cov?.unmapped.length)
    rows.push({ text: ` ! ${cov.unmapped.length} clause${cov.unmapped.length > 1 ? 's' : ''} unclaimed — ${cov.unmapped.join(', ')}`, color: 'yellow' });
  if (!rows.length) rows.push({ text: ' ✓ nothing needs you', dim: true });
  return rows;
}

// What the ticker under the board shows: the events that move the campaign's
// story. Verify results and phase moves stay in the journal tab — at 2 Hz they
// would be the whole ticker.
const NOTABLE = new Set([
  'close', 'attempt', 'decompose', 'parked', 'recovered', 'recover-refused',
  'recover-out-of-bounds', 'gate-red', 'integration-red', 'escalation', 'flake-probe',
  'sweep', 'campaign-gate-close', 'gate-replaced', 'gate-refused', 'gate-amendment', 'kickoff',
]);

export function recentNotable(journal: JournalEntry[], n: number): JournalEntry[] {
  return journal.filter(j => NOTABLE.has(j.kind)).slice(-n);
}
