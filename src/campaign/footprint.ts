// What a ticket's declared footprint means. A ticket declares the module it
// lives in — a repo-relative directory — not the files it will touch. A
// decomposer can predict "this ticket lives in src/auth" from the spec alone;
// it cannot predict a file the implementation turns out to need, and under a
// file list that unforeseen file was charged to the ticket as a scope
// violation — the ticket paying for the decomposer's forecast error. Leaving
// the declared module is a real violation worth charging; a new file inside it
// is not.
//
// Both readers of the footprint compute containment here. The scheduler asks
// whether two tickets may run in parallel — disjointness is an optimization
// against merge rework, not a safety invariant (the post-merge integration
// check is what catches two disjoint tickets breaking each other), and
// directory-disjointness serves it as well as file-disjointness did, still
// statically and still deadlock-free. Verify asks whether the committed diff
// stayed inside the module.

import fs from 'node:fs';
import path from 'node:path';

// The whole repository. A ticket that declares it collides with every other
// ticket — honest, since that is the footprint it asked for.
export const ROOT = '';

// Manifest/lockfiles sit outside every module: many tickets legitimately touch
// one, so a diff into it is never a scope overflow. Concurrent manifest edits
// are serialized by the `dependency-manifest` resource lock, not by footprint.
const MANIFESTS = new Set(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']);
export const isManifest = (file: string): boolean => MANIFESTS.has(path.posix.basename(file));

// `./src/auth/`, `/src/auth` and `src/auth` are one module; `.` and `/` are the
// repository root. A `..` survives normalization so validation can reject it.
export function normalizeModule(m: string): string {
  const trimmed = m.trim().replace(/^\.?\/+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return trimmed === '.' ? ROOT : trimmed;
}

export function isInside(file: string, module: string): boolean {
  if (module === ROOT) return true;
  return file === module || file.startsWith(`${module}/`);
}

// Two modules can host the same file exactly when one contains the other.
export const modulesCollide = (a: string, b: string): boolean => isInside(a, b) || isInside(b, a);

// The perimeter against the shape this replaced: an agent that answers
// `src/auth/service.ts` is declaring a file, and a file-shaped module would
// contain nothing the worker writes beside it. Refuse it at the sole writer
// rather than let verify fail the diff for it three attempts later.
export function moduleErrors(modules: unknown): string[] {
  if (!Array.isArray(modules) || modules.length === 0)
    return ['modules must be a NON-EMPTY array of repo-relative directories, e.g. ["src/auth"] (unknown footprint is unbatchable and unverifiable)'];
  const errs: string[] = [];
  for (const raw of modules) {
    if (typeof raw !== 'string' || !raw.trim()) {
      errs.push(`module entries are non-empty strings: ${JSON.stringify(raw)}`);
      continue;
    }
    const m = normalizeModule(raw);
    if (m.split('/').includes('..')) errs.push(`module escapes the repository: ${raw}`);
    else if (isFilePath(m)) errs.push(`module "${raw}" names a file — declare the directory the work lives in, e.g. "${path.posix.dirname(m) || '.'}"`);
  }
  return errs;
}

// Disk decides when the path already exists; for a module that doesn't exist
// yet, a basename carrying an extension is the tell.
function isFilePath(m: string): boolean {
  if (m === ROOT) return false;
  const st = statOrNull(m);
  return st ? !st.isDirectory() : /[^/.]\.[^/.]+$/.test(m);
}

function statOrNull(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}
