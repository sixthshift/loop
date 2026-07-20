// backlog.json access — the campaign's ticket ledger. Reads are direct; every
// mutation goes through backlog-write.mjs (the sole writer, which journals as it
// writes), so this module reads the file and shells the writer but never edits
// backlog.json in place.

import fs from 'node:fs';
import path from 'node:path';
import { RUN } from './state.ts';
import { appendJournal } from './journal.ts';
import type { Check, TicketDraft } from '../agent/schemas.ts';

// A backlog ticket is the agent-proposed draft plus the runtime fields the
// sole writer stamps onto it over its life.
export type TicketStatus = 'draft' | 'vetted' | 'in-flight' | 'closed' | 'blocked' | 'failed-wall' | 'decomposed';
export type Attempt = { failed: string[] | string; hypothesis?: string; fix?: string };
export type Ticket = TicketDraft & { status: TicketStatus; attempts?: Attempt[]; evidence?: string | null; redTeamed?: boolean };
export type Phase = { id: string; delivers: string; gate?: Check[] };
export type Backlog = {
  project: string;
  phases: Phase[];
  tickets: Ticket[];
  fastChecks?: Check[];
  outOfScope?: string[];
  caps?: { maxAttempts: number; thrash: number };
};

export function backlog(): Backlog {
  return JSON.parse(fs.readFileSync(path.join(RUN, 'backlog.json'), 'utf8'));
}

export function ticket(id: string): Ticket {
  const t = backlog().tickets.find(x => x.id === id);
  if (!t) throw new Error(`no ticket ${id}`);
  return t;
}

// --- the sole writer -------------------------------------------------------
// Every mutation of backlog.json is a command; each success journals a stamped
// entry, and nothing else writes the file. Native twin of the ailoop skill's
// backlog-write.mjs — same validation, same transition table, same journal
// shape. It runs in-process now, so a refusal throws (callers decide bug vs
// triage) where the script would have exited non-zero.

const STATUSES = ['draft', 'vetted', 'in-flight', 'closed', 'blocked', 'decomposed', 'failed-wall'];
const LEGAL: Record<string, string[]> = { // from → allowed to
  'draft': ['vetted', 'decomposed'],
  'vetted': ['in-flight', 'draft', 'decomposed', 'blocked', 'failed-wall'],
  'in-flight': ['closed', 'vetted', 'blocked', 'decomposed', 'failed-wall'],
  'blocked': ['vetted', 'draft', 'decomposed'],
  'closed': [], 'decomposed': [], 'failed-wall': ['vetted'],
};

function validateTicket(t: any, existingIds: Set<string>): string[] {
  const errs: string[] = [];
  if (!t.id || !/^T\d+$/.test(t.id)) errs.push(`bad or missing id: ${t.id}`);
  if (existingIds.has(t.id)) errs.push(`duplicate id: ${t.id}`);
  if (!t.title) errs.push(`${t.id}: missing title`);
  if (!t.phase) errs.push(`${t.id}: missing phase`);
  if (!Array.isArray(t.files) || t.files.length === 0) errs.push(`${t.id}: files must be a NON-EMPTY array (unknown footprint is unbatchable and unverifiable)`);
  if (!t.context || t.context.length < 40) errs.push(`${t.id}: context too thin to cold-start a worker`);
  if (!t.acceptance) errs.push(`${t.id}: missing acceptance`);
  if (!Array.isArray(t.acceptanceChecks) || t.acceptanceChecks.length === 0) errs.push(`${t.id}: acceptanceChecks must be a non-empty array of {name, cmd}`);
  (t.acceptanceChecks || []).forEach((c: any) => { if (!c.name || !c.cmd) errs.push(`${t.id}: acceptanceCheck missing name or cmd`); });
  if (t.resources !== undefined && !Array.isArray(t.resources)) errs.push(`${t.id}: resources must be an array of shared-resource names`);
  if (!t.origin) errs.push(`${t.id}: missing origin (spec §, decomposed-from, or repair)`);
  return errs;
}

// `input` (object|array) is the payload for commands that took one on stdin as
// a script (add/seed/update/decompose pass '-' as the positional). Every other
// command reads only flags/positionals from `args`.
export function backlogWrite(args: string[], input?: unknown): string {
  const rest = [...args];
  const cmd = rest.shift();
  const opts: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      opts[a.slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
    } else pos.push(a);
  }

  const BACKLOG = path.join(RUN, 'backlog.json');
  const JOURNAL = path.join(RUN, 'journal.jsonl');
  const refuse = (msg: string): never => { throw new Error(`backlog-write ${cmd} REFUSED: ${msg}`); };
  const load = (): Backlog => {
    if (!fs.existsSync(BACKLOG)) refuse(`${BACKLOG} not found — run init first`);
    return JSON.parse(fs.readFileSync(BACKLOG, 'utf8'));
  };
  const save = (b: Backlog) => fs.writeFileSync(BACKLOG, JSON.stringify(b, null, 2) + '\n');
  const journal = (kind: string, subject: string, body: string, data?: unknown) =>
    appendJournal({ kind, subject, body, ...(data ? { data } : {}) });
  const parseData = (): unknown => {
    if (opts.data === undefined) return undefined;
    try { return JSON.parse(opts.data as string); } catch { return refuse('--data must be valid JSON'); }
  };
  const readInput = (src: string | undefined): any[] => {
    if (src === undefined || src === '-') {
      if (input === undefined) refuse('expected an input payload');
      return Array.isArray(input) ? input : [input];
    }
    const parsed = JSON.parse(fs.readFileSync(src, 'utf8'));
    return Array.isArray(parsed) ? parsed : [parsed];
  };
  const findTicket = (b: Backlog, id: string | undefined): Ticket => {
    const t = b.tickets.find(x => x.id === id);
    if (!t) refuse(`no ticket ${id}`);
    return t!;
  };
  const transition = (t: Ticket, to: string) => {
    if (!STATUSES.includes(to)) refuse(`unknown status ${to}`);
    if (!(LEGAL[t.status] || []).includes(to)) refuse(`illegal transition ${t.id}: ${t.status} → ${to}`);
    t.status = to as TicketStatus;
  };

  switch (cmd) {
    case 'init': {
      if (fs.existsSync(BACKLOG)) refuse(`${BACKLOG} already exists — a campaign is in flight`);
      fs.mkdirSync(path.join(RUN, 'evidence'), { recursive: true });
      save({ project: (opts.project as string) || 'unnamed', caps: { maxAttempts: 3, thrash: 2 }, fastChecks: [], phases: [], outOfScope: [], tickets: [] });
      journal('init', 'campaign', `campaign initialized for project ${(opts.project as string) || 'unnamed'}`);
      return `initialized ${BACKLOG}`;
    }
    case 'seed': {
      const b = load();
      if (b.tickets.length && !opts.amend) refuse('config is seeded before the first ticket exists — after that, re-run with --amend --note "why" (a journaled amendment)');
      if (opts.amend && !opts.note) refuse('--amend requires --note — the rationale is the record');
      const cfg = readInput(pos[0]);
      if (cfg.length !== 1) refuse('seed takes a single config object {fastChecks?, phases?, outOfScope?}');
      const c0 = cfg[0];
      const errs: string[] = [];
      for (const k of Object.keys(c0)) if (!['fastChecks', 'phases', 'outOfScope'].includes(k)) errs.push(`unknown key ${k} (seed takes fastChecks, phases, outOfScope)`);
      (c0.fastChecks || []).forEach((c: any) => { if (!c.name || !c.cmd) errs.push(`fastCheck missing name or cmd: ${JSON.stringify(c)}`); });
      (c0.phases || []).forEach((p: any) => {
        if (!p.id) errs.push(`phase missing id: ${JSON.stringify(p)}`);
        (p.gate || []).forEach((g: any) => { if (!g.name || !g.cmd) errs.push(`${p.id}: gate command missing name or cmd`); });
      });
      (c0.outOfScope || []).forEach((o: any) => { if (typeof o !== 'string') errs.push(`outOfScope entries are strings: ${JSON.stringify(o)}`); });
      if (errs.length) refuse(errs.join('\n'));
      for (const k of ['fastChecks', 'phases', 'outOfScope'] as const) if (c0[k] !== undefined) (b as any)[k] = c0[k];
      journal(opts.amend ? 'amend-config' : 'seed', 'campaign',
        `${opts.amend ? 'amended' : 'seeded'} ${Object.keys(c0).join(', ')}${opts.note ? ` — ${opts.note}` : ''}`);
      save(b);
      return `${opts.amend ? 'amended' : 'seeded'} ${Object.keys(c0).join(', ')}`;
    }
    case 'update': {
      const b = load();
      const t = findTicket(b, pos[0]);
      if (!['draft', 'vetted'].includes(t.status)) refuse(`${t.id} is ${t.status} — only draft or vetted tickets can be updated (in-flight work would diverge from its contract)`);
      const patchIn = readInput(pos[1]);
      if (patchIn.length !== 1) refuse('update takes a single patch object');
      const patch = patchIn[0];
      const MUTABLE = ['title', 'phase', 'depends_on', 'files', 'resources', 'model', 'context', 'acceptance', 'acceptanceChecks'];
      const illegal = Object.keys(patch).filter(k => !MUTABLE.includes(k));
      if (illegal.length) refuse(`immutable or unknown field(s): ${illegal.join(', ')} — mutable: ${MUTABLE.join(', ')}`);
      Object.assign(t, patch);
      const errs = validateTicket(t, new Set()).filter(e => !e.includes('duplicate'));
      if (errs.length) refuse(`patch leaves ${t.id} invalid:\n${errs.join('\n')}`);
      const demoted = t.status === 'vetted';
      if (demoted) { transition(t, 'draft'); t.redTeamed = false; }
      journal('update', t.id, `fields [${Object.keys(patch).join(', ')}]${demoted ? '; vetted → draft, re-vet required' : ''}${opts.note ? ` — ${opts.note}` : ''}`);
      save(b);
      return `${t.id} updated${demoted ? ' (vetted → draft: contract changed, re-vet)' : ''}`;
    }
    case 'add': {
      const b = load();
      const ids = new Set(b.tickets.map(t => t.id));
      const incoming = readInput(pos[0]);
      const errs = incoming.flatMap((t: any) => validateTicket(t, ids));
      if (errs.length) refuse(errs.join('\n'));
      for (const t of incoming) {
        b.tickets.push({ depends_on: [], resources: [], model: 'opus', redTeamed: false, attempts: [], evidence: null, ...t, status: 'draft' });
        ids.add(t.id);
        journal('add', t.id, `${t.title} (origin: ${t.origin})`);
      }
      save(b);
      return `added ${incoming.length} draft ticket(s)`;
    }
    case 'vet': {
      const b = load();
      const t = findTicket(b, pos[0]);
      if (t.status !== 'draft') refuse(`${t.id} is ${t.status}, only draft tickets can be vetted`);
      const errs = validateTicket(t, new Set()).filter(e => !e.includes('duplicate'));
      if (errs.length) refuse(`cannot vet with schema problems:\n${errs.join('\n')}`);
      t.redTeamed = true;
      transition(t, 'vetted');
      journal('vet', t.id, (opts.note as string) || 'critic pass complete');
      save(b);
      return `${t.id} vetted`;
    }
    case 'set-status': {
      const b = load();
      const t = findTicket(b, pos[0]);
      const to = pos[1];
      if (to === 'closed') refuse('use the close command (evidence is mandatory)');
      if (to === 'vetted' && t.status === 'draft') refuse('use the vet command (red-team is mandatory)');
      if (to === 'decomposed') refuse('use the decompose command (children are mandatory)');
      transition(t, to!);
      journal('status', t.id, `→ ${to}${opts.note ? ` — ${opts.note}` : ''}`, parseData());
      save(b);
      return `${t.id} → ${to}`;
    }
    case 'attempt': {
      const b = load();
      const t = findTicket(b, pos[0]);
      if (!opts.failed) refuse('attempt requires --failed <comma-separated check names>');
      if (!opts.hypothesis) refuse('attempt requires --hypothesis');
      const entry = {
        n: (t.attempts?.length ?? 0) + 1,
        failed: String(opts.failed).split(',').map(s => s.trim()).filter(Boolean),
        hypothesis: opts.hypothesis,
        fixNote: (opts.fix as string) || '',
        ts: new Date().toISOString(),
      };
      (t.attempts ??= []).push(entry as any);
      if (t.status === 'in-flight') transition(t, 'vetted'); // back in the queue for re-dispatch
      journal('attempt', t.id, `attempt ${entry.n} failed [${entry.failed.join(', ')}]: ${entry.hypothesis}`, parseData());
      save(b);
      return `${t.id} attempt ${entry.n} logged`;
    }
    case 'close': {
      const b = load();
      const t = findTicket(b, pos[0]);
      if (!opts.evidence) refuse('close requires --evidence <path> (independent re-verify output)');
      if (!fs.existsSync(opts.evidence as string)) refuse(`evidence file not found: ${opts.evidence}`);
      transition(t, 'closed');
      t.evidence = opts.evidence as string;
      journal('close', t.id, (opts.note as string) || `closed with evidence ${opts.evidence}`, parseData());
      save(b);
      return `${t.id} closed`;
    }
    case 'decompose': {
      const b = load();
      const t = findTicket(b, pos[0]);
      const ids = new Set(b.tickets.map(x => x.id));
      const children = readInput(pos[1]);
      if (!children.length) refuse('decompose requires child tickets');
      const errs = children.flatMap((c: any) => validateTicket(c, ids));
      if (errs.length) refuse(errs.join('\n'));
      transition(t, 'decomposed');
      const childIds = children.map((c: any) => c.id);
      for (const c of children) {
        b.tickets.push({ depends_on: [], resources: [], model: t.model || 'opus', redTeamed: false, attempts: [], evidence: null, phase: c.phase || t.phase, origin: c.origin || `decomposed from ${t.id}`, ...c, status: 'draft' });
        ids.add(c.id);
      }
      // rewire dependents of the parent onto ALL children (coordinator may narrow after)
      let rewired = 0;
      for (const other of b.tickets) {
        const i = (other.depends_on || []).indexOf(t.id);
        if (i >= 0 && other.status !== 'closed' && other.status !== 'decomposed') {
          other.depends_on!.splice(i, 1, ...childIds);
          rewired++;
        }
      }
      journal('decompose', t.id, `→ [${childIds.join(', ')}]; ${rewired} dependent(s) rewired onto children (narrow the edges if too broad)`);
      save(b);
      return `${t.id} decomposed into ${childIds.join(', ')}; ${rewired} dependents rewired`;
    }
    case 'note': {
      if (!fs.existsSync(JOURNAL) && !fs.existsSync(BACKLOG)) refuse('no campaign here');
      if (!opts.kind || !opts.subject || !opts.body) refuse('note requires --kind --subject --body');
      journal(opts.kind as string, opts.subject as string, opts.body as string, parseData());
      return 'journaled';
    }
    default:
      return refuse(`unknown command: ${cmd}. Commands: init seed add update vet set-status attempt close decompose note`);
  }
}

export function nextTicketIds(n: number): string[] {
  const used = new Set(backlog().tickets.map(t => t.id));
  const out: string[] = [];
  for (let i = 1; out.length < n; i++) {
    const id = `T${String(i).padStart(3, '0')}`;
    if (!used.has(id)) { out.push(id); used.add(id); }
  }
  return out;
}
