// Making a worker's checkout runnable. `git worktree add` materialises tracked
// files only, and a repository's installed dependencies are ignored by git, so a
// fresh worktree has none of them — while every fastCheck and every acceptance
// check the campaign runs runs in there. An unprovisioned worktree therefore
// reds every ticket's baseline identically, whatever the diff: the whole campaign
// fails for a reason no ticket owns, which is the failure this file exists to
// prevent.
//
// It copies rather than installs, deliberately: installing needs the network and
// re-runs native build hooks, while the tree beside us is already built and is
// the one the baseline was proven green against. Copying is also the only rung
// that works in a sandbox with no registry access.

// Every shell call here is async, and that is load-bearing rather than stylistic:
// where the filesystem can neither clone nor hardlink, the copy moves hundreds of
// megabytes and takes seconds. Run synchronously it would hold the coordinator's
// event loop — and therefore the live display — once per dispatch, freezing the
// dashboard for the wave. The caller keeps this off its critical path (see
// drive.ts's dispatch).

import fs from 'node:fs';
import path from 'node:path';
import { shAsync } from './state.ts';
import * as tui from '../runtime/reporting.ts';

// Directory names a toolchain resolves relative to the working directory. Fixed
// names rather than detection: the list is short and additive, and being wrong on
// it is harmless in one direction only — every candidate is intersected with what
// git actually ignores, so a `vendor/` that a Go project tracks is never a
// candidate at all.
const DEP_ROOTS = new Set(['node_modules', '.venv', 'venv', 'vendor']);

// Copy strategies, cheapest first, selected by exit code rather than by platform:
// the two clone spellings are the same act in GNU and BSD `cp`, and which one is
// on PATH is not a property of the OS (a mac with coreutils installed has GNU).
//
// Clone is tried before hardlink on purpose. A hardlinked file IS the primary
// checkout's file, so a tool that rewrites something inside the dependency tree
// in place — a bundler's cache lives there — would silently edit the checkout
// every other worker is reading. Clone and copy cannot; hardlink stays as the
// rung that keeps this free on a filesystem without copy-on-write.
const COPY_RUNGS: { how: string; cmd: (src: string, dst: string) => string }[] = [
  { how: 'clone', cmd: (s, d) => `cp -a --reflink=always "${s}" "${d}"` },
  { how: 'clone', cmd: (s, d) => `cp -ac "${s}" "${d}"` },
  { how: 'hardlink', cmd: (s, d) => `cp -al "${s}" "${d}"` },
  { how: 'copy', cmd: (s, d) => `cp -a "${s}" "${d}"` },
];

// Every installed dependency tree the primary checkout has, in the same relative
// place inside `dir`. Returns what it did, for the journal — the cost is real (a
// `copy` rung is hundreds of megabytes per in-flight ticket) and a cost nobody can
// see is a cost nobody can bound. It is announced on the way in as well as out,
// because on the slow path this is the seconds between a ticket going in-flight
// and its worker starting, and an operator watching an idle-looking dispatch
// deserves to know what it is waiting for.
export async function provision(id: string, dir: string): Promise<string> {
  const startedAt = Date.now();
  const roots = await depRoots();
  if (!roots.length) return 'nothing to provision (no ignored dependency tree in the checkout)';

  tui.log(`provisioning ${id}: [${roots.join(', ')}]…`);
  const done: string[] = [];
  for (const rel of roots) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true }); // a workspace tree sits under a package dir
    done.push(`${rel} (${await copyTree(path.resolve(rel), dst)})`);
  }
  const summary = `provisioned ${done.join(', ')} in ${Math.round((Date.now() - startedAt) / 1000)}s`;
  tui.log(`${id}: ${summary}`);
  return summary;
}

// Which trees to bring, asked of git rather than of the filesystem. Two things
// come free that way: a workspace's per-package trees are found without walking
// (git already collapses each ignored directory to one entry), and everything
// returned is ignored — which is what keeps provisioning invisible to verify's
// dirty-tree refusal. An untracked tree that is NOT ignored is deliberately not
// copied: kickoff refuses to start over one, so it cannot exist in a campaign.
async function depRoots(): Promise<string[]> {
  const listed = (await shAsync('git ls-files --others --ignored --directory --exclude-standard')).stdout;
  return listed.split('\n')
    .map(l => l.trim().replace(/\/$/, ''))
    .filter(p => p && DEP_ROOTS.has(path.basename(p)));
}

async function copyTree(src: string, dst: string): Promise<string> {
  for (const rung of COPY_RUNGS) {
    if ((await shAsync(rung.cmd(src, dst))).status === 0) return rung.how;
    await shAsync(`rm -rf "${dst}"`); // a rung that failed part-way leaves a partial tree the next one would refuse
  }
  // Nothing left to try, and a worktree missing its dependencies fails every
  // check for a reason the ticket has no way to fix — so this stops the dispatch
  // instead of handing a worker a checkout that cannot run.
  throw new Error(`provision: every copy strategy failed for ${src} → ${dst}`);
}
