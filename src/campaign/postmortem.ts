// Render the campaign's journal as a self-contained HTML post-mortem: stat
// tiles, a Gantt timeline (one lane per ticket, dependency arrows, verify
// overlays, gate markers), per-ticket cost bars, and a table. Zero model
// cost; facts come from journal.jsonl + backlog.json. The raw journal is
// embedded in the page (<script id="journal">), so the HTML is also the
// campaign's durable event archive — deleting campaign/ loses nothing.
//
// Run at retrospective, BEFORE .ailoop/campaign/ is deleted. Native twin of the
// ailoop skill's postmortem.mjs; identical output.
//
// Worker cost is an ESTIMATE: the coordinator journals the tokens the Agent
// tool reported at close; those are priced at the model's output rate.
// Coordinator-session overhead is not visible from inside the run and is
// excluded — the page says so.

import fs from 'node:fs';
import path from 'node:path';
import { backlog } from './backlog.ts';
import { journalEntries } from './journal.ts';

// $/MTok output rate, checked 2026-07 — refresh when models rotate
const OUTPUT_PRICE: Record<string, number> = { opus: 25, sonnet: 15, haiku: 5 };
// Cost estimate is claude-only: codex reports no cost and has no price here, so
// it estimates to 0. A claude- prefix is stripped; a bare name is claude.
const priceFor = (model: string): number =>
  model.startsWith('codex-') ? 0 : (OUTPUT_PRICE[model.replace(/^claude-/, '')] ?? OUTPUT_PRICE.opus!);

export function writePostmortem(out: string): { tickets: number; events: number } {
  const b = backlog();
  const journal = journalEntries();
  if (!journal.length) throw new Error('no journal events to render');

  const t0 = new Date(journal[0]!.ts).getTime();
  const t1 = new Date(journal.at(-1)!.ts).getTime();
  const x = (ts: string) => (new Date(ts).getTime() - t0) / (t1 - t0);

  // ---- derive per-ticket lifecycle from the journal ----
  const tickets: Record<string, any> = {};
  const forTicket = (id: string) => (tickets[id] ||= { id, spans: [], verifies: [], attempts: 0 });
  for (const e of journal) {
    if (!/^T\d+$/.test(e.subject || '')) continue;
    const t = forTicket(e.subject!);
    if (e.kind === 'status' && /→ in-flight/.test(e.body || '')) t.spans.push({ start: e.ts, end: null });
    if (e.kind === 'attempt' || e.kind === 'close') {
      const open = t.spans.find((s: any) => !s.end);
      if (open) { open.end = e.ts; open.outcome = e.kind; open.data = e.data || null; }
      if (e.kind === 'attempt') t.attempts++;
      if (e.kind === 'close') { t.closedAt = e.ts; t.closeData = e.data || null; }
    }
    if (e.kind === 'verify') t.verifies.push({ ts: e.ts, ...e.data });
  }
  // gate markers: any journaled gate event (campaign-gate-close, gate-red, gate-amendment)
  const gates = journal.filter(e => /gate/.test(e.kind)).map(e => ({ ts: e.ts, body: `${e.subject}: ${e.body}` }));

  // a span never closed (crash, resume, or a campaign rendered mid-flight)
  // still renders — it ends at the journal's last event, marked open
  for (const t of Object.values(tickets)) for (const s of (t as any).spans) {
    if (!s.end) { s.end = journal.at(-1)!.ts; s.outcome = 'open'; }
  }

  const rows = Object.values(tickets)
    .map((t: any) => ({ ...t, meta: b.tickets.find(bt => bt.id === t.id) || ({} as any) }))
    .filter((t: any) => t.spans.length)
    .sort((a: any, z: any) => (a.spans[0].start < z.spans[0].start ? -1 : 1));

  // The model that actually ran — recorded in worker telemetry at close/attempt
  // (chain fallback and all), never a declared tag; tickets carry no model.
  const runModel = (t: any): string =>
    t.closeData?.model ?? t.spans.map((s: any) => s.data?.model).filter(Boolean).at(-1) ?? '';

  const estCost = (t: any) => {
    const tokens = t.closeData?.workerTokens ?? t.spans.reduce((s: number, sp: any) => s + (sp.data?.workerTokens || 0), 0);
    if (!tokens) return null;
    return (tokens / 1e6) * priceFor(runModel(t));
  };

  const data = {
    project: b.project,
    span: { first: journal[0]!.ts, last: journal.at(-1)!.ts },
    wallMinutes: (t1 - t0) / 60000,
    tickets: rows.map((t: any) => ({
      id: t.id, title: t.meta.title || '',
      depends_on: t.meta.depends_on || [], model: runModel(t),
      attempts: t.attempts, closedAt: t.closedAt || null,
      closeX: t.closedAt ? x(t.closedAt) : null,
      tokens: t.closeData?.workerTokens ?? null,
      workerSeconds: t.closeData?.workerSeconds ?? null,
      cost: estCost(t),
      spans: t.spans.map((s: any) => ({
        x0: x(s.start), x1: x(s.end), start: s.start, end: s.end,
        outcome: s.outcome, repair: /repair/i.test(t.meta.origin || ''),
      })),
      verifies: t.verifies.map((v: any) => ({
        x1: x(v.ts), x0: x(new Date(+new Date(v.ts) - (v.durationMs || 0)).toISOString()),
        ts: v.ts, durationMs: v.durationMs || 0, pass: v.pass,
      })),
    })),
    gates: gates.map(g => ({ x: x(g.ts), ts: g.ts, body: g.body })),
  };

  const totalCost = data.tickets.reduce((s, t) => s + (t.cost || 0), 0);
  const anyCost = data.tickets.some(t => t.cost != null);

  const html = `<title>ailoop post-mortem — ${data.project}</title>
<style>
  :root { color-scheme: light dark; }
  .viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb; --plane: #f9f9f7;
    --ink-1: #0b0b0b; --ink-2: #52514e; --ink-3: #898781;
    --grid: #e1e0d9; --axisline: #c3c2b7; --ring: rgba(11,11,11,0.10);
    --c-build: #2a78d6; --c-repair: #1baf7a; --c-verify: #e87ba4;
    --c-gate: #eda100; --c-fail: #e34948;
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--ink-1); background: var(--plane);
    margin: 0; padding: 24px; min-height: 100vh; box-sizing: border-box;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1: #1a1a19; --plane: #0d0d0d;
      --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
      --grid: #2c2c2a; --axisline: #383835; --ring: rgba(255,255,255,0.10);
      --c-build: #3987e5; --c-repair: #199e70; --c-verify: #d55181;
      --c-gate: #c98500; --c-fail: #e66767;
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --plane: #0d0d0d;
    --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
    --grid: #2c2c2a; --axisline: #383835; --ring: rgba(255,255,255,0.10);
    --c-build: #3987e5; --c-repair: #199e70; --c-verify: #d55181;
    --c-gate: #c98500; --c-fail: #e66767;
  }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: var(--ink-2); margin: 0 0 20px; }
  .card { background: var(--surface-1); border: 1px solid var(--ring); border-radius: 10px; padding: 16px 18px; margin-bottom: 18px; }
  .tiles { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
  .tile { background: var(--surface-1); border: 1px solid var(--ring); border-radius: 10px; padding: 12px 16px; flex: 1 1 150px; min-width: 150px; }
  .tile .label { color: var(--ink-2); font-size: 12px; }
  .tile .value { font-size: 26px; font-weight: 600; margin-top: 2px; }
  .tile .note { color: var(--ink-3); font-size: 12px; margin-top: 2px; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  .desc { color: var(--ink-2); font-size: 13px; margin: 0 0 12px; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--ink-2); margin-bottom: 10px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .gantt-scroll { overflow-x: auto; }
  svg text { font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--ink-3); }
  svg text.lane-label { fill: var(--ink-1); font-weight: 600; }
  .tooltip { position: fixed; pointer-events: none; background: var(--surface-1); color: var(--ink-1);
    border: 1px solid var(--ring); border-radius: 8px; padding: 8px 10px; font-size: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.18); max-width: 320px; z-index: 10; display: none; }
  .tooltip .t-head { font-weight: 600; margin-bottom: 2px; }
  .tooltip .t-sub { color: var(--ink-2); }
  .bars .row { display: grid; grid-template-columns: 56px 1fr 150px; align-items: center; gap: 10px; margin: 3px 0; }
  .bars .id { font-weight: 600; font-size: 12px; }
  .bars .track { height: 16px; position: relative; }
  .bars .fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 0 4px 4px 0; }
  .bars .val { color: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
  details summary { cursor: pointer; color: var(--ink-2); font-size: 13px; }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--grid); vertical-align: top; }
  th { color: var(--ink-2); font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
<div class="viz-root">
  <h1>ailoop post-mortem — ${data.project}</h1>
  <p class="sub">Rendered from journal.jsonl · worker costs estimated from journaled tokens · coordinator-session overhead not included</p>
  <div class="tiles" id="tiles"></div>
  <div class="card">
    <h2>Campaign timeline</h2>
    <p class="desc">One lane per ticket, ordered by dispatch. A ticket's bar runs dispatch → judgment (build + verify + judge). Hover a span for detail; hover a ticket label to trace dependencies (upstream solid, downstream dashed).</p>
    <div class="legend">
      <span><span class="sw" style="background:var(--c-build)"></span>in flight → closed</span>
      <span><span class="sw" style="background:var(--c-fail)"></span>in flight → failed attempt</span>
      <span><span class="sw" style="background:var(--c-repair)"></span>repair ticket</span>
      <span><span class="sw" style="background:var(--c-verify)"></span>verify.mjs</span>
      <span><span class="sw" style="background:var(--c-gate)"></span>gate event</span>
      <span><span class="sw" style="background:var(--ink-3); border-radius:99px"></span>close (merged)</span>
    </div>
    <div class="gantt-scroll"><div id="gantt"></div></div>
  </div>
  <div class="card">
    <h2>Cost per ticket (worker spend, estimated)</h2>
    <p class="desc">From journaled worker tokens priced at the model's output rate. Tickets without journaled tokens show duration only.</p>
    <div class="bars" id="costbars"></div>
  </div>
  <div class="card">
    <details>
      <summary>Table view — every ticket with timings, attempts, tokens, and cost</summary>
      <div id="tablewrap" style="overflow-x:auto"></div>
    </details>
  </div>
  <div class="tooltip" id="tip"></div>
</div>
<script type="application/json" id="journal">${JSON.stringify(journal).replace(/</g, '\\u003c')}</script>
<script>
const D = ${JSON.stringify(data).replace(/</g, '\\u003c')};
const money = v => '$' + v.toFixed(2);
const fmtT = ts => new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
const mins = ms => (ms / 60000).toFixed(1) + ' min';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const closed = D.tickets.filter(t => t.closedAt).length;
const attempts = D.tickets.reduce((s, t) => s + t.attempts, 0);
const totalCost = ${JSON.stringify(anyCost ? totalCost : null)};
const tiles = [
  ['Wall time', Math.round(D.wallMinutes) + ' min', fmtT(D.span.first) + ' → ' + fmtT(D.span.last)],
  ['Tickets closed', closed + ' / ' + D.tickets.length, attempts + ' failed attempt' + (attempts === 1 ? '' : 's')],
  totalCost != null ? ['Worker cost (est.)', money(totalCost), 'excludes coordinator overhead'] : null,
  ['Verify runs', D.tickets.reduce((s, t) => s + t.verifies.length, 0), mins(D.tickets.reduce((s, t) => s + t.verifies.reduce((a, v) => a + v.durationMs, 0), 0)) + ' scripted, zero model cost'],
].filter(Boolean);
document.getElementById('tiles').innerHTML = tiles.map(([l, v, n]) =>
  '<div class="tile"><div class="label">' + l + '</div><div class="value">' + v + '</div><div class="note">' + n + '</div></div>').join('');

const LABEL_W = 200, LANE_H = 26, PAD_T = 26, PAD_B = 8, PLOT_W = 1080;
const H = PAD_T + D.tickets.length * LANE_H + PAD_B;
const W = LABEL_W + PLOT_W + 16;
const px = f => LABEL_W + f * PLOT_W;
const laneY = i => PAD_T + i * LANE_H;
const laneIdx = Object.fromEntries(D.tickets.map((t, i) => [t.id, i]));

let svg = '<svg width="' + W + '" height="' + H + '" role="img" aria-label="Campaign timeline">';
const spanMs = new Date(D.span.last) - new Date(D.span.first);
const tickEvery = spanMs > 4 * 3600e3 ? 60 : 30;
for (let m = 0; m * 60000 <= spanMs; m += tickEvery) {
  const ts = new Date(D.span.first).getTime() + m * 60000;
  const fx = px(m * 60000 / spanMs);
  svg += '<line x1="' + fx + '" y1="' + (PAD_T - 6) + '" x2="' + fx + '" y2="' + (H - PAD_B) + '" stroke="var(--grid)" stroke-width="1"/>';
  svg += '<text x="' + fx + '" y="' + (PAD_T - 10) + '" text-anchor="middle">' + fmtT(ts) + '</text>';
}
for (const g of D.gates) {
  svg += '<line class="hov" x1="' + px(g.x) + '" y1="' + PAD_T + '" x2="' + px(g.x) + '" y2="' + (H - PAD_B) + '" stroke="var(--c-gate)" stroke-width="2" opacity="0.7"' +
    ' data-tip="' + esc('<div class=t-head>gate event</div><div>' + esc(g.body) + '</div><div class=t-sub>' + fmtT(g.ts) + '</div>') + '"/>';
}
let arrows = '';
for (const t of D.tickets) {
  if (!t.spans.length) continue;
  for (const dep of t.depends_on) {
    const dt = D.tickets.find(o => o.id === dep);
    if (!dt || laneIdx[dep] === undefined) continue;
    const sx = px(dt.closeX ?? (dt.spans.at(-1)?.x1 ?? 0));
    const sy = laneY(laneIdx[dep]) + LANE_H / 2;
    const ex = px(t.spans[0].x0), ey = laneY(laneIdx[t.id]) + LANE_H / 2;
    arrows += '<path class="dep" data-from="' + dep + '" data-to="' + t.id + '" d="M' + sx + ' ' + sy +
      ' C ' + (sx + 24) + ' ' + sy + ', ' + (ex - 24) + ' ' + ey + ', ' + ex + ' ' + ey +
      '" fill="none" stroke="var(--axisline)" stroke-width="1" opacity="0.5"/>';
  }
}
svg += '<g id="deps">' + arrows + '</g>';
D.tickets.forEach((t, i) => {
  const y = laneY(i), cy = y + LANE_H / 2, barY = y + (LANE_H - 14) / 2;
  svg += '<text class="lane-label" data-ticket="' + t.id + '" x="8" y="' + (cy + 4) + '">' + t.id + '</text>';
  for (const s of t.spans) {
    const color = s.repair ? 'var(--c-repair)' : (s.outcome === 'attempt' ? 'var(--c-fail)' : 'var(--c-build)');
    const bw = Math.max(3, (s.x1 - s.x0) * PLOT_W);
    svg += '<rect class="hov" x="' + px(s.x0) + '" y="' + barY + '" width="' + bw + '" height="14" rx="4" fill="' + color + '"' +
      ' data-tip="' + esc('<div class=t-head>' + t.id + (s.outcome === 'attempt' ? ' — failed attempt' : '') + (t.model ? ' · ' + t.model : '') + '</div>' +
        '<div>' + esc(t.title) + '</div>' +
        '<div class=t-sub>' + fmtT(s.start) + ' → ' + fmtT(s.end) + ' (' + mins(new Date(s.end) - new Date(s.start)) + ')' +
        (t.tokens ? ' · ' + Math.round(t.tokens / 1000) + 'k worker tokens' : '') +
        (t.cost != null ? ' · ' + money(t.cost) + ' est.' : '') + '</div>') + '"/>';
  }
  for (const v of t.verifies) {
    const vw = Math.max(2, (v.x1 - v.x0) * PLOT_W);
    svg += '<rect class="hov" x="' + px(v.x0) + '" y="' + (barY + 2) + '" width="' + vw + '" height="10" rx="3" fill="var(--c-verify)"' +
      ' data-tip="' + esc('<div class=t-head>' + t.id + ' verify.mjs — ' + (v.pass ? 'pass' : 'fail') + '</div><div class=t-sub>' + fmtT(v.ts) + ' · ' + mins(v.durationMs) + '</div>') + '"/>';
  }
  if (t.closeX != null) {
    svg += '<circle class="hov" cx="' + px(t.closeX) + '" cy="' + cy + '" r="4" fill="var(--ink-3)" stroke="var(--surface-1)" stroke-width="2"' +
      ' data-tip="' + esc('<div class=t-head>' + t.id + ' closed</div><div class=t-sub>' + fmtT(t.closedAt) + ' — evidence recorded, branch merged</div>') + '"/>';
  }
});
svg += '<line x1="' + LABEL_W + '" y1="' + (H - PAD_B) + '" x2="' + (LABEL_W + PLOT_W) + '" y2="' + (H - PAD_B) + '" stroke="var(--axisline)" stroke-width="1"/>';
svg += '</svg>';
document.getElementById('gantt').innerHTML = svg;

const tip = document.getElementById('tip');
function wireTips(root) {
  root.querySelectorAll('.hov').forEach(el => {
    el.addEventListener('mousemove', e => {
      tip.innerHTML = el.dataset.tip; tip.style.display = 'block';
      const r = tip.getBoundingClientRect();
      tip.style.left = Math.min(e.clientX + 14, innerWidth - r.width - 10) + 'px';
      tip.style.top = Math.min(e.clientY + 14, innerHeight - r.height - 10) + 'px';
    });
    el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}
wireTips(document.getElementById('gantt'));

document.querySelectorAll('text.lane-label[data-ticket]').forEach(el => {
  el.addEventListener('mouseenter', () => {
    document.querySelectorAll('#deps .dep').forEach(p => {
      const up = p.dataset.to === el.dataset.ticket, down = p.dataset.from === el.dataset.ticket;
      if (up || down) {
        p.setAttribute('opacity', '1'); p.setAttribute('stroke', 'var(--ink-1)'); p.setAttribute('stroke-width', '1.5');
        if (down) p.setAttribute('stroke-dasharray', '4 3');
      } else p.setAttribute('opacity', '0.12');
    });
  });
  el.addEventListener('mouseleave', () => {
    document.querySelectorAll('#deps .dep').forEach(p => {
      p.setAttribute('opacity', '0.5'); p.setAttribute('stroke', 'var(--axisline)');
      p.setAttribute('stroke-width', '1'); p.removeAttribute('stroke-dasharray');
    });
  });
});

const spanTotal = t => t.spans.reduce((s, sp) => s + (new Date(sp.end) - new Date(sp.start)), 0);
const metric = t => t.cost ?? spanTotal(t) / 60000 / 1000; // cost, else minutes shrunk to sort after any cost
const sorted = D.tickets.slice().sort((a, b) => metric(b) - metric(a));
const maxM = Math.max(...sorted.map(metric), 1e-9);
document.getElementById('costbars').innerHTML = sorted.map(t =>
  '<div class="row"><div class="id">' + t.id + '</div>' +
  '<div class="track"><div class="fill hov" style="width:' + (metric(t) / maxM * 100) + '%; background: var(--c-build)"' +
  ' data-tip="' + esc('<div class=t-head>' + t.id + (t.cost != null ? ' · ' + money(t.cost) + ' est.' : '') + '</div><div>' + esc(t.title) + '</div><div class=t-sub>' +
    (t.tokens ? Math.round(t.tokens / 1000) + 'k worker tokens · ' : '') + mins(spanTotal(t)) + ' in flight</div>') + '"></div></div>' +
  '<div class="val">' + (t.cost != null ? money(t.cost) + ' · ' : '') + mins(spanTotal(t)) + '</div></div>').join('');
wireTips(document.getElementById('costbars'));

document.getElementById('tablewrap').innerHTML = '<table><thead><tr>' +
  '<th>Ticket</th><th>Title</th><th>Deps</th><th>Model</th>' +
  '<th class="num">In flight</th><th class="num">Verify</th><th class="num">Attempts</th><th class="num">Tokens</th><th class="num">Cost est.</th><th>Closed</th></tr></thead><tbody>' +
  D.tickets.map(t => '<tr><td><b>' + t.id + '</b></td>' +
    '<td>' + esc(t.title) + '</td><td>' + t.depends_on.join(', ') + '</td><td>' + t.model + '</td>' +
    '<td class="num">' + mins(spanTotal(t)) + '</td>' +
    '<td class="num">' + mins(t.verifies.reduce((s, v) => s + v.durationMs, 0)) + '</td>' +
    '<td class="num">' + t.attempts + '</td>' +
    '<td class="num">' + (t.tokens ? Math.round(t.tokens / 1000) + 'k' : '—') + '</td>' +
    '<td class="num">' + (t.cost != null ? money(t.cost) : '—') + '</td>' +
    '<td>' + (t.closedAt ? fmtT(t.closedAt) : '—') + '</td></tr>').join('') +
  '</tbody></table>';
</script>
`;

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  return { tickets: rows.length, events: journal.length };
}
