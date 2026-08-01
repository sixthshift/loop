// The face of a campaign someone else is driving.
//
// This is a reader, and every design decision below follows from that. The
// coordinator is a model in a conversation: it cannot be attached to, subscribed
// to, or asked. So the dashboard polls the files (snapshot.ts), shows what they
// support, and shows nothing where they support nothing — the alternative being a
// pane that infers activity from silence, which is the one thing a watcher must
// never do.
//
// It writes no campaign state, and has no controls that would: no pause, no
// worker cap, no kill. Those existed when the drive loop was in-process and could
// honor a flag at its next decision point. Reaching the coordinator now would
// mean writing a request file and hoping it reads it, and a control that might be
// obeyed is worse than no control at all.

import React, { useEffect, useState } from 'react';
import { render, Box, Text, useInput, useStdout } from 'ink';
import { coverage } from '../campaign/frontier.ts';
import type { Backlog, Ticket } from '../campaign/backlog.ts';
import type { JournalEntry } from '../campaign/journal.ts';
import type { LiveRun } from '../campaign/live.ts';
import { readSnapshot, activeRows, staleness } from './snapshot.ts';
import type { Snapshot, ActiveRow, Staleness } from './snapshot.ts';
import { railGraph } from './railgraph.ts';
import type { RailGraph, RailLine } from './railgraph.ts';
import { wrapText, windowAround, hhmm, dur } from './layout.ts';

// How often the files are re-read. Fast enough that a phase change feels
// immediate, slow enough that a campaign directory being rewritten under us is
// re-read rather than fought over.
const POLL_MS = 500;

// Where a ticket row's title starts: '  ' + glyph + ' ' + id + '  ' + status(11) + ' '.
// One constant because two things must agree — the width a title is wrapped to and
// the column its continuation rows align at — and they drift the moment they are
// written out twice.
const TITLE_COL = 22;

export function mount() {
  return render(<Dashboard />, { exitOnCtrlC: false });
}

type View =
  | { name: 'active' }
  | { name: 'journal' }
  | { name: 'help' }
  | { name: 'requirements' }
  | { name: 'tickets' }
  | { name: 'graph' }
  | { name: 'ticket'; id: string; from: 'tickets' | 'graph' | 'active' }
  | { name: 'inspect'; label: string };
type Frame = { rows: number; cols: number };

const KIND_ICON: Record<string, string> = {
  close: '✓', attempt: '✗', status: '⇢', add: '+', decompose: '⑂',
  recovered: '▲', 'recover-refused': '▲', parked: '⏸', sweep: '◎', 'campaign-gate-close': '■',
  'gate-red': '‼', escalation: '‼', 'flake-probe': '≈',
  'gate-replaced': '⚠', 'gate-refused': '⚠', 'recover-out-of-bounds': '⚠',
  'integration-red': '‼', verify: '·', kickoff: '◈', seed: '◈', init: '◈',
};

const STATUS_GLYPH: Record<string, [string, string | undefined]> = {
  closed: ['✓', 'green'], 'in-flight': ['⚙', 'cyan'], parked: ['✖', 'red'],
  open: ['·', 'gray'], waiting: ['⋯', 'yellow'],
  decomposed: ['⑂', 'gray'],
};

const FILTERS: { name: string; test: (j: JournalEntry) => boolean }[] = [
  { name: 'all', test: () => true },
  { name: 'progress', test: j => ['close', 'campaign-gate-close', 'add', 'decompose'].includes(j.kind) },
  { name: 'problems', test: j => ['attempt', 'recovered', 'recover-refused', 'parked', 'gate-red', 'integration-red', 'escalation', 'flake-probe'].includes(j.kind) },
];

function Dashboard() {
  const snap = usePolledSnapshot();
  const [view, setView] = useState<View>({ name: 'active' });
  const [activeSel, setActiveSel] = useState(0);
  const [ticketSel, setTicketSel] = useState(0);
  const [requirementSel, setRequirementSel] = useState(0);
  const [graphSel, setGraphSel] = useState(0);
  const [journalOff, setJournalOff] = useState(0); // 0 = follow the tail
  const [filterIdx, setFilterIdx] = useState(0);
  const { stdout } = useStdout();
  const rows = stdout.rows || 30;   // || not ??: a bare pty reports 0
  const cols = Math.max(60, stdout.columns || 100);

  const b = snap.backlog;
  const active = activeRows(snap);
  const tickets = ticketList(b);
  const graph = railGraph(tickets);

  // Nothing to tear down and nothing to kill: quitting a reader ends the reader.
  function quit() {
    process.stdout.write('\x1b[?1049l\x1b[?25h');
    process.exit(0);
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return quit();

    if (view.name === 'help') { if (key.escape || input === 'q' || input === '?') setView({ name: 'active' }); return; }
    if (view.name === 'ticket') {
      if (key.escape || input === 'q')
        setView(view.from === 'graph' ? { name: 'graph' } : view.from === 'active' ? { name: 'active' } : { name: 'tickets' });
      return;
    }

    if (view.name === 'requirements') {
      const count = b?.requirements?.length ?? 0;
      if (key.escape || input === 'q' || input === 'R') return setView({ name: 'active' });
      if (key.upArrow || input === 'k') setRequirementSel(selection => Math.max(0, selection - 1));
      if (key.downArrow || input === 'j')
        setRequirementSel(selection => Math.min(Math.max(0, count - 1), selection + 1));
      return;
    }

    if (view.name === 'tickets') {
      if (key.escape || input === 'q') return setView({ name: 'active' });
      if (input === 'g') { setGraphSel(0); return setView({ name: 'graph' }); }
      if (key.upArrow || input === 'k') setTicketSel(s => Math.max(0, s - 1));
      if (key.downArrow || input === 'j') setTicketSel(s => Math.min(tickets.length - 1, s + 1));
      if (key.return && tickets.length) setView({ name: 'ticket', id: tickets[clamp(ticketSel, tickets.length)]!.id, from: 'tickets' });
      return;
    }

    if (view.name === 'graph') {
      if (key.escape || input === 'q') return setView({ name: 'active' });
      if (input === 't') { setTicketSel(0); return setView({ name: 'tickets' }); }
      if (input === '?') return setView({ name: 'help' });
      if (key.upArrow || input === 'k') setGraphSel(s => Math.max(0, s - 1));
      if (key.downArrow || input === 'j') setGraphSel(s => Math.min(graph.order.length - 1, s + 1));
      if (key.return && graph.order.length) setView({ name: 'ticket', id: graph.order[clamp(graphSel, graph.order.length)]!, from: 'graph' });
      return;
    }

    if (view.name === 'inspect') {
      if (key.escape || input === 'q') return setView({ name: 'active' });
      return;
    }

    if (view.name === 'journal') {
      if (key.tab || key.escape || input === 'q') return setView({ name: 'active' });
      if (input === '?') return setView({ name: 'help' });
      if (input === 'f') { setFilterIdx(i => (i + 1) % FILTERS.length); return setJournalOff(0); }
      if (key.upArrow || input === 'k') setJournalOff(o => o + 1);
      if (key.downArrow || input === 'j') setJournalOff(o => Math.max(0, o - 1));
      if (key.pageUp) setJournalOff(o => o + 10);
      if (key.pageDown) setJournalOff(o => Math.max(0, o - 10));
      if (key.return) setJournalOff(0);
      return;
    }

    // --- active ---
    if (input === '?') return setView({ name: 'help' });
    if (key.tab) return setView({ name: 'journal' });
    if (input === 'R') { setRequirementSel(0); return setView({ name: 'requirements' }); }
    if (input === 't') { setTicketSel(0); return setView({ name: 'tickets' }); }
    if (input === 'g') { setGraphSel(0); return setView({ name: 'graph' }); }
    if (input === 'q') return quit();

    if (key.upArrow || input === 'k') setActiveSel(s => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') setActiveSel(s => Math.min(Math.max(0, active.length - 1), s + 1));
    // The two grains drill into different things: a ticket into its contract and
    // history, a run into what it is printing.
    if (key.return && active.length) {
      const row = active[clamp(activeSel, active.length)]!;
      setView(row.kind === 'ticket'
        ? { name: 'ticket', id: row.ticket.id, from: 'active' }
        : { name: 'inspect', label: row.run.label });
    }
  });

  const frame: Frame = { rows, cols };
  if (view.name === 'help') return <HelpView {...frame} />;
  if (view.name === 'requirements')
    return <RequirementsView {...frame} b={b} sel={clamp(requirementSel, b?.requirements?.length ?? 0)} />;
  if (view.name === 'tickets') return <TicketsView {...frame} tickets={tickets} sel={clamp(ticketSel, tickets.length)} />;
  if (view.name === 'graph') return <GraphView {...frame} graph={graph} sel={clamp(graphSel, graph.order.length)} />;
  if (view.name === 'ticket') return <TicketDetailView {...frame} ticket={tickets.find(t => t.id === view.id)} all={tickets} />;
  if (view.name === 'journal') return <JournalView {...frame} snap={snap} journalOff={journalOff} filterIdx={filterIdx} />;
  if (view.name === 'inspect')
    return <RunTailView {...frame} run={snap.runs.find(r => r.label === view.label)} label={view.label} />;
  return <ActiveView {...frame} snap={snap} active={active} activeSel={clamp(activeSel, active.length)} />;
}

// --- active view: in-flight tickets, and the checks running inside them ------

// The pane is ticket-oriented, and that is the pivot rather than a layout choice.
// It used to list processes, because the coordinator owned them and could be asked
// what was running. A reader cannot have that list: most of a ticket's life is an
// agent inside the coordinator's own session, invisible from here. What IS
// knowable is where each in-flight ticket has got to and how long it has been
// there — the same question, asked at the grain the files can answer.
function ActiveView({ rows, cols, snap, active, activeSel }: Frame & {
  snap: Snapshot; active: ActiveRow[]; activeSel: number;
}) {
  const b = snap.backlog;
  return (
    <Box flexDirection="column" width={cols}>
      <Header cols={cols} snap={snap} />
      <Rule cols={cols} />
      {b && <>
        <GatePanel b={b} cols={cols} />
        <Rule cols={cols} />
        <CountsLine b={b} cols={cols} />
        <Rule cols={cols} />
      </>}
      <Text bold>
        {`▸ in flight${active.length ? '' : '  (nothing in flight)'}`}
        <Text dimColor>   active · journal (tab)</Text>
      </Text>
      {active.map((row, i) => (
        <ActiveRowLine key={row.key} row={row} selected={i === activeSel} cols={cols} caps={b?.caps} />
      ))}
      <Rule cols={cols} />
      <Footer cols={cols}
        hint="tab journal · R requirements · t tickets · g graph · ↵ detail · q quit · ? help" />
    </Box>
  );
}

function ActiveRowLine({ row, selected, cols, caps }: {
  row: ActiveRow; selected: boolean; cols: number; caps: Backlog['caps'];
}) {
  if (row.kind === 'run') return <RunLine run={row.run} selected={selected} cols={cols} />;

  const t = row.ticket;
  // Merit attempts only: an infra death didn't spend the ticket's budget, and a
  // row reading 3/3 because the engine died three times would send the operator
  // to look at a ticket that never failed on its own terms.
  const merit = (t.attempts ?? []).filter(a => !a.infra).length;
  const max = caps?.maxAttempts ?? 3;
  const phase = t.phase;
  const held = phase ? Date.now() - Date.parse(phase.at) : null;
  return (
    <Text inverse={selected}>
      {`  ⚙ ${t.id.padEnd(6)} `}
      {phase
        ? <Text color={PHASE_COLOR[phase.name]}>{phase.name.padEnd(13)}</Text>
        : <Text dimColor>{'—'.padEnd(13)}</Text>}
      {held === null ? '        ' : `${dur(held).padEnd(8)}`}
      <Text dimColor>{`${merit}/${max} `}</Text>
      {t.dispatch ? <Text dimColor>{`${t.dispatch.model} `}</Text> : null}
      {trunc(t.title, Math.max(10, cols - 48))}
    </Text>
  );
}

// A check the operator can actually watch, because a verb published it. Indented
// under its ticket: this is the one place in the pane where the tail is real
// output rather than a state field.
function RunLine({ run, selected, cols }: { run: LiveRun; selected: boolean; cols: number }) {
  const last = run.tail.at(-1);
  const line = run.partial || last?.line || '';
  return (
    <Text inverse={selected}>
      {`      $ ${trunc(run.label, 24).padEnd(24)} ${dur(Date.now() - run.startedAt).padEnd(7)} `}
      {line ? <Text color="cyan">{trunc(line, Math.max(10, cols - 48))}</Text> : <Text dimColor>(starting)</Text>}
    </Text>
  );
}

const PHASE_COLOR: Record<string, string> = {
  dispatched: 'cyan', verifying: 'blue', 'under-review': 'magenta',
  probing: 'yellow', merging: 'green',
};

function Header({ cols, snap }: { cols: number; snap: Snapshot }) {
  const b = snap.backlog;
  const title = ` loop watch — ${b?.project ?? '(no campaign)'}`;
  const started = b?.startedAt ? Date.parse(b.startedAt) : null;
  const elapsed = started ? `elapsed ${dur(snap.readAt - started)} · ` : '';
  const stale = staleness(snap);
  return (
    <Text bold>
      {title}{' '.repeat(Math.max(1, cols - title.length - elapsed.length - 18))}
      <Text dimColor>{elapsed}</Text>
      <StalenessCell stale={stale} />
    </Text>
  );
}

// NOT liveness. The old cell sampled process-subtree CPU and could say "this is
// working" — it had a pid. Here there is usually no process to sample: the
// coordinator's own agents run in a session this program cannot see, so all the
// files support is "how long since anything was written". A quiet campaign and a
// dead one look identical, and the wording has to admit that rather than dress a
// timestamp up as a heartbeat.
function StalenessCell({ stale }: { stale: Staleness }) {
  if (stale.grade === 'unknown') return <Text dimColor>{'no journal yet '}</Text>;
  if (stale.grade === 'active' && stale.quietForMs === 0) return <Text color="green">{'▶ check running '}</Text>;
  const quiet = `quiet ${dur(stale.quietForMs ?? 0)} `;
  if (stale.grade === 'active') return <Text dimColor>{quiet}</Text>;
  return <Text color={stale.grade === 'stale' ? 'red' : 'yellow'}>{quiet}</Text>;
}

function GatePanel({ b }: { b: Backlog; cols: number }) {
  const ts = b.tickets.filter(t => t.status !== 'decomposed');
  const done = ts.filter(t => t.status === 'closed').length;
  const live = ts.filter(t => t.status !== 'closed').length;
  const last = b.gateState?.lastRun;
  const current = last?.tickets === b.tickets.length
    && last.closed === b.tickets.filter(ticket => ticket.status === 'closed').length;
  const gate = !b.gate?.length ? <Text dimColor>[no gate]</Text>
    : b.gateState?.parked ? <Text color="red">[gate parked]</Text>
    : last?.result === 'green' && current ? <Text color="green">[gate ✓]</Text>
    : last?.result === 'red' && current ? <Text color="red">[gate ✗]</Text>
    : live === 0 ? <Text color="yellow">[gate …]</Text>
    : <Text> </Text>;
  // Two bars, because they answer different questions and can disagree: the
  // first is the backlog closing itself out, the second is how much of the SPEC
  // that accounts for. A campaign can be 8/8 tickets with a clause nobody
  // claimed, and only the lower bar says so.
  const cov = b.requirements?.length ? coverage(b) : null;
  return (
    <>
      <Text>
        {'  '}<Bar done={done} total={ts.length} width={24} />
        {` ${String(done).padStart(2)}/${ts.length}  `}{gate}
      </Text>
      {cov && (
        <Text>
          {'  '}<Bar done={cov.proven.length} total={cov.requirements} width={24} />
          {` ${String(cov.proven.length).padStart(2)}/${cov.requirements}  `}
          {cov.unmapped.length
            ? <Text color="yellow">[{cov.unmapped.length} clause{cov.unmapped.length > 1 ? 's' : ''} unclaimed]</Text>
            : <Text dimColor>[spec]</Text>}
        </Text>
      )}
    </>
  );
}

// Spend used to live on this line, tallied from the token counts the in-process
// agent runner read off each stream. Nothing reports those to the coordinator now,
// so what the files carry is whatever a `close` was handed — see postmortem.ts,
// which prices what it has and says so. Rather than render a running total that
// silently means "the subset of workers whose tokens someone passed along", the
// line shows what it can count exactly and leaves cost to the post-mortem.
function CountsLine({ b, cols }: { b: Backlog; cols: number }) {
  const counts = b.tickets.reduce<Record<string, number>>((m, t) => ((m[t.status] = (m[t.status] || 0) + 1), m), {});
  const attempts = b.tickets.reduce((n, t) => n + (t.attempts?.length ?? 0), 0);
  const merit = b.tickets.reduce((n, t) => n + (t.attempts ?? []).filter(a => !a.infra).length, 0);
  const line = ' ' + ['open', 'waiting', 'in-flight', 'closed', 'parked']
    .filter(s => counts[s]).map(s => `${counts[s]} ${s}`).join(' · ')
    + `   attempts ${attempts} (${merit} merit)`;
  // Wrapped here rather than left to Ink, whose continuation starts at column 0 and
  // reads as a stray line rather than as the rest of this one.
  return <>{wrapText(line, cols, 1).map((l, i) => <Text key={i}>{l}</Text>)}</>;
}

// --- journal view (its own tab) ---------------------------------------------

// Scrolling is by ROW, not by entry: a park reason is a paragraph, and an entry
// that occupies six rows must cost six rows of the frame or the pane overflows.
// The whole point of the pane is that the reason a campaign stopped is legible
// here, which was exactly what cutting at the right edge took away.
function JournalView({ rows, cols, snap, journalOff, filterIdx }: Frame & {
  snap: Snapshot; journalOff: number; filterIdx: number;
}) {
  const filter = FILTERS[filterIdx]!;
  const entries = snap.journal.filter(filter.test);
  const feedRows = Math.max(3, rows - 3);
  const lines = entries.flatMap(j =>
    wrapText(`  ${hhmm(Date.parse(j.ts))} ${KIND_ICON[j.kind] ?? '·'} ${String(j.subject ?? '').padEnd(8)} ${j.body ?? ''}`, cols - 1, 12)
      .map(line => ({ j, line })));
  const off = Math.min(journalOff, Math.max(0, lines.length - feedRows));
  const visible = lines.slice(Math.max(0, lines.length - off - feedRows), lines.length - off || undefined);
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>
        {` journal · ${filter.name}`}{off ? <Text dimColor>{` · ↑${off}`}</Text> : null}
        <Text dimColor>   (tab → active)</Text>
      </Text>
      <Rule cols={cols} />
      {visible.map((l, i) => <JournalLine key={i} j={l.j} line={l.line} />)}
      <Footer cols={cols} hint="tab active · j/k scroll · f filter · ↵ tail · esc back" />
    </Box>
  );
}

function JournalLine({ j, line }: { j: JournalEntry; line: string }) {
  const warm = ['gate-red', 'escalation', 'integration-red', 'attempt'].includes(j.kind);
  return <Text color={warm ? 'red' : undefined} dimColor={j.kind === 'verify'}>{line}</Text>;
}

// --- requirement contract ---------------------------------------------------

function RequirementsView({ rows, cols, b, sel }: Frame & {
  b: Backlog | null | undefined;
  sel: number;
}) {
  const requirements = b?.requirements ?? [];
  const tickets = b?.tickets ?? [];
  const entries = requirements.map(requirement => {
    const claimants = tickets.filter(ticket =>
      ticket.status !== 'decomposed' && ticket.satisfies?.includes(requirement.id));
    const state = !tickets.length ? 'enumerated'
      : !claimants.length ? 'unclaimed'
        : claimants.every(ticket => ticket.status === 'closed') ? 'proven' : 'claimed';
    const mark = state === 'proven' ? '✓'
      : state === 'unclaimed' ? '!'
        : state === 'claimed' ? '◐' : '·';
    const suffix = claimants.length ? `  [${claimants.map(ticket => ticket.id).join(', ')}]` : '';
    return {
      state,
      lines: wrapText(`  ${mark} ${requirement.id}  ${requirement.clause}${suffix}`, cols - 1, 10),
    };
  });
  const [start, end] = windowAround(
    entries.map(entry => entry.lines.length),
    sel,
    Math.max(3, rows - 3),
  );
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>
        {` requirements (${requirements.length})`}
        {!tickets.length ? <Text dimColor> · decomposition pending</Text> : null}
      </Text>
      <Rule cols={cols} />
      {entries.slice(start, end).map((entry, offset) => {
        const selected = start + offset === sel;
        const color = entry.state === 'proven' ? 'green'
          : entry.state === 'unclaimed' ? 'yellow'
            : entry.state === 'claimed' ? 'cyan' : undefined;
        return (
          <Box key={start + offset} flexDirection="column">
            {entry.lines.map((line, row) => (
              <Text key={row} inverse={selected} color={color}>{line}</Text>
            ))}
          </Box>
        );
      })}
      <Footer cols={cols} hint="j/k move · R/esc back" />
    </Box>
  );
}

// --- ticket browser ----------------------------------------------------------

function ticketList(b: Backlog | null | undefined): Ticket[] {
  if (!b) return [];
  return [...b.tickets].sort((x, y) => x.id.localeCompare(y.id));
}

// `waiting` is derived, not stored (frontier.ts owns the same split): an open
// ticket with a still-open dependency shows as waiting rather than dispatchable.
function displayStatus(t: Ticket, byId: Map<string, Ticket>): string {
  if (t.status !== 'open') return t.status;
  return (t.depends_on ?? []).every(d => byId.get(d)?.status === 'closed') ? 'open' : 'waiting';
}

function TicketsView({ rows, cols, tickets, sel }: Frame & { tickets: Ticket[]; sel: number }) {
  const listRows = Math.max(3, rows - 3);
  const byId = new Map(tickets.map(t => [t.id, t]));
  // A wrapped title makes a ticket taller than one row, so the window is computed
  // from real heights and grown around the selection rather than from a fixed
  // count of tickets.
  const shownRows = tickets.map(t => {
    const deps = t.depends_on?.length ? `  ⇐ ${t.depends_on.join(',')}` : '';
    // Wrapped to the width available AFTER the row's prefix, with the indent
    // rendered below rather than passed in: wrapText counts a continuation column
    // against its width, so asking it to indent here would give the continuation
    // rows a third of the room the first row had.
    return { t, deps, title: wrapText(t.title, Math.max(12, cols - TITLE_COL - deps.length - 2)) };
  });
  const [start, end] = windowAround(shownRows.map(r => r.title.length), sel, listRows);
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>{` tickets (${tickets.length})`}</Text>
      <Rule cols={cols} />
      {shownRows.slice(start, end).map(({ t, deps, title }, i) => {
        const shown = displayStatus(t, byId);
        const [glyph, color] = STATUS_GLYPH[shown] ?? ['·', undefined];
        const selected = start + i === sel;
        return (
          <Box key={t.id} flexDirection="column">
            <Text inverse={selected}>
              {'  '}<Text color={color}>{glyph}</Text>
              {` ${t.id}  ${shown.padEnd(11)} ${title[0] ?? ''}`}
              <Text dimColor>{deps}</Text>
            </Text>
            {/* The rest of a long title, aligned under it — same highlight, so a
                selected ticket reads as one block rather than as two rows. */}
            {title.slice(1).map((line, k) => (
              <Text key={k} inverse={selected}>{' '.repeat(TITLE_COL) + line}</Text>
            ))}
          </Box>
        );
      })}
      <Footer cols={cols} hint="j/k move · ↵ detail · g graph · esc back" />
    </Box>
  );
}

function TicketDetailView({ rows, cols, ticket: t, all }: Frame & { ticket: Ticket | undefined; all: Ticket[] }) {
  if (!t) return <Text>ticket vanished — esc to go back</Text>;
  const byId = new Map(all.map(x => [x.id, x]));
  const shown = displayStatus(t, byId);
  const [glyph, color] = STATUS_GLYPH[shown] ?? ['·', undefined];
  const depGlyph = (id: string) => (STATUS_GLYPH[byId.get(id)?.status ?? '']?.[0]) ?? '?';
  const unblocks = all.filter(x => x.depends_on?.includes(t.id)).map(x => x.id);

  // Labels are right-aligned into a 7-character column, so the leading spaces are
  // the layout and every value — wrapped or not — lives at column 8.
  const field = (text: string, style: Omit<Row, 'text'> = {}, col = 8): Row[] =>
    wrapText(text, cols - 1, col).map(line => ({ text: line, ...style }));
  const head: Row[] = [
    ...field(` status ${glyph} ${shown}`, { color }),
    ...field(`   deps ${t.depends_on?.length ? t.depends_on.map(d => `${depGlyph(d)} ${d}`).join('   ') : '(none)'}`),
    ...field(`   unblocks ${unblocks.length ? unblocks.join(', ') : '(none)'}`, {}, 12),
    ...field(`modules ${t.modules?.join(', ') || '(unscoped)'}`),
    ...(t.origin ? field(` origin ${t.origin}`, { dim: true }) : []),
    { text: ' ' },
  ];
  const attemptRows: Row[] = [];
  detailRows(t, cols, r => head.push(r), r => attemptRows.push(r));

  // The contract is always shown; the attempts yield to the frame, newest kept —
  // and whatever does not fit is declared rather than silently dropped, since a
  // pane that hides evidence without saying so is how the incident stayed
  // misdiagnosed for an hour.
  // The heading wraps too on a narrow terminal, so it is wrapped here rather than
  // left to Ink (whose continuation starts at column 0) and its real height is
  // measured — a budget that assumes one row overflows the frame by however many
  // rows the title actually took.
  const titleRows = wrapText(` ${t.id} — ${t.title}`, cols, 1);
  const budget = Math.max(1, rows - 3 - titleRows.length);
  const room = budget - head.length;
  const visible = room > 0 ? [...head, ...attemptRows.slice(-room)] : head.slice(0, budget);
  const hidden = (head.length + attemptRows.length) - visible.length;
  return (
    <Box flexDirection="column" width={cols}>
      {titleRows.map((line, i) => <Text key={i} bold>{line}</Text>)}
      <Rule cols={cols} />
      {visible.map((r, i) => <Text key={i} color={r.color} dimColor={r.dim} bold={r.bold}>{r.text}</Text>)}
      {hidden > 0 ? <Text dimColor>{` … ${hidden} more row(s) than this terminal has`}</Text> : null}
      <Footer cols={cols} hint="esc back" />
    </Box>
  );
}

// A styled display row. Panes that wrap build these instead of nesting <Text>,
// because a wrapped span cannot carry a sub-span's colour across a row boundary.
type Row = { text: string; color?: string; dim?: boolean; bold?: boolean };

// The detail body as rows, wrapped: the ticket's contract and every attempt's
// hypothesis are the prose a human reads to decide what went wrong, and this is
// the only place either is shown.
function detailRows(t: Ticket, cols: number, head: (r: Row) => void, attempts: (r: Row) => void): void {
  const add = (into: (r: Row) => void) => (text: unknown, style: Omit<Row, 'text'> = {}, indent = 0) => {
    for (const line of wrapText(text, cols - 1, indent)) into({ text: line, ...style });
  };
  const h = add(head), a = add(attempts);

  h(' acceptance', { bold: true });
  h(`  ${t.acceptance}`, {}, 2);
  for (const c of t.acceptanceChecks ?? []) h(`   $ ${c.cmd}`, { dim: true }, 5);
  h(' ');
  h(` attempts (${t.attempts?.length ?? 0})`, { bold: true });

  for (const at of t.attempts ?? []) {
    a(`  ✗ [${Array.isArray(at.failed) ? at.failed.join(',') : at.failed}]`, { color: 'red' }, 4);
    a(`    ${at.hypothesis ?? ''}`, {}, 4);
    if (at.fix) a(`    fix: ${at.fix}`, { dim: true }, 9); // under the text after 'fix: '
  }
}

// --- dependency graph: the backlog DAG as git-log-style rails ---------------
// A DAG has many parents per node, which no indented tree can draw without
// either dropping edges or duplicating nodes. So we lay it out the way git draws
// commit history — vertical lanes that branch and merge (railgraph.ts) — and
// solve the one thing static rails can't: at a shared crossing, box-drawing
// renders a real junction and a mere pass-through identically. The selected
// ticket's own edges are lit; every other lane and crossing is dimmed, so its
// dependencies read off unambiguously. j/k moves the selection, driving what's lit.

// A styled run of same-looking characters, coalesced so one line is a handful of
// <Text> spans rather than one per character.
type Run = { text: string; color?: string; dim?: boolean; bold?: boolean };
const runKey = (r: Omit<Run, 'text'>) => `${r.color ?? ''}|${r.dim ? 1 : 0}|${r.bold ? 1 : 0}`;

function railRuns(l: RailLine, li: number, g: RailGraph, arms: Map<string, number>, role: (id: string) => 'sel' | 'end' | 'other'): Run[] {
  const runs: Run[] = [];
  const push = (ch: string, s: Omit<Run, 'text'>) => {
    const last = runs[runs.length - 1];
    if (last && runKey(last) === runKey(s)) last.text += ch;
    else runs.push({ text: ch, ...s });
  };
  const railChars = [...l.rail];
  const nodePos = l.kind === 'node' ? l.nodePos : -1;
  for (let p = 0; p < g.gutter; p++) {
    if (p === nodePos && l.kind === 'node') {
      const [gl, color] = STATUS_GLYPH[l.status] ?? ['·', undefined];
      const r = role(l.id);
      push(gl, { color, bold: r !== 'other', dim: r === 'other' });
      continue;
    }
    const ch = railChars[p] ?? ' ';
    if (ch === ' ') { push(' ', {}); continue; }
    const lit = (arms.get(`${li},${p}`) ?? 0) & g.bitsFor(ch);
    if (lit) push(g.glyph(lit), { color: 'cyan', bold: true });
    else push(ch, { dim: true });
  }
  return runs;
}

function GraphView({ rows: termRows, cols, graph, sel }: Frame & { graph: RailGraph; sel: number }) {
  if (!graph.order.length) return <EmptyGraph cols={cols} />;
  const selId = graph.order[sel]!;
  const selLine = graph.nodeLineIndex.get(selId)!;
  const arms = graph.litArms(selId);
  const endpoints = graph.endpoints(selId);
  const role = (id: string): 'sel' | 'end' | 'other' => (id === selId ? 'sel' : endpoints.has(id) ? 'end' : 'other');
  const labelRoom = Math.max(6, cols - graph.gutter - 3);

  const listRows = Math.max(3, termRows - 3);
  const start = Math.max(0, Math.min(selLine - Math.floor(listRows / 2), graph.lines.length - listRows));
  const visible = graph.lines.slice(start, start + listRows);
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>
        {` dependency graph (${graph.order.length})`}
        <Text dimColor>{`   ${selId} · its edges lit — deps above ↑ / dependents below ↓`}</Text>
      </Text>
      <Rule cols={cols} />
      {visible.map((l, i) => {
        const li = start + i;
        const runs = railRuns(l, li, graph, arms, role);
        return (
          <Text key={li}>
            {runs.map((r, j) => <Text key={j} color={r.color} dimColor={r.dim} bold={r.bold}>{r.text}</Text>)}
            {l.kind === 'node' ? <GraphLabel l={l} room={labelRoom} role={role(l.id)} /> : null}
          </Text>
        );
      })}
      <Footer cols={cols} hint="j/k select · ↵ detail · t list · esc back" />
    </Box>
  );
}

function GraphLabel({ l, room, role }: { l: Extract<RailLine, { kind: 'node' }>; room: number; role: 'sel' | 'end' | 'other' }) {
  const text = `  ${trunc(`${l.id} ${l.title}`, room)}`;
  return <Text bold={role === 'sel'} dimColor={role === 'other'}>{text}</Text>;
}

function EmptyGraph({ cols }: { cols: number }) {
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold> dependency graph</Text>
      <Rule cols={cols} />
      <Text dimColor> no tickets yet — esc to go back</Text>
      <Footer cols={cols} hint="esc back" />
    </Box>
  );
}

// --- inspect: a running check's output ---------------------------------------

// Only checks get a tail view now. An agent's transcript used to live here too,
// streamed off the CLI this program spawned; the coordinator spawns its own, so
// there is nothing to stream. The journal carries the verdict, which is the part
// that was ever load-bearing.
function RunTailView({ rows, cols, run, label }: Frame & { run: LiveRun | undefined; label: string }) {
  if (!run) {
    return (
      <Box flexDirection="column" width={cols}>
        <Text bold>{` $ ${label}`}</Text>
        <Rule cols={cols} />
        <Text dimColor> the check finished — its result is in the journal. esc to go back.</Text>
        <Footer cols={cols} hint="esc back" />
      </Box>
    );
  }
  // The in-progress line (a progress bar, a prompt) gets a fixed live region;
  // completed output history yields to it.
  const liveRows = run.partial ? 2 : 0;
  const lines = run.tail
    .flatMap(l => wrapText(`${hhmm(l.ts)} ${l.line}`, cols - 1, 9).map(line => ({ ts: l.ts, line })))
    .slice(-(Math.max(3, rows - 5 - liveRows)));
  const last = run.tail.at(-1);
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>
        {` $ ${label} · ${dur(Date.now() - run.startedAt)}`}
        {run.ticketId ? <Text dimColor>{` · ${run.ticketId}`}</Text> : null}
        {last ? <Text dimColor>{` · last line ${dur(Date.now() - last.ts)} ago`}</Text> : null}
      </Text>
      {wrapText(`   ${run.cmd}`, cols - 1, 5).map((line, i) => <Text key={i} dimColor>{line}</Text>)}
      <Rule cols={cols} />
      {lines.length ? lines.map((l, i) => (
        <Text key={i}>{l.line}</Text>
      )) : <Text dimColor> (no output yet — the process is starting)</Text>}
      {run.partial ? <>
        <Rule cols={cols} />
        {/* The in-progress line keeps its fixed budget: a progress bar rewriting
            itself must not resize the pane on every write. */}
        <Text color="cyan">{` ${trunc(run.partial, cols - 3)}`}<Text color="cyan">▌</Text></Text>
      </> : null}
      <Footer cols={cols} hint="esc back" />
    </Box>
  );
}

// --- help --------------------------------------------------------------------

function HelpView({ cols }: Frame) {
  const keys: [string, string][] = [
    ['tab', 'switch between the active work and the journal'],
    ['j/k ↑/↓', 'move selection / scroll the journal'],
    ['↵', 'ticket detail, or the selected check’s live output'],
    ['t', 'ticket browser'],
    ['R', 'requirements — the locked clauses and their claiming tickets'],
    ['g', 'dependency graph — rails; j/k lights the selected ticket’s edges'],
    ['f', `journal filter (${FILTERS.map(f => f.name).join(' → ')})`],
    ['q', 'quit — this is a reader; the campaign is unaffected'],
  ];
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold> keys</Text>
      <Rule cols={cols} />
      {keys.map(([k, desc]) => <Text key={k}>{`  ${k.padEnd(9)} ${desc}`}</Text>)}
      <Rule cols={cols} />
      {/* Said here because the absence of these keys is the surprise, for anyone
          who used the version that had them. */}
      <Text dimColor>{'  no pause, cap, or kill: the coordinator runs in a session this'}</Text>
      <Text dimColor>{'  process cannot reach, so every control here would be a suggestion.'}</Text>
      <Footer cols={cols} hint="esc back" />
    </Box>
  );
}

// --- shared bits ---------------------------------------------------------------

function Rule({ cols }: { cols: number }) {
  return <Text dimColor>{'─'.repeat(cols)}</Text>;
}

function Footer({ cols, hint }: { cols: number; hint: string }) {
  return <Text dimColor>{trunc(` ${hint}`, cols - 1)}</Text>;
}

function Bar({ done, total, width }: { done: number; total: number; width: number }) {
  const filled = total ? Math.round((done / total) * width) : 0;
  return <Text color="green">{'█'.repeat(filled)}<Text dimColor>{'░'.repeat(width - filled)}</Text></Text>;
}

// The whole update mechanism: re-read the files, re-render. There is nothing to
// subscribe to — the writer is another process — so the interval is both the
// clock (durations tick) and the data source.
function usePolledSnapshot(): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(readSnapshot);
  useEffect(() => {
    const t = setInterval(() => setSnap(readSnapshot()), POLL_MS);
    return () => clearInterval(t);
  }, []);
  return snap;
}

const clamp = (i: number, len: number) => Math.max(0, Math.min(i, len - 1));
const trunc = (s: unknown, n: number): string => {
  const t = String(s).replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t;
};
