// backlog.json access — the campaign's ticket ledger. Reads are direct; every
// mutation goes through backlog-write.mjs (the sole writer, which journals as it
// writes), so this module reads the file and shells the writer but never edits
// backlog.json in place.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RUN } from './state.ts';
import type { Check, TicketDraft } from '../agent/schemas.ts';

// A backlog ticket is the agent-proposed draft plus the runtime fields the
// sole writer stamps onto it over its life.
export type TicketStatus = 'draft' | 'vetted' | 'in-flight' | 'closed' | 'blocked' | 'failed-wall' | 'decomposed';
export type Attempt = { failed: string[] | string; hypothesis?: string; fix?: string };
export type Ticket = TicketDraft & { status: TicketStatus; attempts?: Attempt[]; evidence?: string };
export type Phase = { id: string; delivers: string; gate?: Check[] };
export type Backlog = {
  project: string;
  phases: Phase[];
  tickets: Ticket[];
  fastChecks?: Check[];
  outOfScope?: string[];
};

export function backlog(): Backlog {
  return JSON.parse(fs.readFileSync(path.join(RUN, 'backlog.json'), 'utf8'));
}

export function ticket(id: string): Ticket {
  const t = backlog().tickets.find(x => x.id === id);
  if (!t) throw new Error(`no ticket ${id}`);
  return t;
}

// One command against the sole writer. `input` (object|array) is piped as
// stdin JSON for commands that take a payload. Throws with the script's
// refusal text — callers decide whether a refusal is a bug or a triage case.
export function backlogWrite(args: string[], input?: unknown): string {
  const argv = ['node', path.join(RUN, 'backlog-write.mjs'), ...args];
  const r = spawnSync(argv[0]!, argv.slice(1), {
    encoding: 'utf8',
    input: input === undefined ? undefined : JSON.stringify(input),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`backlog-write ${args[0]} REFUSED: ${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
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
