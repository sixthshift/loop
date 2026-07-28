// Worker worktree lifecycle. One worktree + branch per dispatched ticket;
// branches survive until the campaign gate is green (bisection needs them),
// worktrees die as soon as the result is judged.
//
// A worktree lives OUTSIDE the repository. Inside it, the worktree is part of the
// tree every tool scanning the primary checkout walks — a test collector run from
// the root sweeps up duplicate copies of its own suites — and, worse, a runtime
// resolving a dependency from the worktree walks UP into the primary checkout's
// installed tree and finds it. That fallback is partial: imports resolve, paths
// built from the working directory don't, so a missing dependency reports itself
// as broken tests rather than as an unprovisioned worktree. Outside the
// repository, absence fails honestly — and provision.ts makes sure it is absent
// for no other reason than that the primary checkout has nothing to give.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sh } from './state.ts';
import * as tui from '../runtime/reporting.ts';

export type MergeResult = { ok: true } | { ok: false; dirty: boolean; conflict: string };

const branchOf = (id: string) => `ailoop/${id}`;
const dirOf = (id: string) => path.join(worktreesRoot(), id);

// Where worker checkouts live: a sibling of the repository, so it is out of every
// root-anchored scan and out of the resolution chain, while staying on the
// repository's own filesystem — provisioning is near-free within one filesystem
// and pays real bytes across two. Two conditions send it to the user's state
// directory instead, which is writable wherever a home directory is: a parent
// inside another repository, and a parent we may not write to (a repository
// mounted at the root of a container).
//
// Cached against the repository it was resolved for, not just resolved once: the
// root is a function of which checkout we are driving, so a cache that outlived a
// change of repository would answer for the wrong one. Nothing persists it —
// `git worktree list` is git's own record of where the live ones are, and
// attachWorktree rebuilds a survivor from its branch at whatever the current root
// is, so no consumer needs yesterday's location.
const insideRepo = (dir: string) => sh('git rev-parse --show-toplevel', dir).status === 0;

let resolved: { repo: string; root: string } | null = null;
export function worktreesRoot(): string {
  const repo = sh('git rev-parse --show-toplevel').stdout.trim() || process.cwd();
  if (resolved?.repo === repo) return resolved.root;
  const parent = path.dirname(repo);
  // A sibling is only outside a repository if the parent is: a checkout nested
  // inside another repository (a repo of repos, a vendored tree) would put worker
  // worktrees in the OUTER repository's working tree, which is the same fault one
  // level up — its status goes dirty and its collectors sweep our checkouts.
  const sibling = insideRepo(parent) ? null : path.join(parent, '.loop-worktrees', path.basename(repo));
  // Otherwise the act is the probe: creating the directory tests the permission we
  // actually need, at the moment we need it, rather than asking about it and
  // failing later underneath a half-created worktree.
  const root = (sibling && mkdir(sibling)) || mkdir(stateRoot(repo), { required: true })!;
  resolved = { repo, root };
  tui.log(`worktrees: ${root}`);
  return root;
}

function mkdir(dir: string, opts: { required?: boolean } = {}): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e: any) {
    if (opts.required) throw new Error(`worktrees root ${dir} is not writable: ${e.message}`);
    return null;
  }
}

// The fallback root is shared by every repository on the box, so the leaf is keyed
// by the repository's absolute path — two checkouts of the same project must not
// dispatch into each other's worktrees.
function stateRoot(repo: string): string {
  const home = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const key = crypto.createHash('sha1').update(repo).digest('hex').slice(0, 8);
  return path.join(home, 'loop', 'worktrees', `${path.basename(repo)}-${key}`);
}

// Cutting the checkout only. Filling it — copying the primary tree's installed
// dependencies in — is provision.ts's job and the caller's to schedule, because on
// a filesystem without clone or hardlink it takes seconds per ticket and must not
// run on the coordinator's critical path.
export function createWorktree(id: string): { dir: string; branch: string; baseSha: string } {
  removeWorktree(id); // a stale worktree from a dead run must not block re-dispatch
  const dir = dirOf(id);
  const branch = branchOf(id);
  sh(`git branch -D ${branch}`);
  const r = sh(`git worktree add -b ${branch} "${dir}" HEAD`);
  if (r.status !== 0) throw new Error(`worktree add ${id}: ${r.stderr}`);
  const baseSha = sh('git rev-parse HEAD', dir).stdout.trim();
  return { dir, branch, baseSha };
}

export function attachWorktree(id: string): { dir: string; branch: string } | null { // resume: rebuild a worktree from a surviving branch
  const branch = branchOf(id);
  if (sh(`git rev-parse --verify ${branch}`).status !== 0) return null;
  const dir = dirOf(id);
  sh(`git worktree remove --force "${dir}"`);
  const r = sh(`git worktree add "${dir}" ${branch}`);
  if (r.status !== 0) throw new Error(`worktree attach ${id}: ${r.stderr}`);
  return { dir, branch };
}

export function removeWorktree(id: string): void {
  sh(`git worktree remove --force "${dirOf(id)}"`);
  sh('git worktree prune');
}

export function deleteBranch(id: string): void {
  sh(`git branch -D ${branchOf(id)}`);
}

// `--ff` is explicit, not left to git's default: a repository (or user) carrying
// `merge.ff = false` would otherwise reintroduce the merge commit this avoids, and
// the campaign's own history should not be shaped by ambient config. A landing
// whose base is still mainline's tip is exactly a fast-forward, and a merge commit
// there records nothing the journal's close event doesn't already hold; the `-m`
// message is used only when mainline has genuinely diverged.
export function mergeBranch(id: string): MergeResult {
  const branch = branchOf(id);
  const r = sh(`git merge --ff --no-edit -m "loop: merge ${id}" ${branch}`);
  if (r.status === 0) return { ok: true };
  sh('git merge --abort');
  const out = r.stdout + r.stderr;
  // "would be overwritten" is git refusing over a dirty mainline checkout —
  // an environment fault, distinct from a real divergence: rebuilding the
  // ticket against HEAD can't fix it, only cleaning the tree can.
  return { ok: false, dirty: /would be overwritten/.test(out), conflict: out.slice(-2000) };
}

export function mainSha(): string {
  return sh('git rev-parse HEAD').stdout.trim();
}
