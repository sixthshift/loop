// The serial checkout lifecycle. One branch per dispatched ticket, cut from
// and landed back onto the recorded mainline, all in the primary checkout —
// worktree isolation was removed on purpose: one ticket is in flight at a
// time, and the worker shares the tree with the coordinator and the
// campaign's own `.ailoop/` state.
//
// The pact that makes that survivable: `create` refuses any tree that is not
// exactly mainline plus nothing — untracked files included — BECAUSE
// `discard` answers worker litter with `git checkout -- .` and
// `git clean -fd`. Every file the clean can see is a file some worker
// created; anything a human left lying around would be indistinguishable
// from litter and deleted with it. Loosening the refusal arms the clean.
//
// Branches survive until the campaign gate is green (bisection needs them);
// the checkout returns to mainline as each ticket settles.

import { sh } from './state.ts';
import { mainline } from './backlog.ts';

export type MergeResult = { ok: true } | { ok: false; dirty: boolean; conflict: string };
export type CreateResult =
  | { ok: true; branch: string; baseSha: string }
  | { ok: false; reason: string; paths?: string[] };

const branchOf = (id: string) => `ailoop/${id}`;

const currentRef = (): string => sh('git symbolic-ref --short -q HEAD').stdout.trim(); // '' when detached

// Everything in the tree that git history doesn't explain, minus the
// campaign's own state — the same exclusion verify's dirty refusal makes.
const litter = (): string[] =>
  sh('git status --porcelain').stdout.split('\n')
    .filter(l => l.trim() && !l.slice(3).startsWith('.ailoop/'))
    .map(l => l.slice(3));

export function createBranch(id: string): CreateResult {
  const main = mainline();
  const at = currentRef();
  if (at !== main)
    return { ok: false, reason: `HEAD is on ${at || '(detached)'}, not ${main} — land or discard the ticket that holds the checkout first` };
  const paths = litter();
  if (paths.length)
    return { ok: false, reason: 'the checkout is not clean — commit, stash, or gitignore these before dispatch', paths };
  sh('git worktree prune'); // a worktree-era campaign's registrations would otherwise pin the branch
  sh(`git branch -D ${branchOf(id)}`); // a stale branch from a dead attempt must not block re-dispatch
  const r = sh(`git checkout -b ${branchOf(id)}`);
  if (r.status !== 0) throw new Error(`branch create ${id}: ${r.stderr}`);
  return { ok: true, branch: branchOf(id), baseSha: mainSha() };
}

// Resume: put the checkout back on a surviving branch, or report there is
// nothing to attach. Uncommitted litter from the dead session is the
// caller's to erase first (`discard`, then attach) — this verb judges
// nothing.
export function attachBranch(id: string): { branch: string } | null {
  const branch = branchOf(id);
  if (sh(`git rev-parse --verify ${branch}`).status !== 0) return null;
  const r = sh(`git checkout ${branch}`);
  if (r.status !== 0) throw new Error(`branch attach ${id}: ${r.stderr}`);
  return { branch };
}

// The rejection path: erase worker litter, return the checkout to mainline.
// Clean before checkout, load-bearing order — an untracked worker file
// shadowing a tracked mainline path would make the checkout itself refuse.
// The branch is untouched: rejected or not, it survives for gate bisection
// until the retrospective reaps it.
export function discardCheckout(): { mainline: string } {
  sh('git checkout -- .');
  sh('git clean -fd -e .ailoop');
  const main = mainline();
  const r = sh(`git checkout ${main}`);
  if (r.status !== 0) throw new Error(`branch discard: checkout ${main}: ${r.stderr}`);
  return { mainline: main };
}

// Landing: return to mainline and fast-forward it onto the ticket branch.
// `--ff-only` where the worktree era took `--ff`: serially the branch's base
// is always mainline's tip, so a landing that cannot fast-forward means
// something else moved the ref — interference to classify as infra, not a
// divergence to resolve.
export function landBranch(id: string): MergeResult {
  const main = mainline();
  const co = sh(`git checkout ${main}`);
  if (co.status !== 0) {
    const out = co.stdout + co.stderr;
    return { ok: false, dirty: /would be overwritten/.test(out), conflict: out.slice(-2000) };
  }
  const r = sh(`git merge --ff-only ${branchOf(id)}`);
  if (r.status === 0) return { ok: true };
  const out = r.stdout + r.stderr;
  return { ok: false, dirty: /would be overwritten/.test(out), conflict: out.slice(-2000) };
}

export function deleteBranch(id: string): void {
  sh(`git branch -D ${branchOf(id)}`);
}

export function mainSha(): string {
  return sh(`git rev-parse ${mainline()}`).stdout.trim();
}
