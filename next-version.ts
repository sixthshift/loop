#!/usr/bin/env bun
// Decide the next release version from the commits since the last release tag.
// Prints the bare version (`0.2.0`) to stdout, or nothing at all when the range
// holds no releasable commit — the release workflow reads silence as "skip".
//
// The last tag, not package.json, is the reference point for what is already
// released: a hand-edited package.json then can't skip or replay a version. The
// exception is the first release, which has no tag to count from and so ships
// the version package.json declares.

import { $ } from 'bun';
import { version as declared } from './package.json' with { type: 'json' };

type Bump = 'major' | 'minor' | 'patch';

const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?(!)?:/;

// Types that describe work on the repo rather than a change to the shipped tool.
// A release whose only content is a typo fix wastes a version and a 300 MB
// upload, so these earn no version of their own — they ride the next real one.
const UNRELEASABLE = new Set(['docs', 'test', 'chore', 'style', 'ci', 'build']);

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

// One commit message (subject plus body) → the bump it earns, or null.
// An unconventional subject counts as a patch: it still changed the tool, and
// shipping a change unversioned is worse than shipping it undersized.
export function bumpFor(message: string): Bump | null {
  const subject = message.split('\n', 1)[0] ?? '';
  const parsed = CONVENTIONAL.exec(subject);
  if (parsed?.[2] || /^BREAKING[ -]CHANGE:/m.test(message)) return 'major';
  if (!parsed) return 'patch';
  const type = parsed[1]!.toLowerCase();
  if (UNRELEASABLE.has(type)) return null;
  return type === 'feat' ? 'minor' : 'patch';
}

export function strongestBump(messages: string[]): Bump | null {
  let strongest: Bump | null = null;
  for (const m of messages) {
    const bump = bumpFor(m);
    if (bump && (!strongest || RANK[bump] > RANK[strongest])) strongest = bump;
  }
  return strongest;
}

// Pre-1.0, a breaking change is a minor bump. 0.x is the range that advertises an
// unsettled shape, so spending 1.0.0 on the first renamed verb would claim a
// stability the tool hasn't earned.
export function applyBump(current: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] = current.split('.').map(Number);
  if (bump === 'major') return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

if (import.meta.main) {
  // Interpolated, not written literally into the template: Bun's shell treats a
  // bare `v[0-9]*` as a filename glob and fails the command when nothing matches.
  const TAG_GLOB = 'v[0-9]*';
  const lastTag = (await $`git describe --tags --abbrev=0 --match ${TAG_GLOB}`.nothrow().quiet()).stdout.toString().trim();
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  // \x1e between messages: a commit body contains blank lines and its own
  // newlines, so nothing shorter separates two of them unambiguously.
  const log = await $`git log ${range} --format=%B%x1e`.quiet().text();
  const messages = log.split('\x1e').map(m => m.trim()).filter(Boolean);

  const bump = strongestBump(messages);
  if (!bump) process.exit(0);
  console.log(lastTag ? applyBump(lastTag.replace(/^v/, ''), bump) : declared);
}
