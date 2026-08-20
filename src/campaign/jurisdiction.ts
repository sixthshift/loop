// The mechanical half of recover's product-code boundary.
//
// Recover is the campaign's most privileged actor — the shared mainline
// checkout, full tools, permissions bypassed — and its one hard rule, "never
// touch product code", has lived only in its prompt. Prose is the wrong
// enforcement layer for the one actor that can edit the thing every other arm is
// measured against: a worker's diff meets an adversarial judge and then the
// merged-tree gate, while recover's edit to the same file meets nobody.
//
// So the boundary is checked rather than asked for. Nothing else runs while
// recover does — a live worker is settled or killed first — so the difference
// between the tree before and after is attributable to recover alone. Serial
// checkouts add a second axis to defend: HEAD. The snapshot refuses to start
// anywhere but the recorded mainline and pins the ref; the revert returns to
// that ref before measuring — fired with HEAD on a ticket branch, the diff
// would read the whole ticket's work as recover's breach and reset it away.
//
// In bounds: untracked files (a scratch reproduction is how a fault gets
// diagnosed), manifests and lockfiles (an install IS a manifest edit — the
// allowlist is footprint.ts's, the same one the ticket scope check uses), the
// campaign's own `.ailoop/` state, and cleaning away dirt that was already
// there when recover arrived. Campaign-definition changes never appear here at
// all: they go through the backlog writer, not git.
//
// Out of bounds: a tracked, non-manifest file whose content changed. The reply
// is to undo it and route the intent through a repair ticket — built by a
// worker, judged by the review, measured by the gate. The undo is what makes
// this enforcement instead of another note nobody acts on.

import path from 'node:path';
import { sh } from './state.ts';
import { assertOnMainline, currentRef } from './checkout.ts';
import { isManifest } from './footprint.ts';

export type TreeSnapshot = { ref: string; sha: string; dirt: string[] };
// `reverted: false` means the breach is STANDING — the undo was refused or
// failed, and the caller owes the human a park rather than a reassuring note.
// `ref` reports a run that left HEAD somewhere else, and whether the revert
// got it back.
export type Breach = {
  paths: string[]; diff: string; reverted: boolean;
  ref?: { expected: string; found: string; restored: boolean };
};

const CAMPAIGN = '.ailoop/';
const DIFF_CAP = 20_000; // the repair ticket carries this; a worker needs the shape, not every hunk

export function snapshotTree(): TreeSnapshot {
  const main = assertOnMainline('jurisdiction snapshot', 'recover is trusted with the mainline checkout only');
  return { ref: main, sha: headSha(), dirt: porcelain() };
}

// Which paths a run put out of bounds. Working-tree lines are compared verbatim
// against the snapshot, so dirt that was already present stays its owner's (the
// dirty-mainline anomaly IS pre-existing dirt) and clearing dirt away — which
// only ever removes lines — is never a violation.
//
// Known limit: a file already modified when recover started and modified again
// by recover keeps the same `M path` line and slips through. The check is exact
// for every anomaly that arrives on a clean mainline, which is all of them
// except dirty-mainline.
export function outOfBounds(before: string[], after: string[], committed: string[]): string[] {
  const known = new Set(before);
  const staged = after
    .filter(l => !known.has(l) && !l.startsWith('??') && !l.startsWith('!!'))
    .map(porcelainPath);
  return [...new Set([...staged, ...committed])]
    .filter(p => p && !isManifest(p) && !p.startsWith(CAMPAIGN));
}

// Undo whatever the run left outside its jurisdiction, returning what was undone
// and the diff that recorded it. Empty paths is the ordinary result.
//
// First obligation: HEAD. Every measurement below diffs against the pinned
// ref's history, so a run that wandered off it is put back before anything is
// compared — and a return that git refuses (the run left tracked
// modifications that can't carry over) is a standing breach, not a guess.
export function revertOutOfBounds(before: TreeSnapshot): Breach {
  if (!before.ref) throw new Error('snapshot predates serial checkouts — no ref pinned; nothing safe to revert against');
  const found = currentRef();
  const moved = found !== before.ref
    ? { expected: before.ref, found: found || '(detached)', restored: sh(`git checkout ${before.ref}`).status === 0 }
    : undefined;
  if (moved && !moved.restored) return { paths: [], diff: '', reverted: false, ref: moved };
  const withRef = (b: Breach): Breach => (moved ? { ...b, ref: moved } : b);

  const sha = headSha();
  const committed = sha === before.sha ? [] : diffNames(`${before.sha}..HEAD`);
  const paths = outOfBounds(before.dirt, porcelain(), committed);
  if (!paths.length) return withRef({ paths: [], diff: '', reverted: true });

  const spec = paths.map(quote).join(' ');
  // Captured before the undo: this diff is the only surviving account of what
  // recover was trying to do, and the repair ticket is written from it.
  const diff = [
    sha === before.sha ? '' : sh(`git diff ${before.sha}..HEAD -- ${spec}`).stdout,
    sh(`git diff -- ${spec}`).stdout,
  ].filter(t => t.trim()).join('\n').slice(0, DIFF_CAP);

  if (committed.length) {
    // A commit can't be undone path-by-path without authoring another commit in
    // recover's name, and nothing else runs while recover does (invariant 3), so
    // no one else's work sits on top of the one being reset away. The
    // reset takes any allowed manifest change in the same commit down with it —
    // a mixed commit is itself out of bounds, and the diff above preserves it.
    //
    // Unless the repository tracks `.ailoop/`. Then a reset would also roll the
    // campaign's own backlog and journal back to whatever they held when recover
    // started — silently undoing this run's bookkeeping to punish it. Refuse and
    // report the breach standing: an unreverted breach the human is told about
    // beats a revert that corrupts the ledger recording it.
    if (campaignTracked()) return withRef({ paths, diff, reverted: false });
    if (sh(`git reset --hard ${before.sha}`).status !== 0) return withRef({ paths, diff, reverted: false });
  } else {
    for (const p of paths) {
      // Tracked in HEAD → restore it. Otherwise recover staged a NEW file:
      // untrack it and leave it on disk, because untracked is in bounds and
      // destroying content nobody has read is not this function's call.
      if (sh(`git cat-file -e HEAD:${quote(p)}`).status === 0) sh(`git checkout -q HEAD -- ${quote(p)}`);
      else sh(`git rm -q --cached -- ${quote(p)}`);
    }
  }
  return withRef({ paths, diff, reverted: true });
}

// Campaign state normally sits untracked (or ignored) beside the work. A repo
// that commits it turns `git reset` from a containment tool into a corruption.
const campaignTracked = (): boolean => sh(`git ls-files -- ${CAMPAIGN}`).stdout.trim().length > 0;

// The directories a breach touched, in the shape a ticket declares a footprint:
// repo-relative directories, with the repository root spelled `.`.
export const breachedModules = (paths: string[]): string[] =>
  [...new Set(paths.map(p => path.posix.dirname(p) || '.'))];

const headSha = (): string => sh('git rev-parse HEAD').stdout.trim();

const porcelain = (): string[] => sh('git status --porcelain').stdout.split('\n').filter(l => l.trim());

const diffNames = (range: string): string[] =>
  sh(`git diff --name-only ${range}`).stdout.split('\n').map(l => l.trim()).filter(Boolean);

// `XY path`, `R  old -> new`, and git's quoting of paths with unusual bytes.
function porcelainPath(line: string): string {
  const raw = line.slice(3).trim();
  const renamed = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw;
  return renamed.startsWith('"') && renamed.endsWith('"') ? renamed.slice(1, -1) : renamed;
}

const quote = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;
