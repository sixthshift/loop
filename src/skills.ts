// `loop skills install` — putting the two authoring/driving skills where the
// agent CLIs look for them.
//
// They live in this repository rather than in a dotfiles tree because they are
// clients of this program's contract, not personal preferences: `ailoop` drives a
// campaign entirely through the mechanics verbs, and `aispec` writes specs against
// kickoff's refuse-to-start gate. A renamed verb or a tightened gate rule breaks
// them, so they version and release with the thing that broke them. Skew between
// the CLI and the prose driving it used to be silent; shipping them together is
// what closes that.
//
// Two delivery modes, because the installs differ in kind and the difference is
// load-bearing:
//
//   • From a compiled binary there is no `skills/` directory to point at, so the
//     files are embedded as text imports (the same reason and the same mechanism
//     as the role prompts in campaign/agents/prompt.ts) and written out.
//   • From a source checkout they are symlinked instead. Editing prose has to stay
//     a file edit that is live in the next session — a skill whose text needs a
//     rebuild is no longer the cheap-to-iterate half of this project, which is
//     most of why the model-driven seat exists at all.
//
// Writes land in $HOME, so every ambiguous case refuses rather than surprises. In
// particular a `~/.claude/skills` that is itself a symlink is refused outright: it
// is the dotfiles layout, and writing "into" it would silently commit files to
// somebody's dotfiles repository.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { version } from '../package.json' with { type: 'json' };

import ailoopSkill from '../skills/ailoop/SKILL.md' with { type: 'text' };
import ailoopKickoff from '../skills/ailoop/references/kickoff.md' with { type: 'text' };
import ailoopRecover from '../skills/ailoop/references/recover.md' with { type: 'text' };
import ailoopRetrospective from '../skills/ailoop/references/retrospective.md' with { type: 'text' };
import aispecSkill from '../skills/aispec/SKILL.md' with { type: 'text' };
import aispecTemplate from '../skills/aispec/templates/spec.md' with { type: 'text' };

// Adding a file to a skill adds a line here — deliberately explicit, like the
// prompt registry. A compiled binary can only carry what something imported.
type Skill = {
  name: string;
  files: Record<string, string>; // path relative to the skill dir → contents
  // Codex has no Agent tool, so it cannot spawn the subagents ailoop's every
  // judgment role needs. aispec is pure interrogation and travels fine.
  codex: boolean;
};

const SKILLS: Skill[] = [
  {
    name: 'ailoop',
    codex: false,
    files: {
      'SKILL.md': ailoopSkill,
      'references/kickoff.md': ailoopKickoff,
      'references/recover.md': ailoopRecover,
      'references/retrospective.md': ailoopRetrospective,
    },
  },
  {
    name: 'aispec',
    codex: true,
    files: {
      'SKILL.md': aispecSkill,
      'templates/spec.md': aispecTemplate,
    },
  },
];

// Written into each installed skill so a later run can tell its own output from a
// file somebody edited by hand, and `uninstall` only removes what it put there.
const MARKER = '.loop-skill-version';

// The agent CLIs' skill directories. Claude reads ~/.claude/skills; the Codex-side
// convention this repo's sibling tooling uses is ~/.agents/skills.
const CLAUDE_SKILLS = path.join(os.homedir(), '.claude', 'skills');
const CODEX_SKILLS = path.join(os.homedir(), '.agents', 'skills');

// True when running as a `bun build --compile` binary: its module URLs live in the
// embedded filesystem. update.ts branches on the same fact for the same reason —
// a source install upgrades through git, not by replacing a file.
const fromBinary = (): boolean => import.meta.url.startsWith('file:///$bunfs/');

// Where a source checkout's skills actually sit, for the symlink mode.
const sourceDir = (name: string): string =>
  path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'skills', name);

class SkillsError extends Error {}

export function installSkills(opts: { force: boolean }): void {
  try {
    const linked = !fromBinary();
    console.log(linked
      ? 'loop: source checkout → symlinking (edits stay live)'
      : 'loop: binary install → writing files');

    for (const root of [CLAUDE_SKILLS, CODEX_SKILLS]) assertWritableRoot(root);

    let count = 0;
    for (const skill of SKILLS) {
      install(skill, CLAUDE_SKILLS, linked, opts.force);
      count++;
      if (skill.codex) install(skill, CODEX_SKILLS, linked, opts.force);
    }
    console.log(`loop: ${count} skill(s) installed at ${version}`);
  } catch (e) {
    console.error(`loop: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export function uninstallSkills(): void {
  try {
    let removed = 0;
    for (const root of [CLAUDE_SKILLS, CODEX_SKILLS]) {
      for (const skill of SKILLS) {
        const dest = path.join(root, skill.name);
        if (!ours(dest)) continue;
        fs.rmSync(dest, { recursive: true, force: true });
        console.log(`  removed ${dest}`);
        removed++;
      }
    }
    console.log(removed ? `loop: ${removed} skill(s) removed` : 'loop: nothing installed by loop was found');
  } catch (e) {
    console.error(`loop: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// A symlinked skills root means the directory belongs to another repository (a
// dotfiles checkout is the case this exists for). Writing through it would commit
// files into that repository and show up as an unexplained dirty tree. Refuse and
// name the fix rather than doing something clever.
function assertWritableRoot(root: string): void {
  if (!fs.existsSync(root)) return; // created on demand; nothing to contest
  if (fs.lstatSync(root).isSymbolicLink()) {
    throw new SkillsError(
      `${root} is a symlink to ${fs.readlinkSync(root)} — installing through it would write into that repository.\n`
      + '       Link the skills inside it individually instead, so this directory is a real one, then re-run.');
  }
}

function install(skill: Skill, root: string, linked: boolean, force: boolean): void {
  const dest = path.join(root, skill.name);

  if (fs.existsSync(dest) || isBrokenLink(dest)) {
    if (!ours(dest) && !force) {
      throw new SkillsError(
        `${dest} already exists and was not installed by loop — refusing to overwrite it.\n`
        + '       Move it aside, or re-run with --force if it is a stale copy.');
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.mkdirSync(root, { recursive: true });

  if (linked) {
    fs.symlinkSync(sourceDir(skill.name), dest);
    console.log(`  ${dest} ──▶ ${sourceDir(skill.name)}`);
    return;
  }

  for (const [rel, contents] of Object.entries(skill.files)) {
    const file = path.join(dest, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  fs.writeFileSync(path.join(dest, MARKER), `${version}\n`);
  console.log(`  ${dest} (${Object.keys(skill.files).length} files)`);
}

// Ours if we wrote it (marker present) or if we linked it into this checkout.
// A symlink pointing anywhere else is somebody else's arrangement.
function ours(dest: string): boolean {
  if (isBrokenLink(dest)) return true; // a link we left behind, now dangling
  if (!fs.existsSync(dest)) return false;
  if (fs.lstatSync(dest).isSymbolicLink()) {
    return path.resolve(path.dirname(dest), fs.readlinkSync(dest))
      === sourceDir(path.basename(dest));
  }
  return fs.existsSync(path.join(dest, MARKER));
}

const isBrokenLink = (p: string): boolean => {
  try { return fs.lstatSync(p).isSymbolicLink() && !fs.existsSync(p); }
  catch { return false; }
};
