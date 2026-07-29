// Campaign-agent integration. The generic runtime owns process execution and
// emits lifecycle facts; this module gives those facts their campaign meaning:
// durable audit entries and operator-visible narration. Campaign prompts live
// here for the same dependency reason — the runtime knows consensus mechanics,
// never which roles this product happens to run.

import { agent as runAgent } from '../../agent/agent.ts';
import type { AgentEvent, AgentOptions, AgentResult } from '../../agent/agent.ts';
import { appendJournal } from '../journal.ts';
import * as tui from '../../runtime/reporting.ts';

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

export async function agent<T = string>(opts: AgentOptions): Promise<AgentResult<T>> {
  return runAgent<T>({ ...opts, report: reportCampaignAgent });
}

// The template as authored, placeholders intact. The other coordinator seat
// reads these through `loop prompt <role>` (mechanics.ts): the prompts ARE the
// judgment layer, so sharing them is what keeps a seat comparison about the seat
// rather than about who wrote a better rubric.
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

function reportCampaignAgent(event: AgentEvent): void {
  // The journal is audit-only: losing it must never change the agent runtime's
  // fallback decision. The generic runtime already isolates reporter failure;
  // this catch keeps the intended boundary explicit here too.
  try {
    appendJournal({ kind: event.kind, subject: event.subject, body: event.body });
  } catch { /* no campaign yet, or audit sink unavailable */ }
  tui.log(event.message);
}

export { AgentError } from '../../agent/agent.ts';
export type { AgentOptions, AgentResult } from '../../agent/agent.ts';
