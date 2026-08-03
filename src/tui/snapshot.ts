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
