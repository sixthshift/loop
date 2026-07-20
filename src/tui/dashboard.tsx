// The interactive face of a running campaign. The main screen is the live work
// — every agent and script running right now, each drillable into its realtime
// output; the journal lives one `tab` away. Acting is deliberately narrow:
// every mutation goes through control.ts flags the drive loop honors at its next
// decision point, or a child-process kill that settles as an ordinary failed
// attempt. The dashboard never writes campaign state: kill it, `loop resume`,
// and the picture rebuilds from the journal.

import React, { useEffect, useState } from 'react';
import { render, Box, Text, useInput, useStdout } from 'ink';
import { store, subscribe, log, hhmm, dur } from './tui.ts';
import type { AgentView, ScriptView } from './tui.ts';
import { backlog } from '../campaign/backlog.ts';
import { campaignExists } from '../campaign/index.ts';
import { journalTail } from '../campaign/journal.ts';
import type { Backlog, Ticket } from '../campaign/backlog.ts';
import type { JournalEntry } from '../campaign/journal.ts';
import { control, killAgent, killAllAgents } from './control.ts';
import { liveness } from './liveness.ts';
import type { Liveness as LivenessSample } from './liveness.ts';

export function mount() {
  return render(<Dashboard />, { exitOnCtrlC: false });
}

// A live process the operator can inspect — a claude agent or an shAsync script.
type Proc =
  | { kind: 'agent'; label: string; a: AgentView }
  | { kind: 'script'; label: string; s: ScriptView };

type View =
  | { name: 'active' }
  | { name: 'journal' }
  | { name: 'help' }
  | { name: 'tickets' }
  | { name: 'ticket'; id: string }
  | { name: 'inspect'; kind: 'agent' | 'script'; label: string };
type Confirm = { text: string; onYes: () => void } | null;
type Frame = { rows: number; cols: number; confirm: Confirm };

const KIND_ICON: Record<string, string> = {
  close: '✓', attempt: '✗', status: '⇢', add: '+', vet: '✔', decompose: '⑂',
  triage: '▲', 'triage-refused': '▲', review: '◎', 'phase-close': '■',
  'gate-red': '‼', escalation: '‼', 'accepted-risk': '⚑', 'flake-probe': '≈',
  'integration-red': '‼', verify: '·', intake: '◈', seed: '◈', init: '◈',
};

const STATUS_GLYPH: Record<string, [string, string | undefined]> = {
  closed: ['✓', 'green'], 'in-flight': ['⚙', 'cyan'], blocked: ['✖', 'red'],
  'failed-wall': ['‼', 'red'], vetted: ['○', undefined], draft: ['·', 'gray'],
  decomposed: ['⑂', 'gray'],
};

const FILTERS: { name: string; test: (j: JournalEntry) => boolean }[] = [
  { name: 'all', test: () => true },
  { name: 'progress', test: j => ['close', 'phase-close', 'vet', 'add', 'decompose'].includes(j.kind) },
  { name: 'problems', test: j => ['attempt', 'triage', 'triage-refused', 'gate-red', 'integration-red', 'escalation', 'flake-probe'].includes(j.kind) },
];

function procList(): Proc[] {
  return [
    ...[...store.agents.entries()].map(([label, a]): Proc => ({ kind: 'agent', label, a })),
    ...[...store.scripts.entries()].map(([label, s]): Proc => ({ kind: 'script', label, s })),
  ];
}

function Dashboard() {
  useTick();
  const [view, setView] = useState<View>({ name: 'active' });
  const [procSel, setProcSel] = useState(0);
  const [ticketSel, setTicketSel] = useState(0);
  const [journalOff, setJournalOff] = useState(0); // 0 = follow the tail
  const [filterIdx, setFilterIdx] = useState(0);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const { stdout } = useStdout();
  const rows = stdout.rows || 30;   // || not ??: a bare pty reports 0
  const cols = Math.max(60, stdout.columns || 100);

  const b = safe(() => (campaignExists() ? backlog() : null));
  const procs = procList();
  const tickets = ticketList(b);

  function quit() {
    killAllAgents(); // stale in-flight reconciliation re-judges surviving branches on resume
    process.stdout.write('\x1b[?1049l\x1b[?25h');
    console.log('stopped by operator — campaign state intact; `loop resume` to continue.');
    process.exit(130);
  }

  // Only workers are killable; verdict agents and scripts settle on their own.
  function tryKill(label: string) {
    if (!store.agents.has(label)) return log('only workers can be killed — scripts and verdicts settle on their own');
    if (!label.startsWith('worker:')) return log('only workers can be killed — verdicts settle on their own');
    setConfirm({
      text: `kill ${label}? the attempt is journaled and the ticket redispatches fresh`,
      onYes: () => { killAgent(label); setView(v => (v.name === 'inspect' ? { name: 'active' } : v)); },
    });
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return quit();

    if (confirm) {
      if (input === 'y') { const { onYes } = confirm; setConfirm(null); onYes(); }
      else if (input === 'n' || key.escape) setConfirm(null);
      return;
    }

    if (view.name === 'help') { if (key.escape || input === 'q' || input === '?') setView({ name: 'active' }); return; }
    if (view.name === 'ticket') { if (key.escape || input === 'q') setView({ name: 'tickets' }); return; }

    if (view.name === 'tickets') {
      if (key.escape || input === 'q') return setView({ name: 'active' });
      if (key.upArrow || input === 'k') setTicketSel(s => Math.max(0, s - 1));
      if (key.downArrow || input === 'j') setTicketSel(s => Math.min(tickets.length - 1, s + 1));
      if (key.return && tickets.length) setView({ name: 'ticket', id: tickets[clamp(ticketSel, tickets.length)]!.id });
      return;
    }

    if (view.name === 'inspect') {
      if (key.escape || input === 'q') return setView({ name: 'active' });
      if (input === 'x') tryKill(view.label);
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
    if (input === 't') { setTicketSel(0); return setView({ name: 'tickets' }); }
    if (input === 'p') {
      control.paused = !control.paused;
      return log(control.paused ? '⏸ dispatch paused — in-flight workers will still settle' : '▶ dispatch resumed');
    }
    if (input === '+' || input === '=') { control.workerCap = Math.min(12, control.workerCap + 1); return log(`worker cap → ${control.workerCap}`); }
    if (input === '-') { control.workerCap = Math.max(1, control.workerCap - 1); return log(`worker cap → ${control.workerCap}`); }
    if (input === 'r') { control.forceReview = true; return log('review requested — runs at the next loop turn'); }
    if (input === 'q') return setConfirm({
      text: 'quit? in-flight workers are killed; campaign state stays intact (`loop resume`)',
      onYes: quit,
    });

    if (key.upArrow || input === 'k') setProcSel(s => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') setProcSel(s => Math.min(Math.max(0, procs.length - 1), s + 1));
    if (key.return && procs.length) {
      const p = procs[clamp(procSel, procs.length)]!;
      setView({ name: 'inspect', kind: p.kind, label: p.label });
    }
    if (input === 'x' && procs.length) {
      const p = procs[clamp(procSel, procs.length)]!;
      if (p.kind === 'script') return log('scripts finish on their own — only workers can be killed');
      tryKill(p.label);
    }
  });

  const frame: Frame = { rows, cols, confirm };
  if (view.name === 'help') return <HelpView {...frame} />;
  if (view.name === 'tickets') return <TicketsView {...frame} tickets={tickets} sel={clamp(ticketSel, tickets.length)} />;
  if (view.name === 'ticket') return <TicketDetailView {...frame} ticket={tickets.find(t => t.id === view.id)} />;
  if (view.name === 'journal') return <JournalView {...frame} journalOff={journalOff} filterIdx={filterIdx} />;
  if (view.name === 'inspect') return <InspectView {...frame} kind={view.kind} label={view.label} />;
  return <ActiveView {...frame} b={b} procs={procs} procSel={clamp(procSel, procs.length)} />;
}

// --- active view: live agents + scripts -------------------------------------

function ActiveView({ rows, cols, confirm, b, procs, procSel }: Frame & {
  b: Backlog | null | undefined; procs: Proc[]; procSel: number;
}) {
  const pids = procs.map(p => (p.kind === 'agent' ? p.a.pid : p.s.pid)).filter((x): x is number => Boolean(x));
  const live = liveness(pids);
  return (
    <Box flexDirection="column" width={cols}>
      <Header cols={cols} b={b} />
      <Rule cols={cols} />
      {b && <>
        <PhasesPanel b={b} cols={cols} />
        <Rule cols={cols} />
        <CountsLine b={b} />
        <Rule cols={cols} />
      </>}
      <Text bold>▸ active{procs.length ? '' : '  (nothing running)'}<Text dimColor>   active · journal (tab)</Text></Text>
      {procs.map((p, i) => <ProcRow key={p.label} p={p} selected={i === procSel} live={live} cols={cols} />)}
      <Rule cols={cols} />
      {store.statusLine ? <Text color="cyan">{trunc(' ' + store.statusLine, cols - 1)}</Text> : null}
      <Footer cols={cols} confirm={confirm}
        hint="tab journal · j/k move · ↵ inspect · t tickets · p pause · +/- cap · r review · x kill · q quit · ? help" />
    </Box>
  );
}

function ProcRow({ p, selected, live, cols }: { p: Proc; selected: boolean; live: Map<number, LivenessSample>; cols: number }) {
  if (p.kind === 'agent') {
    const a = p.a;
    const last = a.transcript.at(-1);
    return (
      <Text inverse={selected}>
        {`  ⚙ ${p.label.padEnd(22)} ${a.model.padEnd(7)} ${dur(Date.now() - a.startedAt).padEnd(7)} `}
        <Liveness lv={a.pid ? live.get(a.pid) : undefined} />
        {a.live?.text
          /* mid-generation: show the newest model output, not a stale event */
          ? <Text color="cyan">{` ✍ ${liveTail(a.live.text, Math.max(10, cols - 62))}`}</Text>
          : <>
              {last ? ` ${trunc(last.line, Math.max(10, cols - 70))} ` : ' '}
              {last ? <Text dimColor>{`(${dur(Date.now() - last.ts)} ago)`}</Text> : null}
            </>}
      </Text>
    );
  }
  const s = p.s;
  const last = s.output.at(-1);
  const line = s.partial || last?.line || '';
  return (
    <Text inverse={selected}>
      {`  $ ${p.label.padEnd(22)} ${''.padEnd(7)} ${dur(Date.now() - s.startedAt).padEnd(7)} `}
      <Liveness lv={s.pid ? live.get(s.pid) : undefined} />
      {line ? ` ${trunc(line, Math.max(10, cols - 62))} ` : ' '}
      {last && !s.partial ? <Text dimColor>{`(${dur(Date.now() - last.ts)} ago)`}</Text> : null}
    </Text>
  );
}

function Header({ cols, b }: { cols: number; b: Backlog | null | undefined }) {
  const title = ` loop campaign — ${b?.project ?? '(intake)'}`;
  const right = `${control.paused ? 'PAUSED · ' : ''}cap ${control.workerCap} · elapsed ${dur(Date.now() - (store.startedAt ?? Date.now()))} `;
  return (
    <Text bold>
      {title}{' '.repeat(Math.max(1, cols - title.length - right.length))}
      {control.paused ? <Text color="yellow">{right}</Text> : right}
    </Text>
  );
}

function PhasesPanel({ b, cols }: { b: Backlog; cols: number }) {
  const closes = new Set(journalTail(5000).filter(j => j.kind === 'phase-close').map(j => j.subject));
  return <>
    {b.phases.map(p => {
      const ts = b.tickets.filter(t => t.phase === p.id && t.status !== 'decomposed');
      const done = ts.filter(t => t.status === 'closed').length;
      return (
        <Text key={p.id}>
          {` ${p.id.padEnd(4)} `}<Bar done={done} total={ts.length} width={24} />
          {` ${String(done).padStart(2)}/${ts.length}  `}
          {closes.has(p.id) ? <Text color="green">[gate ✓]</Text>
            : ts.length && done === ts.length ? <Text color="yellow">[gate …]</Text> : '        '}
          {`  ${trunc(p.delivers, cols - 50)}`}
        </Text>
      );
    })}
  </>;
}

function CountsLine({ b }: { b: Backlog }) {
  const counts = b.tickets.reduce<Record<string, number>>((m, t) => ((m[t.status] = (m[t.status] || 0) + 1), m), {});
  const attempts = b.tickets.reduce((n, t) => n + (t.attempts?.length ?? 0), 0);
  return (
    <Text>
      {' ' + ['draft', 'vetted', 'in-flight', 'closed', 'blocked', 'failed-wall']
        .filter(s => counts[s]).map(s => `${counts[s]} ${s}`).join(' · ')}
      {`   attempts ${attempts}   spend $${store.spend.costUsd.toFixed(2)} / ${Math.round(store.spend.tokens / 1000)}k tok / ${store.spend.calls} agents`}
    </Text>
  );
}

// --- journal view (its own tab) ---------------------------------------------

function JournalView({ rows, cols, confirm, journalOff, filterIdx }: Frame & { journalOff: number; filterIdx: number }) {
  const filter = FILTERS[filterIdx]!;
  const entries = journalTail(500).filter(filter.test);
  const feedRows = Math.max(3, rows - 3);
  const off = Math.min(journalOff, Math.max(0, entries.length - feedRows));
  const visible = entries.slice(Math.max(0, entries.length - off - feedRows), entries.length - off || undefined);
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>
        {` journal · ${filter.name}`}{off ? <Text dimColor>{` · ↑${off}`}</Text> : null}
        <Text dimColor>   (tab → active)</Text>
      </Text>
      <Rule cols={cols} />
      {visible.map(j => <JournalLine key={j.seq ?? j.ts} j={j} cols={cols} />)}
      <Footer cols={cols} confirm={confirm} hint="tab active · j/k scroll · f filter · ↵ tail · esc back" />
    </Box>
  );
}

function JournalLine({ j, cols }: { j: JournalEntry; cols: number }) {
  const warm = ['gate-red', 'escalation', 'integration-red', 'attempt'].includes(j.kind);
  return (
    <Text color={warm ? 'red' : undefined} dimColor={j.kind === 'verify'}>
      {trunc(`  ${hhmm(Date.parse(j.ts))} ${KIND_ICON[j.kind] ?? '·'} ${String(j.subject ?? '').padEnd(8)} ${j.body ?? ''}`, cols - 1)}
    </Text>
  );
}

// --- ticket browser ----------------------------------------------------------

function ticketList(b: Backlog | null | undefined): Ticket[] {
  if (!b) return [];
  const order = new Map(b.phases.map((p, i) => [p.id, i]));
  return [...b.tickets].sort((x, y) =>
    (order.get(x.phase) ?? 99) - (order.get(y.phase) ?? 99) || x.id.localeCompare(y.id));
}

function TicketsView({ rows, cols, confirm, tickets, sel }: Frame & { tickets: Ticket[]; sel: number }) {
  const listRows = Math.max(3, rows - 3);
  const start = Math.max(0, Math.min(sel - Math.floor(listRows / 2), tickets.length - listRows));
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>{` tickets (${tickets.length})`}</Text>
      <Rule cols={cols} />
      {tickets.slice(start, start + listRows).map((t, i) => {
        const [glyph, color] = STATUS_GLYPH[t.status] ?? ['·', undefined];
        return (
          <Text key={t.id} inverse={start + i === sel}>
            {'  '}<Text color={color}>{glyph}</Text>
            {` ${t.id}  ${t.phase.padEnd(4)} ${t.status.padEnd(11)} ${(t.model ?? 'opus').padEnd(6)} ${trunc(t.title, cols - 40)}`}
          </Text>
        );
      })}
      <Footer cols={cols} confirm={confirm} hint="j/k move · ↵ detail · esc back" />
    </Box>
  );
}

function TicketDetailView({ rows, cols, confirm, ticket: t }: Frame & { ticket: Ticket | undefined }) {
  if (!t) return <Text>ticket vanished — esc to go back</Text>;
  const [glyph, color] = STATUS_GLYPH[t.status] ?? ['·', undefined];
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>{` ${t.id} — ${t.title}`}</Text>
      <Rule cols={cols} />
      <Text>{' status '}<Text color={color}>{`${glyph} ${t.status}`}</Text>{`   phase ${t.phase}   model ${t.model ?? 'opus'}   deps ${t.depends_on?.length ? t.depends_on.join(', ') : '(none)'}`}</Text>
      <Text>{` files  ${t.files?.join(', ') || '(unscoped)'}`}</Text>
      {t.origin ? <Text dimColor>{` origin ${t.origin}`}</Text> : null}
      <Text> </Text>
      <Text bold> acceptance</Text>
      <Text>{`  ${t.acceptance}`}</Text>
      {(t.acceptanceChecks ?? []).map((c, i) => <Text key={i} dimColor>{`   $ ${c.cmd}`}</Text>)}
      <Text> </Text>
      <Text bold>{` attempts (${t.attempts?.length ?? 0})`}</Text>
      {(t.attempts ?? []).slice(-Math.max(1, rows - 14)).map((a, i) => (
        <Box key={i} flexDirection="column">
          <Text color="red">{trunc(`  ✗ [${Array.isArray(a.failed) ? a.failed.join(',') : a.failed}]`, cols - 2)}</Text>
          <Text>{trunc(`    ${a.hypothesis ?? ''}`, cols - 2)}</Text>
          {a.fix ? <Text dimColor>{trunc(`    fix: ${a.fix}`, cols - 2)}</Text> : null}
        </Box>
      ))}
      <Footer cols={cols} confirm={confirm} hint="esc back" />
    </Box>
  );
}

// --- inspect: an agent's transcript or a script's output, live --------------

function InspectView({ rows, cols, confirm, kind, label }: Frame & { kind: 'agent' | 'script'; label: string }) {
  return kind === 'agent'
    ? <AgentTailView rows={rows} cols={cols} confirm={confirm} label={label} />
    : <ScriptTailView rows={rows} cols={cols} confirm={confirm} label={label} />;
}

function AgentTailView({ rows, cols, confirm, label }: Frame & { label: string }) {
  const a = store.agents.get(label);
  if (!a) {
    return (
      <Box flexDirection="column" width={cols}>
        <Text bold>{` ${label}`}</Text>
        <Rule cols={cols} />
        <Text dimColor> agent finished — its verdict is in the journal. esc to go back.</Text>
        <Footer cols={cols} confirm={confirm} hint="esc back" />
      </Box>
    );
  }
  // The live region gets a fixed budget at the bottom; history yields to it.
  const liveRows = a.live?.text ? 6 : 0;
  const lines = a.transcript.slice(-(Math.max(3, rows - 4 - liveRows)));
  const lv = a.pid ? liveness([a.pid]).get(a.pid) : undefined;
  const last = a.transcript.at(-1);
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>
        {` ⚙ ${label} · ${a.model} · ${dur(Date.now() - a.startedAt)} · `}
        <Liveness lv={lv} />
        {last ? ` · last event ${dur(Date.now() - last.ts)} ago` : ''}
      </Text>
      <Rule cols={cols} />
      {lines.length ? lines.map((l, i) => (
        <Text key={i}><Text dimColor>{hhmm(l.ts)}</Text>{` ${trunc(l.line, cols - 10)}`}</Text>
      )) : <Text dimColor> (no events yet — the session is starting)</Text>}
      {a.live?.text ? <>
        <Rule cols={cols} />
        <Text dimColor>{a.live.thinking ? ' ✎ thinking…' : ' ✍ writing…'}</Text>
        <Box height={4} overflow="hidden">
          <Text dimColor={a.live.thinking} italic={a.live.thinking}>
            {` ${liveTail(a.live.text, (cols - 4) * 4, true)}`}<Text color="cyan">▌</Text>
          </Text>
        </Box>
      </> : null}
      <Footer cols={cols} confirm={confirm}
        hint={label.startsWith('worker:') ? 'x kill · esc back' : 'esc back'} />
    </Box>
  );
}

function ScriptTailView({ rows, cols, confirm, label }: Frame & { label: string }) {
  const s = store.scripts.get(label);
  if (!s) {
    return (
      <Box flexDirection="column" width={cols}>
        <Text bold>{` $ ${label}`}</Text>
        <Rule cols={cols} />
        <Text dimColor> script finished — its verdict rides the journal. esc to go back.</Text>
        <Footer cols={cols} confirm={confirm} hint="esc back" />
      </Box>
    );
  }
  // The in-progress line (a progress bar, a prompt) gets a fixed live region;
  // completed output history yields to it.
  const liveRows = s.partial ? 2 : 0;
  const lines = s.output.slice(-(Math.max(3, rows - 5 - liveRows)));
  const lv = s.pid ? liveness([s.pid]).get(s.pid) : undefined;
  const last = s.output.at(-1);
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>
        {` $ ${label} · ${dur(Date.now() - s.startedAt)} · `}
        <Liveness lv={lv} />
        {last ? ` · last line ${dur(Date.now() - last.ts)} ago` : ''}
      </Text>
      <Text dimColor>{trunc(`   ${s.cmd}`, cols - 1)}</Text>
      <Rule cols={cols} />
      {lines.length ? lines.map((l, i) => (
        <Text key={i}><Text dimColor>{hhmm(l.ts)}</Text>{` ${trunc(l.line, cols - 10)}`}</Text>
      )) : <Text dimColor> (no output yet — the process is starting)</Text>}
      {s.partial ? <>
        <Rule cols={cols} />
        <Text color="cyan">{` ${trunc(s.partial, cols - 3)}`}<Text color="cyan">▌</Text></Text>
      </> : null}
      <Footer cols={cols} confirm={confirm} hint="esc back" />
    </Box>
  );
}

// --- help --------------------------------------------------------------------

function HelpView({ cols, confirm }: Frame) {
  const keys: [string, string][] = [
    ['tab', 'switch between the active work and the journal'],
    ['j/k ↑/↓', 'move selection / scroll the journal'],
    ['↵', 'inspect the selected agent or script live; open ticket detail'],
    ['t', 'ticket browser'],
    ['f', `journal filter (${FILTERS.map(f => f.name).join(' → ')})`],
    ['p', 'pause/resume dispatch (in-flight workers still settle)'],
    ['+/-', 'raise/lower the worker cap'],
    ['r', 'run the reviewer at the next loop turn'],
    ['x', 'kill the selected worker (journaled as a failed attempt)'],
    ['q', 'quit — workers killed, state intact, `loop resume` continues'],
  ];
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold> keys</Text>
      <Rule cols={cols} />
      {keys.map(([k, desc]) => <Text key={k}>{`  ${k.padEnd(9)} ${desc}`}</Text>)}
      <Footer cols={cols} confirm={confirm} hint="esc back" />
    </Box>
  );
}

// --- shared bits ---------------------------------------------------------------

function Rule({ cols }: { cols: number }) {
  return <Text dimColor>{'─'.repeat(cols)}</Text>;
}

function Footer({ cols, confirm, hint }: { cols: number; confirm: Confirm; hint: string }) {
  if (confirm) return <Text color="yellow" bold>{trunc(` ${confirm.text}  (y/n)`, cols - 1)}</Text>;
  return <Text dimColor>{trunc(` ${hint}`, cols - 1)}</Text>;
}

// Measured CPU liveness, not transcript-silence guessing: ▶ means the
// process subtree burned CPU within the last 30s (a silent e2e run still
// reads active); "no cpu" ages toward red so a real wedge is loud. Blank when
// there's nothing honest to show (no /proc, pid unknown).
function Liveness({ lv }: { lv: LivenessSample | undefined }) {
  if (!lv) return <Text> </Text>;
  if (lv.idleForMs < 30_000) return <Text color="green">▶</Text>;
  return <Text color={lv.idleForMs > 10 * 60_000 ? 'red' : 'yellow'}>{`∅ no cpu ${dur(lv.idleForMs)}`}</Text>;
}

function Bar({ done, total, width }: { done: number; total: number; width: number }) {
  const filled = total ? Math.round((done / total) * width) : 0;
  return <Text color="green">{'█'.repeat(filled)}<Text dimColor>{'░'.repeat(width - filled)}</Text></Text>;
}

function useTick() {
  const [, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN(n => n + 1);
    const t = setInterval(bump, 1000);
    const unsub = subscribe(bump);
    return () => { clearInterval(t); unsub(); };
  }, []);
}

const safe = <T,>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };
// Newest end of a stream, ellipsized from the front — the opposite cut to
// trunc(). keepBreaks preserves paragraph shape in the tail pane.
const liveTail = (s: string, n: number, keepBreaks = false): string => {
  s = keepBreaks ? String(s).replace(/\n{3,}/g, '\n\n') : String(s).replace(/\s+/g, ' ');
  return s.length > n ? '…' + s.slice(-(n - 1)) : s;
};
const clamp = (i: number, len: number) => Math.max(0, Math.min(i, len - 1));
const trunc = (s: unknown, n: number): string => {
  const t = String(s).replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t;
};
