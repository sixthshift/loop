// Finding which landing broke a red campaign gate.
//
// Every closed ticket's branch survives until the gate is green, and a landing
// is a fast-forward, so `ailoop/<id>` IS the mainline as it stood the moment
// that ticket landed. Checking one out and running the failing command answers
// "was it already broken here?" — and because the branches are ordered by their
// close events, the answer is monotone and the search is a bisection rather than
// a scan. On a gate check that takes twenty minutes, that is the difference
// between one evening and several.
//
// This exists as a verb for one reason, and it is not the search: the procedure
// it replaces ended "and finish with HEAD back on mainline, because every
// measurement and the jurisdiction snapshot assume it." That obligation sat in
// prose, at the end of a long manual loop, at the point in a campaign where the
// coordinator is most distracted — and forgetting it does not fail, it silently
// aims every later measurement at the wrong tree. Here it is a `finally`.
//
// Not worktrees, deliberately. A read-only reviewer needs no dependency tree,
// but bisection RUNS the failing check, so an isolated checkout would need the
// project's dependencies installed into it — the exact provisioning that made
// worktrees fail before they were removed. The primary checkout already has
// them.

import { sh, shAsync } from './state.ts';
import { backlog, mainline } from './backlog.ts';
import { journalEntries, appendJournal } from './journal.ts';

export type BisectStep = { ticket: string; branch: string; status: number | null; ms: number };
export type BisectResult = {
  cmd: string;
  // The earliest landing at which the command was already red. Null means every
  // landing tested green, which is a finding: the fault is in the merge of work
  // no single branch carries, or in the gate command itself.
  firstRed: string | null;
  lastGreen: string | null;
  tested: BisectStep[];
  skipped: string[];
};

// Close order, from the journal rather than the backlog: `closed` is a status,
// not a sequence, and the order tickets landed in is exactly what the search
// bisects over.
function landOrder(): string[] {
  const closed = new Set(backlog().tickets.filter(t => t.status === 'closed').map(t => t.id));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const e of journalEntries()) {
    if (e.kind !== 'close' || !e.subject || seen.has(e.subject) || !closed.has(e.subject)) continue;
    seen.add(e.subject);
    order.push(e.subject);
  }
  return order;
}

const branchExists = (branch: string): boolean =>
  sh(`git rev-parse --verify -q refs/heads/${branch}`).status === 0;

export async function bisect({ cmd, dir = '.' }: { cmd: string; dir?: string }): Promise<BisectResult> {
  const main = mainline();
  const at = sh('git symbolic-ref --short -q HEAD').stdout.trim();
  if (at !== main)
    throw new Error(`bisect: HEAD is on ${at || '(detached)'}, not ${main} — start from the tree the gate measured`);
  const dirty = sh('git status --porcelain').stdout.split('\n')
    .filter(l => l.trim() && !l.slice(3).startsWith('.ailoop/')).join('\n').trim();
  if (dirty) throw new Error(`bisect: the checkout is dirty and every step checks out a branch:\n${dirty}`);

  const order = landOrder();
  const skipped = order.filter(id => !branchExists(`ailoop/${id}`));
  const candidates = order.filter(id => branchExists(`ailoop/${id}`));
  const tested: BisectStep[] = [];

  const runAt = async (id: string): Promise<boolean> => {
    const branch = `ailoop/${id}`;
    sh(`git checkout -q ${branch}`);
    const startedAt = Date.now();
    const r = await shAsync(cmd, dir, { label: `bisect · ${id}` });
    tested.push({ ticket: id, branch, status: r.status, ms: Date.now() - startedAt });
    return r.status === 0;
  };

  try {
    // Binary search for the earliest red. `lo` is the first untested index and
    // `hi` the first known-red one; the invariant is that everything below `lo`
    // ran green, so the answer is `lo` when they meet.
    let lo = 0, hi = candidates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (await runAt(candidates[mid]!)) lo = mid + 1;
      else hi = mid;
    }
    const firstRed = lo < candidates.length ? candidates[lo]! : null;
    const lastGreen = lo > 0 ? candidates[lo - 1]! : null;

    appendJournal({
      kind: 'bisect', subject: firstRed ?? 'campaign',
      body: firstRed
        ? `\`${cmd}\` first red at ${firstRed}${lastGreen ? ` (green through ${lastGreen})` : ' (red from the first landing)'} — ${tested.length} of ${candidates.length} branches run`
        : `\`${cmd}\` was green at every landing — the fault is not in one branch: suspect the merged tree or the command itself`,
      data: { cmd, firstRed, lastGreen, tested, skipped },
    });
    return { cmd, firstRed, lastGreen, tested, skipped };
  } finally {
    // Not best-effort. Every measurement downstream, and the jurisdiction
    // snapshot recover runs under, assume the checkout is mainline; leaving it
    // on a ticket branch does not fail anything loudly, it just makes the next
    // reading describe the wrong tree.
    sh(`git checkout -q ${main}`);
  }
}
