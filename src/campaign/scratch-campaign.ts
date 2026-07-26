// Test support: a throwaway `.ailoop/campaign` on disk, entered by chdir.
//
// The campaign modules resolve RUN relative to the process cwd and read
// backlog.json / journal.jsonl directly, so the only seam a test can drive is
// the real filesystem. Nothing in production imports this file — it exists so
// the pure folds (frontier arithmetic, gate reads, renumbering) can be exercised
// through their real exported signatures rather than by reshaping them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Backlog, Ticket } from './backlog.ts';
import type { JournalEntry } from './journal.ts';

// A ticket valid enough for the frontier to reason about, with only the fields
// under test spelled out at the call site.
export function buildTicket(over: Partial<Ticket> & { id: string }): Ticket {
  return {
    title: `ticket ${over.id}`,
    files: [`src/${over.id}.ts`],
    origin: 'spec §1',
    context: 'context long enough to clear the sole writer\'s 40-char floor',
    acceptance: 'the check passes',
    acceptanceChecks: [{ name: 'unit', cmd: 'true' }],
    status: 'open',
    ...over,
  };
}

export function buildEntry(over: Partial<JournalEntry>): JournalEntry {
  return { ts: '2026-01-01T00:00:00.000Z', kind: 'note', ...over };
}

// journalEntries() caches on `size:mtimeMs` alone — not on the path — and every
// scratch campaign puts its journal at the same relative path. Two fixtures
// written within the same mtime tick would otherwise read each other's parse, so
// each journal is padded with a distinct number of trailing newlines (split +
// filter(Boolean) drops them) to force the size, and the key, to differ.
let journalPad = 0;

export function withScratchCampaign(
  seed: { backlog?: Partial<Backlog>; journal?: JournalEntry[] },
  body: () => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-campaign-'));
  const run = path.join(dir, '.ailoop', 'campaign');
  fs.mkdirSync(run, { recursive: true });

  if (seed.backlog) {
    const b: Backlog = { project: 'scratch', tickets: [], ...seed.backlog };
    fs.writeFileSync(path.join(run, 'backlog.json'), JSON.stringify(b, null, 2) + '\n');
  }
  if (seed.journal) {
    const lines = seed.journal.map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(path.join(run, 'journal.jsonl'), lines + '\n'.repeat(++journalPad + 1));
  }

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    body();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
