// The interactive face of a running campaign. Reading is free-roam (tickets,
// journal, live agent transcripts); acting is deliberately narrow — every
// mutation goes through control.mjs flags the drive loop honors at its next
// decision point, or through a child-process kill that settles as an
// ordinary failed attempt. The dashboard never writes campaign state: kill
// it, `loop resume`, and the picture rebuilds from the journal.

import React, { useEffect, useState } from 'react';
import { render, Box, Text, useInput, useStdout } from 'ink';
import { store, subscribe, log, hhmm, dur } from './tui.mjs';
import { backlog, journalTail, campaignExists } from './run.mjs';
import { control, killAgent, killAllAgents } from './control.mjs';
import { liveness } from './liveness.mjs';

export function mount() {
  return render(<Dashboard />, { exitOnCtrlC: false });
}

const KIND_ICON = {
  close: '✓', attempt: '✗', status: '⇢', add: '+', vet: '✔', decompose: '⑂',
  triage: '▲', 'triage-refused': '▲', review: '◎', 'phase-close': '■',
  'gate-red': '‼', escalation: '‼', 'accepted-risk': '⚑', 'flake-probe': '≈',
  'integration-red': '‼', verify: '·', intake: '◈', seed: '◈', init: '◈',
};

const STATUS_GLYPH = {
  closed: ['✓', 'green'], 'in-flight': ['⚙', 'cyan'], blocked: ['✖', 'red'],
  'failed-wall': ['‼', 'red'], vetted: ['○', undefined], draft: ['·', 'gray'],
  decomposed: ['⑂', 'gray'],
};

const FILTERS = [
  { name: 'all', test: () => true },
  { name: 'progress', test: j => ['close', 'phase-close', 'vet', 'add', 'decompose'].includes(j.kind) },
  { name: 'problems', test: j => ['attempt', 'triage', 'triage-refused', 'gate-red', 'integration-red', 'escalation', 'flake-probe'].includes(j.kind) },
];

function Dashboard() {
  useTick();
  const [view, setView] = useState({ name: 'main' });
  const [focus, setFocus] = useState('agents');   // main view: agents | journal
  const [agentSel, setAgentSel] = useState(0);
  const [ticketSel, setTicketSel] = useState(0);
  const [journalOff, setJournalOff] = useState(0); // 0 = follow the tail
  const [filterIdx, setFilterIdx] = useState(0);
  const [confirm, setConfirm] = useState(null);    // { text, onYes }
  const { stdout } = useStdout();
  const rows = stdout.rows || 30;   // || not ??: a bare pty reports 0
  const cols = Math.max(60, stdout.columns || 100);

  const b = safe(() => (campaignExists() ? backlog() : null));
  const agentLabels = [...store.agents.keys()];
  const tickets = ticketList(b);

  function quit() {
    killAllAgents(); // stale in-flight reconciliation re-judges surviving branches on resume
    process.stdout.write('\x1b[?1049l\x1b[?25h');
    console.log('stopped by operator — campaign state intact; `loop resume` to continue.');
    process.exit(130);
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return quit();

    if (confirm) {
      if (input === 'y') { const { onYes } = confirm; setConfirm(null); onYes(); }
      else if (input === 'n' || key.escape) setConfirm(null);
      return;
    }

    const back = to => { if (key.escape || input === 'q') { setView(to); return true; } return false; };

    if (view.name === 'help') { if (key.escape || input === 'q' || input === '?') setView({ name: 'main' }); return; }
    if (view.name === 'ticket') { back({ name: 'tickets' }); return; }

    if (view.name === 'tail') {
      if (back({ name: 'main' })) return;
      if (input === 'x') confirmKill(view.label);
      return;
    }

    if (view.name === 'tickets') {
      if (back({ name: 'main' })) return;
      if (key.upArrow || input === 'k') setTicketSel(s => Math.max(0, s - 1));
      if (key.downArrow || input === 'j') setTicketSel(s => Math.min(tickets.length - 1, s + 1));
      if (key.return && tickets.length) setView({ name: 'ticket', id: tickets[clamp(ticketSel, tickets.length)].id });
      return;
    }

    // --- main ---
    if (input === '?') return setView({ name: 'help' });
    if (input === 't') { setTicketSel(0); return setView({ name: 'tickets' }); }
    if (key.tab) return setFocus(f => (f === 'agents' ? 'journal' : 'agents'));
    if (input === 'p') {
      control.paused = !control.paused;
      return log(control.paused ? '⏸ dispatch paused — in-flight workers will still settle' : '▶ dispatch resumed');
    }
    if (input === '+' || input === '=') { control.workerCap = Math.min(12, control.workerCap + 1); return log(`worker cap → ${control.workerCap}`); }
    if (input === '-') { control.workerCap = Math.max(1, control.workerCap - 1); return log(`worker cap → ${control.workerCap}`); }
    if (input === 'r') { control.forceReview = true; return log('review requested — runs at the next loop turn'); }
    if (input === 'f') { setFilterIdx(i => (i + 1) % FILTERS.length); return setJournalOff(0); }
    if (input === 'q') return setConfirm({
      text: 'quit? in-flight workers are killed; campaign state stays intact (`loop resume`)',
      onYes: quit,
    });

    if (focus === 'agents') {
      if (key.upArrow || input === 'k') setAgentSel(s => Math.max(0, s - 1));
      if (key.downArrow || input === 'j') setAgentSel(s => Math.min(Math.max(0, agentLabels.length - 1), s + 1));
      if (key.return && agentLabels.length) setView({ name: 'tail', label: agentLabels[clamp(agentSel, agentLabels.length)] });
      if (input === 'x' && agentLabels.length) confirmKill(agentLabels[clamp(agentSel, agentLabels.length)]);
    } else {
      if (key.upArrow || input === 'k') setJournalOff(o => o + 1);
      if (key.downArrow || input === 'j') setJournalOff(o => Math.max(0, o - 1));
      if (key.pageUp) setJournalOff(o => o + 10);
      if (key.pageDown) setJournalOff(o => Math.max(0, o - 10));
      if (key.return) setJournalOff(0);
    }
  });

  function confirmKill(label) {
    if (!store.agents.has(label)) return;
    if (!label.startsWith('worker:')) return log('only workers can be killed — verdicts settle on their own');
    setConfirm({
      text: `kill ${label}? the attempt is journaled and the ticket redispatches fresh`,
      onYes: () => { killAgent(label); setView(v => (v.name === 'tail' ? { name: 'main' } : v)); },
    });
  }

  const frame = { rows, cols, confirm };
  if (view.name === 'help') return <HelpView {...frame} />;
  if (view.name === 'tickets') return <TicketsView {...frame} tickets={tickets} sel={clamp(ticketSel, tickets.length)} />;
  if (view.name === 'ticket') return <TicketDetailView {...frame} ticket={tickets.find(t => t.id === view.id)} />;
  if (view.name === 'tail') return <TailView {...frame} label={view.label} />;
  return <MainView {...frame} b={b} focus={focus} agentSel={clamp(agentSel, agentLabels.length)}
    journalOff={journalOff} filterIdx={filterIdx} />;
}

// --- main view ---------------------------------------------------------------

function MainView({ rows, cols, confirm, b, focus, agentSel, journalOff, filterIdx }) {
  const agents = [...store.agents.entries()];
  const phases = b?.phases ?? [];

  // Fixed lines above the feed; the journal gets whatever height remains.
  const fixed = 2 + (b ? phases.length + 4 : 0) + (2 + agents.length) + 1 + 1 + 1;
  const feedRows = Math.max(3, rows - fixed);
  const filter = FILTERS[filterIdx];
  const entries = journalTail(500).filter(filter.test);
  const off = Math.min(journalOff, Math.max(0, entries.length - feedRows));
  const visible = entries.slice(Math.max(0, entries.length - off - feedRows), entries.length - off || undefined);

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
      <Text bold={focus === 'agents'}>{focus === 'agents' ? '▸' : ' '} agents{agents.length ? '' : '  (none live)'}</Text>
      {(() => {
        const live = liveness(agents.map(([, a]) => a.pid).filter(Boolean));
        return agents.map(([label, a], i) => {
          const last = a.transcript.at(-1);
          return (
            <Text key={label} inverse={focus === 'agents' && i === agentSel}>
              {`  ⚙ ${label.padEnd(24)} ${a.model.padEnd(7)} ${dur(Date.now() - a.startedAt).padEnd(7)} `}
              <Liveness lv={a.pid ? live.get(a.pid) : undefined} />
              {a.live?.text
                /* mid-generation: show the newest model output, not a stale event */
                ? <Text color="cyan">{` ✍ ${liveTail(a.live.text, Math.max(10, cols - 66))}`}</Text>
                : <>
                    {/* truncate the line, never the age — the age is the signal */}
                    {last ? ` ${trunc(last.line, Math.max(10, cols - 74))} ` : ' '}
                    {last ? <Text dimColor>{`(${dur(Date.now() - last.ts)} ago)`}</Text> : null}
                  </>}
            </Text>
          );
        });
      })()}
      <Rule cols={cols} />
      <Text bold={focus === 'journal'}>
        {focus === 'journal' ? '▸' : ' '} journal · {filter.name}{off ? ` · ↑${off}` : ''}
        {store.statusLine ? <Text color="cyan">   {trunc(store.statusLine, cols - 30)}</Text> : null}
      </Text>
      {visible.map(j => <JournalLine key={j.seq ?? j.ts} j={j} cols={cols} />)}
      <Footer cols={cols} confirm={confirm}
        hint="tab focus · j/k move · ↵ open/follow · t tickets · f filter · p pause · +/- cap · r review · x kill · q quit · ? help" />
    </Box>
  );
}

function Header({ cols, b }) {
  const title = ` loop campaign — ${b?.project ?? '(intake)'}`;
  const right = `${control.paused ? 'PAUSED · ' : ''}cap ${control.workerCap} · elapsed ${dur(Date.now() - (store.startedAt ?? Date.now()))} `;
  return (
    <Text bold>
      {title}{' '.repeat(Math.max(1, cols - title.length - right.length))}
      {control.paused ? <Text color="yellow">{right}</Text> : right}
    </Text>
  );
}

function PhasesPanel({ b, cols }) {
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

function CountsLine({ b }) {
  const counts = b.tickets.reduce((m, t) => ((m[t.status] = (m[t.status] || 0) + 1), m), {});
  const attempts = b.tickets.reduce((n, t) => n + (t.attempts?.length ?? 0), 0);
  return (
    <Text>
      {' ' + ['draft', 'vetted', 'in-flight', 'closed', 'blocked', 'failed-wall']
        .filter(s => counts[s]).map(s => `${counts[s]} ${s}`).join(' · ')}
      {`   attempts ${attempts}   spend $${store.spend.costUsd.toFixed(2)} / ${Math.round(store.spend.tokens / 1000)}k tok / ${store.spend.calls} agents`}
    </Text>
  );
}

function JournalLine({ j, cols }) {
  const warm = ['gate-red', 'escalation', 'integration-red', 'attempt'].includes(j.kind);
  return (
    <Text color={warm ? 'red' : undefined} dimColor={j.kind === 'verify'}>
      {trunc(`  ${hhmm(Date.parse(j.ts))} ${KIND_ICON[j.kind] ?? '·'} ${String(j.subject ?? '').padEnd(8)} ${j.body ?? ''}`, cols - 1)}
    </Text>
  );
}

// --- ticket browser ----------------------------------------------------------

function ticketList(b) {
  if (!b) return [];
  const order = new Map(b.phases.map((p, i) => [p.id, i]));
  return [...b.tickets].sort((x, y) =>
    (order.get(x.phase) ?? 99) - (order.get(y.phase) ?? 99) || x.id.localeCompare(y.id));
}

function TicketsView({ rows, cols, confirm, tickets, sel }) {
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

function TicketDetailView({ rows, cols, confirm, ticket: t }) {
  if (!t) return <Text>ticket vanished — esc to go back</Text>;
  const [glyph, color] = STATUS_GLYPH[t.status] ?? ['·', undefined];
  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>{` ${t.id} — ${t.title}`}</Text>
      <Rule cols={cols} />
      <Text>{' status '}<Text color={color}>{`${glyph} ${t.status}`}</Text>{`   phase ${t.phase}   model ${t.model ?? 'opus'}   deps ${t.deps?.length ? t.deps.join(', ') : '(none)'}`}</Text>
      <Text>{` files  ${t.files?.join(', ') || '(unscoped)'}`}</Text>
      {t.origin ? <Text dimColor>{` origin ${t.origin}`}</Text> : null}
      <Text> </Text>
      <Text bold> acceptance</Text>
      <Text>{`  ${t.acceptance}`}</Text>
      {(t.acceptanceChecks ?? []).map((c, i) => <Text key={i} dimColor>{`   $ ${c.cmd ?? c}`}</Text>)}
      <Text> </Text>
      <Text bold>{` attempts (${t.attempts?.length ?? 0})`}</Text>
      {(t.attempts ?? []).slice(-Math.max(1, rows - 14)).map((a, i) => (
        <Box key={i} flexDirection="column">
          <Text color="red">{trunc(`  ✗ [${(a.failed ?? []).join?.(',') ?? a.failed}]`, cols - 2)}</Text>
          <Text>{trunc(`    ${a.hypothesis ?? ''}`, cols - 2)}</Text>
          {a.fix ? <Text dimColor>{trunc(`    fix: ${a.fix}`, cols - 2)}</Text> : null}
        </Box>
      ))}
      <Footer cols={cols} confirm={confirm} hint="esc back" />
    </Box>
  );
}

// --- live agent tail ---------------------------------------------------------

function TailView({ rows, cols, confirm, label }) {
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

// --- help ----------------------------------------------------------------------

function HelpView({ cols, confirm }) {
  const keys = [
    ['tab', 'switch focus between agents and journal'],
    ['j/k ↑/↓', 'move selection / scroll the journal'],
    ['↵', 'open agent tail / ticket detail; in journal, jump back to the live tail'],
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

function Rule({ cols }) {
  return <Text dimColor>{'─'.repeat(cols)}</Text>;
}

function Footer({ cols, confirm, hint }) {
  if (confirm) return <Text color="yellow" bold>{trunc(` ${confirm.text}  (y/n)`, cols - 1)}</Text>;
  return <Text dimColor>{trunc(` ${hint}`, cols - 1)}</Text>;
}

// Measured CPU liveness, not transcript-silence guessing: ▶ means the
// agent's process subtree burned CPU within the last 30s (a silent e2e run
// still reads active); "no cpu" ages toward red so a real wedge is loud.
// Blank when there's nothing honest to show (no /proc, pid unknown).
function Liveness({ lv }) {
  if (!lv) return <Text> </Text>;
  if (lv.idleForMs < 30_000) return <Text color="green">▶</Text>;
  return <Text color={lv.idleForMs > 10 * 60_000 ? 'red' : 'yellow'}>{`∅ no cpu ${dur(lv.idleForMs)}`}</Text>;
}

function Bar({ done, total, width }) {
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

const safe = fn => { try { return fn(); } catch { return undefined; } };
// Newest end of a stream, ellipsized from the front — the opposite cut to
// trunc(). keepBreaks preserves paragraph shape in the tail pane.
const liveTail = (s, n, keepBreaks = false) => {
  s = keepBreaks ? String(s).replace(/\n{3,}/g, '\n\n') : String(s).replace(/\s+/g, ' ');
  return s.length > n ? '…' + s.slice(-(n - 1)) : s;
};
const clamp = (i, len) => Math.max(0, Math.min(i, len - 1));
const trunc = (s, n) => (s = String(s).replace(/\s+/g, ' '), s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s);
