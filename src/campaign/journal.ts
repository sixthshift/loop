// journal.jsonl access — the campaign's append-only event log. Backlog-state
// entries are journaled by the sole writer as it mutates the backlog;
// measurement telemetry (verify timings) appends directly through
// appendJournal below — a fact about a run, never backlog state.
//
// The log is record-only for backlog state: what happened, narrated for a
// human, an agent's context window, and the post-mortem. No caller reconstructs
// a ticket or gate fact by folding these entries — those live on backlog.json,
// so a truncated, hand-edited, or seq-less journal can never change a verdict.
// Three reads do still branch on the log, and all three are about the log
// itself rather than about the work: the kickoff record that identifies a
// resumable campaign, the sweep's "enough has happened since last time"
// cadence, and recover's "how many times have I already resolved this one"
// budget — a count of past events is exactly what a ledger of current state
// cannot hold.

import fs from 'node:fs';
import path from 'node:path';
import { RUN } from './state.ts';

export type JournalEntry = { ts: string; seq?: number; kind: string; subject?: string; body?: string; data?: any };

// Parsed-journal cache keyed on size+mtime: the dashboard re-renders many
// times a second while agents stream, and an append-only jsonl only needs
// re-parsing when it actually grew.
let journalCache: { key: string; entries: JournalEntry[] } = { key: '', entries: [] };

export function journalEntries(): JournalEntry[] {
  const file = path.join(RUN, 'journal.jsonl');
  if (!fs.existsSync(file)) return [];
  const st = fs.statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  if (journalCache.key !== key) {
    journalCache = { key, entries: fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) };
  }
  return journalCache.entries;
}

export function journalTail(n = 40): JournalEntry[] {
  return journalEntries().slice(-n);
}

// Append a measurement fact. Seq is the 1-based line count; the size+mtime
// cache above invalidates itself on the next read, so no explicit bust.
export function appendJournal(entry: Omit<JournalEntry, 'seq' | 'ts'>): void {
  const file = path.join(RUN, 'journal.jsonl');
  const seq = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0) + 1;
  fs.appendFileSync(file, JSON.stringify({ seq, ts: new Date().toISOString(), ...entry }) + '\n');
}
