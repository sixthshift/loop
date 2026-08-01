// The role prompts — the judgment layer, and the only part of an agent's work
// this program still owns.
//
// The coordinator spawns its own agents; what it does not do is write their
// prompts. These are the campaign's accumulated instructions for how to review a
// diff, how to sweep a journal, what a recover may and may not touch — the part
// that took the longest to get right and the part a coordinator improvising in
// a conversation would silently drift from. So they are served as text through
// `loop prompt <role>` (mechanics.ts), rendered from one template with the
// caller's variables, and a missing variable is refused rather than shipped as a
// hole in the prompt.

import coverage from './prompts/coverage.md' with { type: 'text' };
import decompose from './prompts/decompose.md' with { type: 'text' };
import harvest from './prompts/harvest.md' with { type: 'text' };
import kickoff from './prompts/kickoff.md' with { type: 'text' };
import recover from './prompts/recover.md' with { type: 'text' };
import review from './prompts/review.md' with { type: 'text' };
import sweep from './prompts/sweep.md' with { type: 'text' };
import worker from './prompts/worker.md' with { type: 'text' };

// Embedded as text because a compiled binary has no prompt directory to read at
// runtime. Adding a campaign role therefore adds one explicit registry entry.
const PROMPTS: Record<string, string> = {
  coverage, decompose, harvest, kickoff, recover, review, sweep, worker,
};

// The template as authored, placeholders intact.
export function rawPrompt(name: string): string {
  const raw = PROMPTS[name];
  if (raw === undefined) throw new Error(`unknown campaign prompt: ${name} — roles: ${Object.keys(PROMPTS).sort().join(', ')}`);
  return raw;
}

// {{key}} substitution; objects render as pretty JSON. A missing key is a
// programming error, not a prompt silently shipped with a hole in it.
export function renderPrompt(name: string, vars: Record<string, unknown> = {}): string {
  const raw = rawPrompt(name);
  return raw.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`prompt ${name}: missing var ${key}`);
    const value = vars[key];
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  });
}
