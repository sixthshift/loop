// journal.jsonl access — the campaign's append-only event log. Read-only here:
// entries are appended only through backlogWrite (the sole writer), so this
// module just parses the tail the dashboard and coordinator read back.

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
