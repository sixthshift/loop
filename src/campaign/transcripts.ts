// Subagent-transcript archaeology for the post-mortem's time breakdown.
//
// The journal knows a ticket's phase walls; only the worker's own transcript
// knows what the wall was spent ON — model inference vs test suites vs waiting
// on a tier log. Claude Code retains every spawned agent's transcript under
// ~/.claude/projects/<cwd-slug>/<session>/subagents/, so the split is
// recoverable mechanically, with zero model cost. This module is the perimeter
// against that foreign format: everything here re-verifies shape at read time
// and returns null over throwing, because a missing or half-written transcript
// must degrade the report's detail, never kill the archive.
//
// Traps this parser exists to get right (each learned from real data):
//   • One API turn is persisted as SEVERAL assistant lines (thinking, text,
//     tool_use) sharing one message.id, and usage.output_tokens on each line is
//     a streaming snapshot that GROWS within the turn. Tokens are the max per
//     message id, summed over unique ids — summing lines double-counts.
//   • Thinking blocks persist with their text stripped (signature only), so
//     thinking spend is estimable only as billed-minus-visible, and the report
//     must label it an estimate.
//   • Workers launch full tier runs detached and then block on grep-the-log
//     loops; those waits ARE test time and are attributed to the tier whose
//     log they poll, not to "misc bash".
//   • Parallel tool calls overlap, so model time is wall minus the UNION of
//     tool spans, never wall minus their sum.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The buckets the report stacks. `wait` never survives to the output — a
// tier-wait is reassigned to its tier by classifyCommand; the value exists so
// the classifier can name what it detected before attribution.
export const TOOL_CLASSES = ['e2e', 'integration', 'unit', 'typecheck', 'db', 'git', 'misc'] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

export type TranscriptAnalysis = {
  file: string;
  firstTs: string;
  lastTs: string;
  wallMs: number;
  // Per-class sums of individual span durations. Overlapping spans in
  // different classes each keep their full duration here (rare in a serial
  // worker); the union below is what protects modelMs from the overlap.
  toolMs: Record<ToolClass, number>;
  // Every closed Bash span individually, for medians ("one e2e spec costs
  // ~28s") — a sum can't answer what a single run costs.
  toolRuns: Array<{ cls: ToolClass; ms: number }>;
  toolUnionMs: number;
  modelMs: number; // wall − union: time the transcript can only attribute to inference
  outputTokens: number;
  turns: number;
  chars: { text: number; code: number; command: number };
  // Billed output minus visible characters at ~3.7 chars/token. An estimate by
  // construction (the thinking text is stripped from saved transcripts) and
  // rendered as one.
  thinkingTokensEst: number;
};

const CHARS_PER_TOKEN = 3.7;

// Suite vocabulary. Generic across the projects this loop builds (bun/vitest/
// playwright households); anything unmatched lands in `misc`, which the report
// discloses as a residue instead of attributing.
const CLASS_PATTERNS: Array<[ToolClass, RegExp]> = [
  ['e2e', /playwright|test:e2e|\.e2e\b|e2e[:./-]/i],
  ['integration', /\bitest\b|integration/i],
  ['unit', /vitest|bun (?:run )?test\b|test:unit|\bjest\b/i],
  ['typecheck', /typecheck|\btsc\b|biome|eslint|\blint\b|bun run check/i],
  ['db', /db:(?:reset|seed|migrate)|supabase|prisma/i],
  ['git', /(?:^|[;&|]\s*)git\s+\w/],
];

// A detached tier run leaves a Bash span that is just a poll loop; the command
// text names the log, and the log names the tier. The shape requires loop or
// sleep context — a bare `grep -q` is a sub-second code search, and counting
// one as a tier run would drag the tier's single-run median toward zero.
const WAIT_SHAPE = /until\s+grep|tail\s+(?:-f|--follow)|sleep\s+\d+[^&|;]*[;&|]+[^;]*grep|;\s*do\s+sleep/i;

// Pure search/read commands never run a suite, however suite-like the paths
// they touch look (`grep -q login tests/e2e/auth.spec.ts` is browsing, not e2e).
const SEARCH_SHAPE = /^\s*(?:grep|rg|find|cat|head|ls)\b/;

export function classifyCommand(command: string, description: string): ToolClass {
  const haystack = `${command}\n${description}`;
  if (WAIT_SHAPE.test(command) || /^wait/i.test(description)) {
    for (const [cls, re] of CLASS_PATTERNS) if (cls !== 'git' && re.test(haystack)) return cls;
    return 'misc';
  }
  if (SEARCH_SHAPE.test(command)) return 'misc';
  for (const [cls, re] of CLASS_PATTERNS) if (re.test(command)) return cls;
  return 'misc';
}

type Line = { type?: string; timestamp?: string; message?: any };

const parseLines = (file: string): Line[] => {
  const out: Line[] = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw);
      if (line && typeof line === 'object') out.push(line);
    } catch { /* a torn tail line loses one event, not the transcript */ }
  }
  return out;
};

const unionMs = (spans: Array<{ start: number; end: number }>): number => {
  const sorted = spans.filter(s => s.end > s.start).sort((a, z) => a.start - z.start);
  let total = 0, cursor = -Infinity;
  for (const s of sorted) {
    if (s.start > cursor) { total += s.end - s.start; cursor = s.end; }
    else if (s.end > cursor) { total += s.end - cursor; cursor = s.end; }
  }
  return total;
};

export function analyzeTranscript(file: string): TranscriptAnalysis | null {
  let lines: Line[];
  try { lines = parseLines(file); } catch { return null; }

  const stamped = lines.filter(l => typeof l.timestamp === 'string'
    && (l.type === 'assistant' || l.type === 'user'));
  if (stamped.length < 2) return null;

  const firstTs = stamped[0]!.timestamp!;
  const lastTs = stamped.at(-1)!.timestamp!;
  const lastMs = new Date(lastTs).getTime();

  const toolMs = Object.fromEntries(TOOL_CLASSES.map(c => [c, 0])) as Record<ToolClass, number>;
  const spans: Array<{ start: number; end: number; cls: ToolClass }> = [];
  const openByToolId = new Map<string, { start: number; cls: ToolClass }>();
  const tokensByMsg = new Map<string, number>();
  const chars = { text: 0, code: 0, command: 0 };

  for (const line of stamped) {
    const msg = line.message;
    const at = new Date(line.timestamp!).getTime();
    if (!msg || !Array.isArray(msg.content)) continue;

    if (line.type === 'assistant') {
      if (typeof msg.id === 'string') {
        const out = msg.usage?.output_tokens;
        if (typeof out === 'number')
          tokensByMsg.set(msg.id, Math.max(tokensByMsg.get(msg.id) ?? 0, out));
      }
      for (const block of msg.content) {
        if (block?.type === 'text' && typeof block.text === 'string') chars.text += block.text.length;
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const input = block.input ?? {};
        let cls: ToolClass = 'misc';
        if (block.name === 'Bash' && typeof input.command === 'string') {
          chars.command += input.command.length;
          cls = classifyCommand(input.command, typeof input.description === 'string' ? input.description : '');
        } else {
          // old_string included: the model emits an Edit's matched text as
          // billed output too, and dropping it would misattribute every
          // edit's anchor to "thinking".
          for (const v of [input.new_string, input.old_string, input.content]) if (typeof v === 'string') chars.code += v.length;
        }
        openByToolId.set(block.id, { start: at, cls });
      }
    }

    if (line.type === 'user') {
      for (const block of msg.content) {
        if (block?.type !== 'tool_result') continue;
        const open = openByToolId.get(block.tool_use_id);
        if (!open) continue;
        openByToolId.delete(block.tool_use_id);
        spans.push({ start: open.start, end: at, cls: open.cls });
        toolMs[open.cls] += Math.max(0, at - open.start);
      }
    }
  }

  // A tool_use with no result was cut off by the session's end — it ran until
  // then as far as this transcript can testify.
  for (const open of openByToolId.values()) {
    spans.push({ start: open.start, end: lastMs, cls: open.cls });
    toolMs[open.cls] += Math.max(0, lastMs - open.start);
  }

  const wallMs = lastMs - new Date(firstTs).getTime();
  const toolUnionMs = Math.min(wallMs, unionMs(spans));
  const outputTokens = [...tokensByMsg.values()].reduce((s, v) => s + v, 0);
  const visibleChars = chars.text + chars.code + chars.command;

  return {
    file, firstTs, lastTs, wallMs, toolMs,
    toolRuns: spans.map(s => ({ cls: s.cls, ms: Math.max(0, s.end - s.start) })),
    toolUnionMs,
    modelMs: wallMs - toolUnionMs,
    outputTokens,
    turns: tokensByMsg.size,
    chars,
    thinkingTokensEst: Math.max(0, Math.round(outputTokens - visibleChars / CHARS_PER_TOKEN)),
  };
}

// ---- discovery -------------------------------------------------------------
// Two joins, tried in order per agent file:
//   1. by journaled id — the coordinator records each settle's worker/judge
//      subagent ids in --data, and agent-<id>.jsonl is then a lookup;
//   2. by the dispatch labels the skill standardizes ("Build T012 (worker)" /
//      "Review T012 (judge)") in agent-*.meta.json, gated by a time-window
//      check against the ticket's journal span so a like-named agent from
//      another campaign in the same repo can never claim the ticket.

export type AgentRole = 'worker' | 'judge';
export type DiscoveredAgent = { ticket: string; role: AgentRole; file: string; via: 'journal-id' | 'label' };

export type TicketWindow = { ticket: string; startMs: number; endMs: number; agentIds: Partial<Record<AgentRole, string[]>> };

// The dispatch label is model prose, not a protocol. SKILL.md asks for
// `Build <id> (worker)` / `Review <id> (judge)` and calls the label
// load-bearing; real campaigns still produced `Worker T001 bundle upload
// perimeter`, `Adversarial review T013`, `Second review T007 after amendment`
// and `Build ticket T012 retry`. An anchored `^build`/`^review` match found
// the judges and missed nearly every worker, so the whole section reported
// zero coverage on a campaign whose transcripts were all present.
//
// So the label is read as a perimeter: find the ticket, then decide the seat
// from the vocabulary present. Anything matching neither seat — recover,
// sweep, decompose, critic, a scout — is DROPPED rather than guessed at, and
// the time-window gate in discoverAgents stays the thing that actually
// prevents a wrong join. Judge is tested first because a review's description
// routinely names what it reviewed (`Review T007 rebuild`), while a worker's
// never claims to review.
const TICKET_IN_LABEL = /\bT\d+\b/i;
const JUDGE_WORDS = /\b(?:review|judge|adversarial)\b/i;
const WORKER_WORDS = /\b(?:build|rebuild|worker|repair|implement|fix)\b/i;

export function classifyLabel(description: string): { ticket: string; role: AgentRole } | null {
  const ticket = TICKET_IN_LABEL.exec(description)?.[0];
  if (!ticket) return null;
  const role: AgentRole | null = JUDGE_WORDS.test(description) ? 'judge'
    : WORKER_WORDS.test(description) ? 'worker'
      : null;
  return role ? { ticket: ticket.toUpperCase(), role } : null;
}

export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9-]/g, '-');

// The window check tolerates the coordinator's bookkeeping between spawn and
// journal write on either side.
const WINDOW_SLACK_MS = 5 * 60_000;

export function discoverAgents(
  windows: TicketWindow[],
  projectsRoot = path.join(os.homedir(), '.claude', 'projects', projectSlug(process.cwd())),
): DiscoveredAgent[] {
  let sessions: string[];
  try {
    sessions = fs.readdirSync(projectsRoot)
      .map(d => path.join(projectsRoot, d, 'subagents'))
      .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  } catch { return []; }

  // A ticket:role may legitimately resolve to SEVERAL files — one per attempt
  // (retries respawn the worker, re-reviews respawn the judge) — and the
  // report sums them, because every attempt was paid for. No dedupe here; the
  // per-file loop already prevents the same file joining twice.
  const found: DiscoveredAgent[] = [];

  const byId = new Map<string, { ticket: string; role: AgentRole }>();
  for (const w of windows) for (const role of ['worker', 'judge'] as const)
    for (const id of w.agentIds[role] ?? []) byId.set(id, { ticket: w.ticket, role });

  for (const dir of sessions) {
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const idMatch = /^agent-([A-Za-z0-9]+)\.jsonl$/.exec(f);
      if (!idMatch) continue;
      const file = path.join(dir, f);
      const journaled = byId.get(idMatch[1]!);
      if (journaled) {
        found.push({ ...journaled, file, via: 'journal-id' });
        continue;
      }
      // label fallback: meta description + time-window gate
      let meta: any;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${idMatch[1]}.meta.json`), 'utf8')); } catch { continue; }
      if (meta?.parentAgentId || (typeof meta?.spawnDepth === 'number' && meta.spawnDepth > 1)) continue; // a scout's time is inside its parent's
      const seat = classifyLabel(typeof meta?.description === 'string' ? meta.description : '');
      if (!seat) continue;
      const { ticket, role } = seat;
      const window = windows.find(w => w.ticket === ticket);
      if (!window) continue;
      const head = firstTimestamp(file);
      if (head === null) continue;
      if (head < window.startMs - WINDOW_SLACK_MS || head > window.endMs + WINDOW_SLACK_MS) continue;
      found.push({ ticket, role, file, via: 'label' });
    }
  }
  return found;
}

// First stamped line only — the window gate must not pay a full parse for
// every agent file in every session the repo has ever hosted.
function firstTimestamp(file: string): number | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const raw of buf.toString('utf8', 0, n).split('\n')) {
        try {
          const ts = JSON.parse(raw)?.timestamp;
          if (typeof ts === 'string') return new Date(ts).getTime();
        } catch { /* keep scanning: the first line may be torn by the 64k cut */ }
      }
      return null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
