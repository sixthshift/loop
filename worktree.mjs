// Worker worktree lifecycle. One worktree + branch per dispatched ticket;
// branches survive until phase close (bisection needs them), worktrees die
// as soon as the result is judged.

import fs from 'node:fs';
import path from 'node:path';
import { sh, WORKTREES } from './run.mjs';

const branchOf = id => `ailoop/${id}`;
const dirOf = id => path.join(WORKTREES, id);

export function createWorktree(id) {
  fs.mkdirSync(WORKTREES, { recursive: true });
  removeWorktree(id); // a stale worktree from a dead run must not block re-dispatch
  const dir = dirOf(id);
  const branch = branchOf(id);
  sh(`git branch -D ${branch}`);
  const r = sh(`git worktree add -b ${branch} ${dir} HEAD`);
  if (r.status !== 0) throw new Error(`worktree add ${id}: ${r.stderr}`);
  const baseSha = sh('git rev-parse HEAD', dir).stdout.trim();
  return { dir, branch, baseSha };
}

export function attachWorktree(id) { // resume: rebuild a worktree from a surviving branch
  const branch = branchOf(id);
  if (sh(`git rev-parse --verify ${branch}`).status !== 0) return null;
  fs.mkdirSync(WORKTREES, { recursive: true });
  const dir = dirOf(id);
  sh(`git worktree remove --force ${dir}`);
  const r = sh(`git worktree add ${dir} ${branch}`);
  if (r.status !== 0) throw new Error(`worktree attach ${id}: ${r.stderr}`);
  return { dir, branch };
}

export function removeWorktree(id) {
  sh(`git worktree remove --force ${dirOf(id)}`);
  sh('git worktree prune');
}

export function deleteBranch(id) {
  sh(`git branch -D ${branchOf(id)}`);
}

export function mergeBranch(id) {
  const branch = branchOf(id);
  const r = sh(`git merge --no-ff --no-edit -m "loop: merge ${id}" ${branch}`);
  if (r.status === 0) return { ok: true };
  sh('git merge --abort');
  return { ok: false, conflict: (r.stdout + r.stderr).slice(-2000) };
}

export function mainSha() {
  return sh('git rev-parse HEAD').stdout.trim();
}
