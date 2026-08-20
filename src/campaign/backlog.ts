// backlog.json access — the campaign's authoritative persistent snapshot.
// Reads are direct; every mutation goes through the sole writer below, which
// validates the transition, atomically replaces the snapshot, then mirrors the
// event into the audit journal.

import fs from 'node:fs';
import path from 'node:path';
import { RUN } from './paths.ts';
import { appendJournal } from './journal.ts';
import { moduleErrors } from './footprint.ts';
import type { Check, Milestone, Requirement, TicketDraft } from './agents/schemas.ts';

// A backlog ticket is the agent-proposed draft plus the runtime fields the
// sole writer stamps onto it over its life.
// `open` is the single pre-dispatch state: a proposed, still-editable ticket
// that becomes dispatchable once its deps close. There is deliberately no
// `vetted` state to earn: the critic pass and `loop vet` read a ticket's CHECKS
// before dispatch, and neither is an approval a ticket carries — judging the
// built diff is still the post-build review's alone.
// `parked` is set only when a decision is deferred to the human; the campaign keeps
// driving everything else and drains when nothing autonomous is left.
export type TicketStatus = 'open' | 'in-flight' | 'closed' | 'parked' | 'decomposed';
// `infra` marks an attempt that failed for a reason outside the ticket's own
// merits — the worker session died, was killed, or the mainline moved under a
// clean diff. Merit failures (verify red, gaming, judge-rejected) are the
// ticket's own; infra failures are the machine's. The wall logic counts only
// the merit ones, so a flaky engine can't exhaust a ticket's real budget.
export type Attempt = { failed: string[] | string; hypothesis?: string; fix?: string; infra?: boolean };

// Where an in-flight ticket has got to. This is the only field here that no
// mechanic reads — nothing branches on it, and a wrong value reds no check. It
// exists for the operator, and specifically for invariant 1: a ticket is never
// `in-flight` without a live worker, which is the coordinator's one failure with
// no symptom, because a stranded in-flight ticket silently holds its modules
// against every other ticket forever. A phase, with the time it was stamped, is
// what makes that visible — `verifying for 40m` is a diagnosis; `in-flight` on
// its own is not. The writer clears it on the way out of in-flight rather than
// letting a settled ticket keep a phase it is no longer in.
export const PHASES = ['dispatched', 'verifying', 'under-review', 'probing', 'merging'] as const;
export type TicketPhase = (typeof PHASES)[number];

export type Ticket = TicketDraft & {
  status: TicketStatus;
  attempts?: Attempt[];
  evidence?: string | null;
  // The mainline sha this ticket's branch was cut from, stamped at dispatch.
  // A resume reads it to re-verify a surviving branch whose worker session
  // died; it survives the in-flight → open → in-flight round trip a check
  // amendment makes, and the next dispatch overwrites it.
  baseSha?: string;
  phase?: { name: TicketPhase; at: string };
  // Which rung of the worker chain this dispatch spent, stamped beside baseSha
  // because it is the same fact about the same dispatch. The attempt log records
  // what a finished attempt cost; this records what the LIVE one is spending, and
  // only the live reading answers "is this ticket on opus already?" while there
  // is still a decision to make about it.
  dispatch?: { model: string; rung: number; at: string };
  // A parked ticket is a durable handoff to the human. Its reason belongs with
  // that state; the journal mirrors it for audit but is not needed to resume.
  parkReason?: string;
  // Invariant 4's two per-ticket allowances, counted rather than remembered.
  // One typo-level check amendment and one flake probe: past that it is not a
  // typo and not a flake, it is the judge negotiating its way to green, and the
  // whole escaped-bug rule exists to stop exactly that. Both used to live only
  // in a coordinator's context, which is compacted mid-campaign — a budget kept
  // in a conversation is a budget that quietly stops existing, and it looks
  // identical to one with room left.
  amendments?: { typo?: number; probe?: number };
};

// The campaign gate's live state — what its last run decided, and whether it is
// latched for the human. Distinct from `gate`, which is the configured checks.
export type GateState = {
  // A green run only covers the tree it measured. `tickets` and `closed` are
  // the backlog's counts at run time, and either moving means work landed that
  // the gate never saw. Both are monotone — every `add` raises `tickets`, every
  // `close` raises `closed`, and closed is terminal — so equality is proof
  // nothing landed, not just proof of a coincidence.
  lastRun?: { result: 'green' | 'red'; tickets: number; closed: number; evidence: string };
  // Set when recover gave up on a red gate inside its jurisdiction; cleared by
  // a gate amendment, i.e. the human edited the gate and resumed.
  parked?: { reason: string };
};

export type Backlog = {
  project: string;
  // The branch the campaign builds on: ticket branches are cut from it,
  // landings fast-forward it, and nothing measures or amends off it. Recorded
  // at init because HEAD stopped being the answer — under serial checkouts
  // HEAD spends most of a campaign on a ticket branch.
  mainline: string;
  // When `init` ran. The campaign clock has to live here rather than in the
  // process that renders it: a skill-driven campaign spans many separate verb
  // invocations and any number of sessions, so a clock started by the display
  // would measure how long the display had been open and call it the campaign's
  // age. Same reason it survives a resume.
  startedAt?: string;
  // The locked contract a resume must continue. The journal records kickoff
  // for the audit trail, but resume never needs to replay that record.
  contract?: { specPath: string; sha256: string };
  tickets: Ticket[];
  fastChecks?: Check[];
  // The campaign's slow suite (e2e, anything needing a live server): run once,
  // on the whole merged tree, when all ticket work has drained — not per ticket.
  gate?: Check[];
  gateState?: GateState;
  outOfScope?: string[];
  // The spec's normative clauses, enumerated once at kickoff. Tickets claim
  // these ids in `satisfies`, and the frontier's coverage arithmetic is a join
  // between the two — which is why the sole writer refuses a claim on an id
  // that isn't here.
  requirements?: Requirement[];
  // Named checkpoints over those requirement ids, declared by the spec. They
  // sequence nothing and gate nothing — `depends_on` still orders the campaign
  // and the gate still runs once at the end. What a milestone marks is a moment
  // worth reflecting at: reaching one is the sweep's trigger, in place of a
  // ticket count that says nothing about the product.
  milestones?: Milestone[];
  caps?: { maxAttempts: number; thrash: number; infraCap?: number };
  // Recovery budgets affect whether the next anomaly is retried or parked, so
  // they are durable state rather than a count reconstructed from audit events.
  recoveries?: Record<string, { count: number; summaries: string[] }>;
  // Which checkpoints have already been swept. Reaching a milestone is permanent,
  // so the record of having spent it is the only thing that stops it standing
  // due forever — and it has to be durable state rather than something the
  // coordinator remembers, since a campaign outlives any one session's context.
  sweep?: { milestones: string[] };
};

export const requirementIds = (b: Backlog): Set<string> =>
  new Set((b.requirements ?? []).map(r => r.id));

// The recorded mainline, for every verb that resolves against it. `init`
// demands it, so a throw here means the snapshot was hand-edited — which is
// worth failing loudly over, since every measurement resolves against this ref.
export const mainline = (): string => {
  const m = backlog().mainline;
  if (!m) throw new Error('no mainline recorded in backlog.json — the snapshot is corrupt');
  return m;
};

export function backlog(): Backlog {
  return JSON.parse(fs.readFileSync(path.join(RUN, 'backlog.json'), 'utf8'));
}

// A campaign exists once its authoritative snapshot is on disk. Kept beside
// the snapshot rather than in the top-level coordinator so low-level state and
// display code never depend back on the application entry point.
export function campaignExists(): boolean {
  return fs.existsSync(path.join(RUN, 'backlog.json'));
}

export function ticket(id: string): Ticket {
  const t = backlog().tickets.find(x => x.id === id);
  if (!t) throw new Error(`no ticket ${id}`);
  return t;
}

// --- the sole writer -------------------------------------------------------
// Every mutation of backlog.json is a command; each success mirrors a stamped
// audit entry, and nothing else writes the snapshot. It runs in-process, so a
// refusal throws and the caller decides whether that is a bug or a recoverable
// anomaly.
//
// Load-bearing: this is synchronous end to end, and must stay that way. Each
// invocation is its own short-lived process, so the read-mutate-write is atomic by
// virtue of finishing before anything else runs, and the rename at the end is what
// makes a concurrent READER safe. An await introduced anywhere in backlogWrite
// would reintroduce the interleaving this shape rules out — and nothing here holds
// a lock, because the coordinator that calls it cannot hold one either.

const STATUSES = ['open', 'in-flight', 'closed', 'parked', 'decomposed'];
const LEGAL: Record<string, string[]> = { // from → allowed to
  'open': ['in-flight', 'decomposed', 'parked'],
  'in-flight': ['closed', 'open', 'parked', 'decomposed'],
  'parked': ['open', 'decomposed'],
  'closed': [], 'decomposed': [],
};

function validateTicket(t: any, existingIds: Set<string>, requirementIds: Set<string>): string[] {
  const errs: string[] = [];
  if (!t.id || !/^T\d+$/.test(t.id)) errs.push(`bad or missing id: ${t.id}`);
  if (existingIds.has(t.id)) errs.push(`duplicate id: ${t.id}`);
  if (!t.title) errs.push(`${t.id}: missing title`);
  errs.push(...moduleErrors(t.modules).map(e => `${t.id}: ${e}`));
  if (!t.context || t.context.length < 40) errs.push(`${t.id}: context too thin to cold-start a worker`);
  if (!t.acceptance) errs.push(`${t.id}: missing acceptance`);
  if (!Array.isArray(t.acceptanceChecks) || t.acceptanceChecks.length === 0) errs.push(`${t.id}: acceptanceChecks must be a non-empty array of {name, cmd}`);
  (t.acceptanceChecks || []).forEach((c: any) => { if (!c.name || !c.cmd) errs.push(`${t.id}: acceptanceCheck missing name or cmd`); });
  if (!t.origin) errs.push(`${t.id}: missing origin (spec §, decomposed-from, or repair)`);
  // A claim on a requirement that doesn't exist is worse than no claim: the
  // frontier counts the clause as unmapped while the ticket reads as covering
  // it, and nothing downstream would ever disagree out loud.
  if (t.satisfies !== undefined) {
    if (!Array.isArray(t.satisfies)) errs.push(`${t.id}: satisfies must be an array of requirement ids`);
    else for (const r of t.satisfies) {
      if (!requirementIds.has(r)) errs.push(`${t.id}: satisfies unknown requirement ${JSON.stringify(r)} (ids come from the kickoff enumeration)`);
    }
  }
  return errs;
}

// `input` (object|array) is the payload for commands that took one on stdin as
// a script (add/seed/update/decompose pass '-' as the positional). Every other
// command reads only flags/positionals from `args`.
// Whether this invocation asked for a stdin payload: a positional `-`. The CLI
// must not read stdin unless asked — a payload-less command (`attempt`,
// `set-status`) run with an inherited pipe that never closes would otherwise
// block forever waiting for EOF it has no use for. The scan mirrors
// backlogWrite's own option parsing so an option's value is never mistaken for
// the marker.
export function wantsStdinPayload(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) i++;
    } else if (a === '-') return true;
  }
  return false;
}

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
  // Annotated rather than inferred so the compiler treats a refusal as
  // terminating control flow, and a guard above a narrowed assignment reads as
  // one.
  const refuse: (msg: string) => never = msg => { throw new Error(`backlog-write ${cmd} REFUSED: ${msg}`); };
  const load = (): Backlog => {
    if (!fs.existsSync(BACKLOG)) refuse(`${BACKLOG} not found — run init first`);
    return JSON.parse(fs.readFileSync(BACKLOG, 'utf8'));
  };
  const save = (b: Backlog) => {
    const tmp = `${BACKLOG}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(b, null, 2) + '\n', { flag: 'wx' });
      fs.renameSync(tmp, BACKLOG);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* renamed or never created */ }
    }
  };
  // Audit failure must not roll back or misreport a durable state transition.
  // The snapshot is saved first in every mutating command; journal append is
  // best-effort and visibly disclosed if the audit sink is unavailable.
  const journal = (kind: string, subject: string, body: string, data?: unknown) => {
    try {
      appendJournal({ kind, subject, body, ...(data ? { data } : {}) });
    } catch (e: any) {
      console.error(`journal append failed after ${kind} state persisted: ${e.message}`);
    }
  };
  const parseData = (): unknown => {
    if (opts.data === undefined) return undefined;
    try { return JSON.parse(opts.data as string); } catch { return refuse('--data must be valid JSON'); }
  };
  const readInput = (src: string | undefined): any[] => {
    if (src === undefined || src === '-') {
      if (input === undefined) refuse('expected a payload — pass `-` as the positional and pipe JSON on stdin, or pass a file path');
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
    // A phase describes an in-flight ticket and nothing else, so it is dropped
    // here rather than in each command that lands one: `merging` left on a closed
    // ticket, or on one that walled back to open, reads as work still running.
    // Every route out of in-flight passes through this function; a per-command
    // clear would eventually miss one.
    if (t.status === 'in-flight' && to !== 'in-flight') delete t.phase;
    t.status = to as TicketStatus;
  };

  switch (cmd) {
    case 'init': {
      if (fs.existsSync(BACKLOG)) refuse(`${BACKLOG} already exists — a campaign is in flight`);
      if ((opts['spec-path'] === undefined) !== (opts['spec-sha'] === undefined))
        refuse('init takes --spec-path and --spec-sha together');
      // The writer demands the branch name rather than reading git itself —
      // this file's imports stay git-free, and the CLI resolves HEAD before
      // delegating (mechanics.ts), so a refusal here means a direct caller
      // forgot what the CLI would have supplied.
      const mainline = opts.mainline;
      if (typeof mainline !== 'string' || !mainline)
        refuse('init requires --mainline <branch> — the branch the campaign builds on (the CLI resolves it from HEAD when omitted)');
      fs.mkdirSync(path.join(RUN, 'evidence'), { recursive: true });
      save({
        project: (opts.project as string) || 'unnamed',
        mainline,
        startedAt: new Date().toISOString(),
        ...(opts['spec-path'] && opts['spec-sha']
          ? { contract: { specPath: opts['spec-path'] as string, sha256: opts['spec-sha'] as string } }
          : {}),
        caps: { maxAttempts: 3, thrash: 2 },
        fastChecks: [],
        gate: [],
        outOfScope: [],
        recoveries: {},
        tickets: [],
      });
      journal('init', 'campaign', `campaign initialized for project ${(opts.project as string) || 'unnamed'} (mainline: ${mainline})`);
      return `initialized ${BACKLOG}`;
    }
    case 'seed': {
      const b = load();
      if (b.tickets.length && !opts.amend) refuse('config is seeded before the first ticket exists — after that, re-run with --amend --note "why" (a journaled amendment)');
      if (opts.amend && !opts.note) refuse('--amend requires --note — the rationale is the record');
      const cfg = readInput(pos[0]);
      if (cfg.length !== 1) refuse('seed takes a single config object {fastChecks?, gate?, outOfScope?, requirements?, milestones?, caps?}');
      const c0 = cfg[0];
      const errs: string[] = [];
      const KEYS = ['fastChecks', 'gate', 'outOfScope', 'requirements', 'milestones', 'caps'] as const;
      for (const k of Object.keys(c0)) if (!(KEYS as readonly string[]).includes(k)) errs.push(`unknown key ${k} (seed takes ${KEYS.join(', ')})`);
      (c0.fastChecks || []).forEach((c: any) => { if (!c.name || !c.cmd) errs.push(`fastCheck missing name or cmd: ${JSON.stringify(c)}`); });
      (c0.gate || []).forEach((g: any) => { if (!g.name || !g.cmd) errs.push(`gate command missing name or cmd: ${JSON.stringify(g)}`); });
      (c0.outOfScope || []).forEach((o: any) => { if (typeof o !== 'string') errs.push(`outOfScope entries are strings: ${JSON.stringify(o)}`); });
      // Requirement ids are the join key every later claim is checked against, so
      // a duplicate or blank id is a corrupt enumeration, not a typo to tolerate.
      const reqIds = new Set<string>();
      (c0.requirements || []).forEach((r: any) => {
        if (!r?.id || typeof r.id !== 'string' || !r.clause) errs.push(`requirement needs id and clause: ${JSON.stringify(r)}`);
        else if (reqIds.has(r.id)) errs.push(`duplicate requirement id: ${r.id}`);
        else reqIds.add(r.id);
      });
      // A milestone is reached when every clause it delivers is proven, so a
      // `delivers` id outside the enumeration is a checkpoint that can never
      // arrive — and the failure would be silent, since an unreachable milestone
      // and a milestone with work left look identical from the frontier. An
      // amendment that carries milestones without re-sending the enumeration is
      // checked against the one already in force.
      const knownReqs = c0.requirements !== undefined ? reqIds : requirementIds(b);
      const msIds = new Set<string>();
      (c0.milestones || []).forEach((m: any) => {
        if (!m?.id || typeof m.id !== 'string' || !m.name) errs.push(`milestone needs id and name: ${JSON.stringify(m)}`);
        else if (msIds.has(m.id)) errs.push(`duplicate milestone id: ${m.id}`);
        else msIds.add(m.id);
        if (!Array.isArray(m?.delivers) || !m.delivers.length)
          errs.push(`milestone ${m?.id} delivers nothing — a checkpoint over no clause can never be reached`);
        else for (const r of m.delivers)
          if (!knownReqs.has(r)) errs.push(`milestone ${m.id} delivers unknown requirement ${r}`);
      });
      // A cap of zero would wall every ticket on its first attempt, and a
      // fractional one compares against an integer count forever — both read as
      // a campaign that simply never dispatches.
      if (c0.caps !== undefined && c0.caps !== null) {
        for (const k of ['maxAttempts', 'thrash'] as const)
          if (!Number.isInteger(c0.caps[k]) || c0.caps[k] < 1)
            errs.push(`caps.${k} must be a positive integer, got ${JSON.stringify(c0.caps[k])}`);
        if (c0.caps.infraCap !== undefined && (!Number.isInteger(c0.caps.infraCap) || c0.caps.infraCap < 1))
          errs.push(`caps.infraCap must be a positive integer, got ${JSON.stringify(c0.caps.infraCap)}`);
      }
      if (errs.length) refuse(errs.join('\n'));
      for (const k of KEYS) if (c0[k] !== undefined && c0[k] !== null) (b as any)[k] = c0[k];
      save(b);
      journal(opts.amend ? 'amend-config' : 'seed', 'campaign',
        `${opts.amend ? 'amended' : 'seeded'} ${Object.keys(c0).join(', ')}${opts.note ? ` — ${opts.note}` : ''}`);
      return `${opts.amend ? 'amended' : 'seeded'} ${Object.keys(c0).join(', ')}`;
    }
    case 'update': {
      const b = load();
      const t = findTicket(b, pos[0]);
      if (t.status !== 'open') refuse(`${t.id} is ${t.status} — only open tickets can be updated (in-flight work would diverge from its contract)`);
      const patchIn = readInput(pos[1]);
      if (patchIn.length !== 1) refuse('update takes a single patch object');
      const patch = patchIn[0];
      const MUTABLE = ['title', 'depends_on', 'modules', 'context', 'acceptance', 'acceptanceChecks'];
      const illegal = Object.keys(patch).filter(k => !MUTABLE.includes(k));
      if (illegal.length) refuse(`immutable or unknown field(s): ${illegal.join(', ')} — mutable: ${MUTABLE.join(', ')}`);
      Object.assign(t, patch);
      const errs = validateTicket(t, new Set(), requirementIds(b)).filter(e => !e.includes('duplicate'));
      if (errs.length) refuse(`patch leaves ${t.id} invalid:\n${errs.join('\n')}`);
      // Opt-in: the prior attempts were measured against a contract that this
      // patch just changed, so they no longer describe THIS ticket — a stale
      // wall the corrected contract shouldn't inherit. Off by default so the
      // gamed-sharpen path keeps a serial gamer's attempts on the record.
      const reset = opts['reset-attempts'] === true;
      if (reset) t.attempts = [];
      // A typo amendment is the one check edit that costs no attempt and no
      // re-dispatch, so it is the cheapest possible route to green and the one
      // most worth bounding. The second is refused here rather than left to the
      // coordinator to remember: a meaning-level change wearing a smaller word
      // is exactly what a second "typo" on the same ticket is.
      if (opts['typo-amendment']) {
        const spent = t.amendments?.typo ?? 0;
        if (spent >= 1)
          refuse(`${t.id} already spent its typo amendment — a second letter-level fix on one ticket is a meaning-level change, which is the human's: park it`);
        (t.amendments ??= {}).typo = spent + 1;
      }
      save(b);
      journal('update', t.id, `fields [${Object.keys(patch).join(', ')}]${reset ? '; attempts reset (contract changed)' : ''}${opts['typo-amendment'] ? '; typo amendment spent' : ''}${opts.note ? ` — ${opts.note}` : ''}`);
      return `${t.id} updated`;
    }
    case 'add': {
      const b = load();
      const ids = new Set(b.tickets.map(t => t.id));
      const incoming = readInput(pos[0]);
      const errs = incoming.flatMap((t: any) => validateTicket(t, ids, requirementIds(b)));
      if (errs.length) refuse(errs.join('\n'));
      for (const t of incoming) {
        b.tickets.push({ depends_on: [], attempts: [], evidence: null, ...t, status: 'open' });
        ids.add(t.id);
      }
      save(b);
      for (const t of incoming) journal('add', t.id, `${t.title} (origin: ${t.origin})`);
      return `added ${incoming.length} open ticket(s)`;
    }
    case 'gate': {
      // Amend the campaign's merged-tree gate. The escaped-bug rule prescribes
      // strengthening the gate when a defect slips past it; this is the
      // actuator that makes that a mutation rather than an escalation. Upsert
      // by name so re-running is idempotent and a cmd can be corrected in place.
      const b = load();
      if (!opts.note) refuse('gate requires --note (the rationale is the record)');
      const gates = readInput(pos[0]);
      const errs = gates.flatMap((g: any) => (!g.name || !g.cmd) ? [`gate entry missing name or cmd: ${JSON.stringify(g)}`] : []);
      if (errs.length) refuse(errs.join('\n'));
      b.gate ??= [];
      const touched: string[] = [];
      for (const g of gates) {
        const existing = b.gate.find(x => x.name === g.name);
        if (existing) { existing.cmd = g.cmd; touched.push(`~${g.name}`); }
        else { b.gate.push({ name: g.name, cmd: g.cmd }); touched.push(`+${g.name}`); }
      }
      // Releasing the human's park latch is a SEPARATE authority from editing
      // the gate, and opt-in so that a new caller has to claim it. An arm may
      // legitimately add a check while the campaign is held for a human
      // decision — sweep does — and that addition must not answer the decision
      // on the human's behalf. Only an amendment that IS the answer to the park
      // (the red gate's own recovery, or the human) passes the flag.
      const unparked = opts['release-latch'] === true && b.gateState?.parked !== undefined;
      if (unparked) delete b.gateState!.parked;
      save(b);
      journal('gate-amendment', 'campaign-gate', `${opts.note} — gate [${touched.join(', ')}]${unparked ? '; park latch released' : ''}`);
      return `campaign gate amended [${touched.join(', ')}]`;
    }
    case 'fast-checks': {
      // Amend the fast tier — the per-ticket baseline every worker is handed and
      // every verify runs. Seeded at kickoff and, until now, unamendable for the
      // campaign's life: a fast check that turns out to measure the environment
      // rather than the product then reds every ticket identically, and no arm
      // could reach it. Upsert by name, like the gate.
      //
      // There is no removal: dropping a baseline check REDUCES what the campaign
      // proves, and that is a human's call. An amendment can only correct a
      // command in place.
      const b = load();
      if (!opts.note) refuse('fast-checks requires --note (the rationale is the record)');
      const checks = readInput(pos[0]);
      const errs = checks.flatMap((c: any) => (!c.name || !c.cmd) ? [`fastCheck entry missing name or cmd: ${JSON.stringify(c)}`] : []);
      if (errs.length) refuse(errs.join('\n'));
      b.fastChecks ??= [];
      const touched: string[] = [];
      for (const c of checks) {
        const existing = b.fastChecks.find(x => x.name === c.name);
        if (existing) { existing.cmd = c.cmd; touched.push(`~${c.name}`); }
        else { b.fastChecks.push({ name: c.name, cmd: c.cmd }); touched.push(`+${c.name}`); }
      }
      save(b);
      journal('fast-check-amendment', 'campaign-fast-checks', `${opts.note} — fast tier [${touched.join(', ')}]`);
      return `fast tier amended [${touched.join(', ')}]`;
    }
    case 'gate-run': {
      // The gate's verdict, stamped against the backlog it measured. Journals
      // under the same kinds the log always carried, so the post-mortem and the
      // coverage pass keep reading the run as an event.
      const b = load();
      if (pos[0] !== 'green' && pos[0] !== 'red') refuse('gate-run takes a result: green | red');
      if (!opts.note) refuse('gate-run requires --note (which checks ran)');
      const result = pos[0] as 'green' | 'red';
      (b.gateState ??= {}).lastRun = {
        result,
        tickets: b.tickets.length,
        closed: b.tickets.filter(t => t.status === 'closed').length,
        evidence: opts.note as string,
      };
      save(b);
      journal(result === 'green' ? 'campaign-gate-close' : 'gate-red', 'campaign-gate', opts.note as string, parseData());
      return `campaign gate ${result}`;
    }
    case 'gate-park': {
      // The gate went red and recover couldn't get it green within
      // jurisdiction. Latches until a gate amendment clears it.
      const b = load();
      if (!opts.reason) refuse('gate-park requires --reason');
      (b.gateState ??= {}).parked = { reason: opts.reason as string };
      save(b);
      journal('parked', 'campaign-gate', opts.reason as string);
      return 'campaign gate parked';
    }
    case 'set-status': {
      const b = load();
      const t = findTicket(b, pos[0]);
      const to = pos[1];
      if (to === 'closed') refuse('use the close command (evidence is mandatory)');
      if (to === 'decomposed') refuse('use the decompose command (children are mandatory)');
      const dispatchFlags = ['base-sha', 'model', 'rung'].filter(f => opts[f] !== undefined);
      if (dispatchFlags.length && to !== 'in-flight') refuse(`--${dispatchFlags[0]} records a dispatch — only legal on → in-flight`);
      transition(t, to!);
      if (to === 'parked') t.parkReason = (opts.note as string) || 'parked for human decision';
      else if (to === 'open') delete t.parkReason;
      // Only a dispatch carries a base — the re-stamps that put a ticket back
      // in-flight mid-review (typo amendment, closing) leave the original in
      // place, since the branch it refers to was never re-cut.
      if (opts['base-sha'] !== undefined) t.baseSha = opts['base-sha'] as string;
      if (opts.model !== undefined) {
        const rung = opts.rung === undefined ? 1 : Number(opts.rung);
        if (!Number.isInteger(rung) || rung < 1) refuse('--rung must be a positive integer (the 1-based position on the worker chain)');
        t.dispatch = { model: opts.model as string, rung, at: new Date().toISOString() };
      } else if (opts.rung !== undefined) refuse('--rung names a position on the chain, so it needs the --model it resolved to');
      // A dispatch is the one transition that also implies a phase, so it stamps
      // one rather than making the caller spend a second write on the obvious.
      // The re-stamps have no dispatch, and no obvious phase either — whatever
      // they are about to do, they say so themselves.
      if (to === 'in-flight' && opts['base-sha'] !== undefined)
        t.phase = { name: 'dispatched', at: new Date().toISOString() };
      save(b);
      journal(
        to === 'parked' ? 'parked' : 'status',
        t.id,
        to === 'parked' ? t.parkReason! : `→ ${to}${opts.note ? ` — ${opts.note}` : ''}`,
        parseData(),
      );
      return `${t.id} → ${to}`;
    }
    case 'phase': {
      // Its own command because a phase moves WITHOUT a status change — verifying
      // → under-review → merging are all in-flight — and `update` is refused on an
      // in-flight ticket by design. It writes nothing any mechanic reads, so it
      // journals at a lower grade than a transition: the phase line is how the
      // operator sees where a live ticket is, and the timestamp is how they see
      // that it stopped moving.
      const b = load();
      const t = findTicket(b, pos[0]);
      const name = pos[1];
      if (!name || !(PHASES as readonly string[]).includes(name))
        refuse(`phase must be one of: ${PHASES.join(', ')}`);
      if (t.status !== 'in-flight')
        refuse(`${t.id} is ${t.status} — only an in-flight ticket has a phase (the writer clears it when the ticket settles)`);
      t.phase = { name: name as TicketPhase, at: new Date().toISOString() };
      save(b);
      journal('phase', t.id, `${name}${opts.note ? ` — ${opts.note}` : ''}`, parseData());
      return `${t.id} → ${name}`;
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
        ...(opts.infra ? { infra: true } : {}),
      };
      (t.attempts ??= []).push(entry as any);
      if (t.status === 'in-flight') transition(t, 'open'); // back in the queue for re-dispatch
      save(b);
      // `infra` rides the journal beside the telemetry, not only in the ticket.
      // It decides whether this attempt spends merit budget and climbs the model
      // ladder, and backlog.json is deleted at campaign close — a budget-deciding
      // fact that survives only in deleted state cannot be audited afterwards,
      // and campaigns have already walled tickets for faults that were the
      // machine's.
      const settleData = parseData();
      journal('attempt', t.id, `attempt ${entry.n} failed [${entry.failed.join(', ')}]: ${entry.hypothesis}`,
        opts.infra ? { ...(settleData as object ?? {}), infra: true } : settleData);
      return `${t.id} attempt ${entry.n} logged`;
    }
    case 'close': {
      const b = load();
      const t = findTicket(b, pos[0]);
      if (!opts.evidence) refuse('close requires --evidence <path> (independent re-verify output)');
      if (!fs.existsSync(opts.evidence as string)) refuse(`evidence file not found: ${opts.evidence}`);
      transition(t, 'closed');
      t.evidence = opts.evidence as string;
      save(b);
      journal('close', t.id, (opts.note as string) || `closed with evidence ${opts.evidence}`, parseData());
      return `${t.id} closed`;
    }
    case 'decompose': {
      const b = load();
      const t = findTicket(b, pos[0]);
      const ids = new Set(b.tickets.map(x => x.id));
      const children = readInput(pos[1]);
      if (!children.length) refuse('decompose requires child tickets');
      const errs = children.flatMap((c: any) => validateTicket(c, ids, requirementIds(b)));
      if (errs.length) refuse(errs.join('\n'));
      transition(t, 'decomposed');
      const childIds = children.map((c: any) => c.id);
      for (const c of children) {
        b.tickets.push({ depends_on: [], attempts: [], evidence: null, ...c, status: 'open' });
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
      save(b);
      journal('decompose', t.id, `→ [${childIds.join(', ')}]; ${rewired} dependent(s) rewired onto children (narrow the edges if too broad)`);
      return `${t.id} decomposed into ${childIds.join(', ')}; ${rewired} dependents rewired`;
    }
    case 'recover-resolution': {
      const b = load();
      if (!opts.key || !opts.subject || !opts.body)
        refuse('recover-resolution requires --key --subject --body');
      const recoveries = (b.recoveries ??= {});
      const prior = recoveries[opts.key as string] ?? { count: 0, summaries: [] };
      recoveries[opts.key as string] = {
        count: prior.count + 1,
        summaries: [...prior.summaries, opts.body as string],
      };
      save(b);
      journal('recovered', opts.subject as string, opts.body as string,
        { key: opts.key, count: prior.count + 1 });
      return `recovery ${opts.key} → ${prior.count + 1}`;
    }
    // Written only by the flake probe itself, which is the one place that can
    // attest the run happened. Separate from `update` because a probe spends the
    // allowance without touching the ticket's contract at all.
    case 'probe-spent': {
      const b = load();
      const t = findTicket(b, pos[0]);
      const spent = t.amendments?.probe ?? 0;
      if (spent >= 1) refuse(`${t.id} already spent its flake probe`);
      (t.amendments ??= {}).probe = spent + 1;
      save(b);
      journal('flake-probe', t.id, 'flake probe spent — invariant 4 allows one per ticket');
      return `${t.id} probe spent`;
    }
    case 'sweep-run': {
      const b = load();
      if (!opts.body) refuse('sweep-run requires --body (the summary is the rolling memory)');
      // Spending the milestone is what stops it re-triggering, since nothing
      // else could distinguish "swept it" from "about to sweep it again,
      // forever". Omitted for a sweep the coordinator ran off-trigger: that is a
      // reflection worth keeping in the rolling memory, but it answers no
      // checkpoint and must not consume one.
      const spent = [...(b.sweep?.milestones ?? [])];
      const ms = opts.milestone as string | undefined;
      if (ms) {
        if (!(b.milestones ?? []).some(m => m.id === ms))
          refuse(`no milestone ${ms} — declared: [${(b.milestones ?? []).map(m => m.id).join(', ') || 'none'}]`);
        if (spent.includes(ms)) refuse(`milestone ${ms} was already swept`);
        spent.push(ms);
        b.sweep = { milestones: spent };
        save(b);
      }
      journal('sweep', 'campaign', opts.body as string, ms ? { milestone: ms } : undefined);
      return ms ? `sweep recorded — milestone ${ms}` : 'sweep recorded (off-trigger)';
    }
    case 'note': {
      if (!fs.existsSync(JOURNAL) && !fs.existsSync(BACKLOG)) refuse('no campaign here');
      // The body arrives as a flag for a one-liner, or as a stdin payload for
      // document-sized bodies — the campaign report is markdown, and prose
      // routed through a shell argument gets mangled by the shell's own
      // vocabulary ($, backticks) in ways nothing downstream can detect.
      let body = opts.body as string | undefined;
      if (pos[0] !== undefined) {
        if (body !== undefined) refuse('note takes --body or a stdin payload, not both');
        // A bare-positional body is the natural misuse the payload path
        // invites; refuse it by name rather than letting readInput die on the
        // prose as a nonexistent file path.
        if (pos[0] !== '-' && !fs.existsSync(pos[0]!))
          refuse('note body arrives as --body "<one-liner>" or as a {"body": "…"} payload (stdin via `-`, or a JSON file path) — not as a bare positional');
        const payload = readInput(pos[0]);
        if (payload.length !== 1 || typeof payload[0]?.body !== 'string')
          refuse('note payload is a single {"body": "…"} object');
        body = payload[0].body;
      }
      if (!opts.kind || !opts.subject || !body) refuse('note requires --kind --subject and a body (--body or stdin payload)');
      journal(opts.kind as string, opts.subject as string, body, parseData());
      return 'journaled';
    }
    default:
      return refuse(`unknown command: ${cmd}. Commands: init seed add update fast-checks gate gate-run gate-park set-status phase attempt close decompose recover-resolution probe-spent sweep-run note`);
  }
}

// Agents propose ticket ids blind — to each other, and to whatever landed in the
// backlog while they were reading. So they are told to use temporary ids and make
// their internal edges valid against those, and the allocation is done here.
// `recover.md` and `sweep.md` both promise an agent that "the coordinator
// renumbers them", and a coordinator doing it by eye is how a draft's edge onto
// its sibling silently becomes an edge onto an unrelated live ticket that happens
// to hold that number now.
//
// Served as `loop renumber` (mechanics.ts), stdin to stdout, so the allocation
// composes with the writer instead of being described to a model in prose.
export function renumber(tickets: TicketDraft[]): TicketDraft[] {
  const ids = nextTicketIds(tickets.length);
  const remap = new Map(tickets.map((t, i) => [t.id, ids[i]!]));
  return tickets.map((t, i) => ({
    ...t,
    id: ids[i]!,
    depends_on: (t.depends_on ?? []).map(d => remap.get(d) ?? d),
  }));
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
