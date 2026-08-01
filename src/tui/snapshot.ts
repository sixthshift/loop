// Everything the dashboard draws, read from disk in one pass.
//
// The dashboard used to share a process with the coordinator and read its
// memory: a map of live agents, a ring of narration lines, a campaign clock
// started at mount. None of that is available any more, and the reason is worth
// stating plainly rather than working around. The coordinator is a model in a
// conversation. It has no process the dashboard can attach to, no event stream,
// and no way to be asked a question. What it leaves behind is files.
//
// So this module reads the files, and the shape it returns is deliberately
// narrow: a Snapshot is a value, not a subscription. The dashboard polls it and
// re-renders. Polling rather than fs.watch because backlog.json is replaced by
// atomic rename — the inode a watcher holds is not the inode the next write
// lands on, so a path watcher misses exactly the updates that matter.
//
// The honest consequence, and the thing every reader of this file should know:
// there is no liveness here, only staleness. Nothing on disk distinguishes "the
// coordinator is thinking" from "the coordinator's session died forty minutes
// ago", because the gap the dashboard needs covered is precisely when the
// coordinator is not writing. `lastActivityAt` is the best available signal and
// it is reported as what it is.

import fs from 'node:fs';
import path from 'node:path';
import { backlog, campaignExists } from '../campaign/backlog.ts';
import type { Backlog } from '../campaign/backlog.ts';
import { journalTail } from '../campaign/journal.ts';
import type { JournalEntry } from '../campaign/journal.ts';
import { liveRuns } from '../campaign/live.ts';
import type { LiveRun } from '../campaign/live.ts';
import { RUN } from '../campaign/paths.ts';

export type Snapshot = {
  // null once the campaign is over (state is deleted at termination) or before
  // it starts. The dashboard is legitimately open across both.
  backlog: Backlog | null;
  journal: JournalEntry[];
  // Checks running right now, published by the verb holding each child process.
  // These ARE measured liveness — a pid was probed — unlike everything else here.
  runs: LiveRun[];
  // When the campaign's audit log was last appended to. NOT a heartbeat: a
  // coordinator mid-way through a twenty-minute review writes nothing, and looks
  // identical to one that is gone.
  lastActivityAt: number | null;
  readAt: number;
};

// How much journal the views can want at once. The journal pane scrolls within
// this window; anything older is in the file and in the post-mortem, which is
// where a question about the deep past belongs.
const JOURNAL_WINDOW = 500;

export function readSnapshot(): Snapshot {
  const b = safe(() => (campaignExists() ? backlog() : null)) ?? null;
  return {
    backlog: b,
    journal: safe(() => journalTail(JOURNAL_WINDOW)) ?? [],
    runs: safe(liveRuns) ?? [],
    lastActivityAt: safe(journalMtime) ?? null,
    readAt: Date.now(),
  };
}

// Every read here is against files another process is actively replacing, so a
// throw is an expected outcome rather than an error: the campaign directory can
// be deleted between two polls (termination does exactly that), and a rename can
// land between a stat and a read. The next poll gets it.
const safe = <T,>(fn: () => T): T | undefined => {
  try { return fn(); } catch { return undefined; }
};

const journalMtime = (): number | null => {
  try { return fs.statSync(path.join(RUN, 'journal.jsonl')).mtimeMs; }
  catch { return null; }
};

// --- what the active pane shows ---------------------------------------------

// One selectable line of live work. Tickets come from the backlog and runs from
// the live directory, and they are one list rather than two panes because they
// are one question — "what is happening right now" — answered at two grains: a
// ticket is where the campaign is, a run is what is executing.
export type ActiveRow =
  | { kind: 'ticket'; key: string; ticket: Backlog['tickets'][number] }
  | { kind: 'run'; key: string; run: LiveRun };

// In-flight tickets, each followed by the checks running inside it, then any run
// that belongs to no ticket — a campaign gate, a fast-tier probe at the root.
//
// A ticket with no run under it is the normal case, not a gap: for most of a
// ticket's life the thing working on it is an agent in the coordinator's session,
// which publishes nothing here. Its phase is what stands in for the tail.
export function activeRows(snap: Snapshot): ActiveRow[] {
  const tickets = (snap.backlog?.tickets ?? []).filter(t => t.status === 'in-flight');
  const claimed = new Set<string>();
  const rows: ActiveRow[] = [];

  for (const ticket of tickets) {
    rows.push({ kind: 'ticket', key: ticket.id, ticket });
    for (const run of snap.runs) {
      if (run.ticketId !== ticket.id) continue;
      claimed.add(run.label);
      rows.push({ kind: 'run', key: run.label, run });
    }
  }
  for (const run of snap.runs) {
    if (!claimed.has(run.label)) rows.push({ kind: 'run', key: run.label, run });
  }
  return rows;
}

// How long the campaign has been quiet, and whether that is worth a colour.
// Thresholds are generous on purpose: a review agent reading a large diff, a
// worker mid-build, and a coordinator waiting on a slow model all legitimately
// write nothing for minutes. Amber means "longer than any single step should
// take"; it is a prompt to look, never a verdict.
export type Staleness = {
  quietForMs: number | null;
  grade: 'active' | 'quiet' | 'stale' | 'unknown';
};

const QUIET_MS = 5 * 60_000;
const STALE_MS = 20 * 60_000;

export function staleness(snap: Snapshot): Staleness {
  // A probed pid outranks the clock: a two-hour e2e suite writes nothing to the
  // journal and is the healthiest the campaign ever looks.
  if (snap.runs.length) return { quietForMs: 0, grade: 'active' };
  if (snap.lastActivityAt === null) return { quietForMs: null, grade: 'unknown' };
  const quietForMs = Math.max(0, snap.readAt - snap.lastActivityAt);
  return {
    quietForMs,
    grade: quietForMs > STALE_MS ? 'stale' : quietForMs > QUIET_MS ? 'quiet' : 'active',
  };
}
