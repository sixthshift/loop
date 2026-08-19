// journal.jsonl access — the campaign's append-only event log. Backlog-state
// entries are journaled by the sole writer as it mutates the backlog;
// measurement telemetry (verify timings) appends directly through
// appendJournal below — a fact about a run, never backlog state.
//
// The log is audit-only: what happened, narrated for a human, reflective agents,
// and the post-mortem. No caller reconstructs current ticket state, the locked
// contract, recovery budgets, swept milestones, or gate freshness by folding these
// entries — those facts live on backlog.json. Audit consumers may lose context
// if the log is damaged; the coordinator's next state transition does not.

import fs from 'node:fs';
import path from 'node:path';
import { RUN } from './paths.ts';

export type JournalEntry = { ts: string; seq?: number; kind: string; subject?: string; body?: string; data?: any };

// Parsed-journal cache keyed on size+mtime: the dashboard re-renders many
// times a second while agents stream, and an append-only jsonl only needs
// re-parsing when it actually grew.
let journalCache: { key: string; entries: JournalEntry[] } = { key: '', entries: [] };

export function journalEntries(): JournalEntry[] {
  const file = path.join(RUN, 'journal.jsonl');
  if (!fs.existsSync(file)) return [];
  try {
    const st = fs.statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    if (journalCache.key !== key) {
      const entries: JournalEntry[] = [];
      let damaged = 0;
      for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        try { entries.push(JSON.parse(line)); }
        catch { damaged++; }
      }
      if (damaged) console.error(`journal audit skipped ${damaged} malformed entr${damaged === 1 ? 'y' : 'ies'}`);
      journalCache = { key, entries };
    }
    return journalCache.entries;
  } catch (e: any) {
    console.error(`journal audit unavailable: ${e.message}`);
    return [];
  }
}

export function journalTail(n = 40): JournalEntry[] {
  return journalEntries().slice(-n);
}

// Append a measurement fact. Seq is the 1-based line count; the size+mtime
// cache above invalidates itself on the next read, so no explicit bust.
export function appendJournal(entry: Omit<JournalEntry, 'seq' | 'ts'>): boolean {
  try {
    const file = path.join(RUN, 'journal.jsonl');
    const seq = (fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
      : 0) + 1;
    fs.appendFileSync(file, JSON.stringify({
      seq,
      ts: new Date().toISOString(),
      ...entry,
    }) + '\n');
    return true;
  } catch (e: any) {
    console.error(`journal audit append failed: ${e.message}`);
    return false;
  }
}
