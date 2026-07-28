// Fitting text into a fixed terminal frame — the pure half of the display, the
// way railgraph.ts holds the pure half of the graph. dashboard.tsx composes; this
// file decides how many rows something occupies, which is the question every pane
// has to answer before it can render without overflowing the screen.
//
// The reason it exists: panes used to cut each entry at the right edge, so anything
// longer than one line — a park reason, a worker's hypothesis, a failing check's
// output — was unreadable in the only place it was shown. Wrapping instead of
// cutting means an entry is no longer one row, so a pane can no longer budget by
// counting entries. Both halves of that live here.

// One entry, wrapped to `width`, as the rows it will occupy. `contCol` is the
// ABSOLUTE column continuation rows start at — not an amount added to whatever the
// first row happened to be indented by — so a caller aligns wrapped text under a
// gutter by naming the gutter's width and nothing else. The entry still reads as
// one entry rather than as several.
//
// Escape sequences and control characters are stripped rather than measured: a
// test runner's coloured output would otherwise count its invisible bytes toward
// the line width and wrap short, and a sequence split across two rows bleeds its
// colour into the rest of the pane. Losing the colour of inspected output is the
// cheaper half of that trade.
export function wrapText(s: unknown, width: number, contCol = 0): string[] {
  const w = Math.max(8, Math.floor(width)); // narrower than this is not a pane
  const clean = String(s ?? '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  const out: string[] = [];
  for (const para of clean.split('\n')) {
    const lead = para.match(/^ */)![0]!.slice(0, w - 4);
    const cont = ' '.repeat(Math.max(0, Math.min(contCol, w - 4)));
    // Split into words AND the space runs between them, because a run of spaces is
    // often column alignment (a padded subject, a gap between fields) rather than
    // word spacing — collapsing it silently un-aligns the pane. Deferred as
    // `pending` so a run never survives as trailing space on a wrapped row.
    const tokens = para.slice(lead.length).split(/( +)/).filter(Boolean);
    // A whitespace-only entry is a deliberate spacer, and it has to survive as one
    // row: a pane that drops it loses the paragraph break it was standing for.
    if (!tokens.some(t => t.trim())) { out.push(para ? ' ' : ''); continue; }

    let line = lead;
    let empty = true;
    let pending = '';
    for (const token of tokens) {
      if (!token.trim()) { pending = empty ? '' : token; continue; }
      if (line.length + pending.length + token.length <= w) {
        line += pending + token;
        pending = '';
        empty = false;
        continue;
      }
      if (!empty) { out.push(line); line = cont; empty = true; }
      pending = '';
      // A word wider than the pane — a path, a sha, a JSON blob — is broken rather
      // than dropped: the whole point is that nothing goes unread.
      let rest = token;
      while (line.length + rest.length > w) {
        const room = Math.max(1, w - line.length);
        out.push(line + rest.slice(0, room));
        rest = rest.slice(room);
        line = cont;
      }
      line += rest;
      empty = false;
    }
    out.push(line);
  }
  return out;
}

// The window of a selection list that fits `budget` rows and always contains the
// selected entry. Entries are variable height once they wrap, so a fixed count of
// entries would either overflow the frame or waste it; this grows outward from the
// selection, keeping it roughly centred, and stops when the next entry on either
// side would not fit whole. Returns an end index EXCLUSIVE, for slice().
export function windowAround(heights: number[], sel: number, budget: number): [number, number] {
  if (!heights.length) return [0, 0];
  const at = Math.max(0, Math.min(sel, heights.length - 1));
  let start = at, end = at + 1;
  let used = heights[at]!;

  // A selected entry taller than the whole budget is still shown: the pane clips it
  // rather than rendering an empty window.
  while (used < budget) {
    const above = start > 0 ? heights[start - 1]! : null;
    const below = end < heights.length ? heights[end]! : null;
    const fitsAbove = above !== null && used + above <= budget;
    const fitsBelow = below !== null && used + below <= budget;
    if (!fitsAbove && !fitsBelow) break;
    // Prefer whichever side is currently shorter, so the selection stays near the
    // middle instead of drifting to an edge.
    const takeBelow = fitsBelow && (!fitsAbove || (end - at) <= (at - start));
    if (takeBelow) { used += below!; end++; }
    else { used += above!; start--; }
  }
  return [start, end];
}
