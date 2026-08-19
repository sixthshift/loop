// The transcript parser is a perimeter against a format this program does not
// own, and each case pins one of its documented traps: streaming usage
// snapshots that repeat a message id, thinking blocks persisted without text,
// tier-wait greps that are really test time, and parallel tool spans whose sum
// exceeds their union. Fixtures are written to a temp dir in the persisted
// line shape (type / message / timestamp), verified against a real transcript.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { analyzeTranscript, classifyCommand, classifyLabel, discoverAgents } from './transcripts.ts';

const T0 = Date.parse('2026-08-10T10:00:00Z');
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

const assistant = (sec: number, id: string, output: number, content: unknown[]) => ({
  type: 'assistant', timestamp: at(sec),
  message: { role: 'assistant', id, usage: { output_tokens: output }, content },
});
const result = (sec: number, toolUseId: string) => ({
  type: 'user', timestamp: at(sec),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
});
const bash = (id: string, command: string, description = '') =>
  ({ type: 'tool_use', id, name: 'Bash', input: { command, description } });

const write = (lines: unknown[]): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-transcript-'));
  const file = path.join(dir, 'agent-abc123.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
};

describe('classifyCommand', () => {
  test.each([
    ['bunx playwright test specs/auth.e2e.ts', '', 'e2e'],
    ['bun run itest:core', 'Run the core integration suite', 'integration'],
    ['bun test src', '', 'unit'],
    ['tsc --noEmit', '', 'typecheck'],
    ['supabase db reset --local', '', 'db'],
    ['git add -A && git commit -m "wip"', '', 'git'],
    ['curl localhost:3000/health', '', 'misc'],
  ] as const)('%s → %s', (cmd, desc, expected) => {
    expect(classifyCommand(cmd, desc)).toBe(expected);
  });

  test('a tier-wait grep is attributed to the tier whose log it polls', () => {
    expect(classifyCommand('until grep -q "EXIT" /tmp/e2e-run.log; do sleep 10; done', 'Wait for tier completion')).toBe('e2e');
    expect(classifyCommand('sleep 30; grep -q DONE /tmp/integration.log', 'Wait for itest tier')).toBe('integration');
  });

  test('a wait with no tier named stays misc rather than guessing', () => {
    expect(classifyCommand('until grep -q up server.log; do sleep 2; done', 'Wait for dev server')).toBe('misc');
  });

  test('a sub-second code-search grep is browsing, not a tier run — whatever its paths mention', () => {
    expect(classifyCommand('grep -q "login" tests/e2e/auth.spec.ts', '')).toBe('misc');
    expect(classifyCommand('rg integration src/', 'Find integration call sites')).toBe('misc');
  });
});

describe('analyzeTranscript', () => {
  test('tokens dedupe by message id (max snapshot), tool spans classify, model time is the remainder', () => {
    const file = write([
      { type: 'user', timestamp: at(0), message: { role: 'user', content: 'build the ticket' } },
      // one API turn persisted as two lines: thinking snapshot then tool_use
      assistant(5, 'm1', 4, [{ type: 'thinking', thinking: '', signature: 'x' }]),
      assistant(6, 'm1', 100, [bash('tu1', 'bun test src')]),
      result(66, 'tu1'),
      assistant(70, 'm2', 50, [{ type: 'text', text: 'a'.repeat(37) }]),
    ]);
    const a = analyzeTranscript(file)!;
    expect(a.turns).toBe(2);
    expect(a.outputTokens).toBe(150); // 100 + 50, never 4 + 100 + 50
    expect(a.wallMs).toBe(70_000);
    expect(a.toolMs.unit).toBe(60_000);
    expect(a.modelMs).toBe(10_000);
    expect(a.chars.text).toBe(37);
    expect(a.chars.command).toBe('bun test src'.length);
    // billed 150 − visible 49 chars at 3.7 chars/token ≈ 13 visible tokens → 137 thinking
    expect(a.thinkingTokensEst).toBe(137);
  });

  test('parallel tool spans subtract as a union, not a sum', () => {
    const file = write([
      assistant(0, 'm1', 10, [bash('tu1', 'bun test src'), bash('tu2', 'tsc --noEmit')]),
      result(30, 'tu1'),
      result(40, 'tu2'),
      assistant(50, 'm2', 10, [{ type: 'text', text: 'done' }]),
    ]);
    const a = analyzeTranscript(file)!;
    expect(a.toolMs.unit).toBe(30_000);
    expect(a.toolMs.typecheck).toBe(40_000);
    expect(a.toolUnionMs).toBe(40_000); // overlapped, not 70s
    expect(a.modelMs).toBe(10_000);
  });

  test('a tool_use the session died on runs to the transcript tail', () => {
    const file = write([
      assistant(0, 'm1', 10, [bash('tu1', 'bunx playwright test')]),
      assistant(120, 'm2', 10, [{ type: 'text', text: 'killed' }]),
    ]);
    expect(analyzeTranscript(file)!.toolMs.e2e).toBe(120_000);
  });

  test('an unreadable or one-line file degrades to null, never throws', () => {
    expect(analyzeTranscript('/nonexistent/agent.jsonl')).toBeNull();
    expect(analyzeTranscript(write([assistant(0, 'm1', 1, [])]))).toBeNull();
  });
});

describe('discoverAgents', () => {
  const scaffold = (agents: Array<{ id: string; meta: object; firstTs: string }>): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-projects-'));
    const sub = path.join(root, 'session-1', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    for (const a of agents) {
      fs.writeFileSync(path.join(sub, `agent-${a.id}.meta.json`), JSON.stringify(a.meta));
      fs.writeFileSync(path.join(sub, `agent-${a.id}.jsonl`),
        JSON.stringify({ type: 'user', timestamp: a.firstTs, message: { role: 'user', content: 'go' } }) + '\n');
    }
    return root;
  };
  const window = { ticket: 'T012', startMs: T0, endMs: T0 + 30 * 60_000 };

  test('a journaled agent id is a direct lookup, no label needed', () => {
    const root = scaffold([{ id: 'deadbeef01', meta: { description: 'anything at all' }, firstTs: at(60) }]);
    expect(discoverAgents([{ ...window, agentIds: { worker: ['deadbeef01'] } }], root))
      .toEqual([{ ticket: 'T012', role: 'worker', file: path.join(root, 'session-1', 'subagents', 'agent-deadbeef01.jsonl'), via: 'journal-id' }]);
  });

  test('label fallback joins by description and is gated by the ticket window', () => {
    const root = scaffold([
      { id: 'aaa1', meta: { description: 'Build T012 (worker)', spawnDepth: 1 }, firstTs: at(60) },
      { id: 'bbb2', meta: { description: 'Review T012 (judge)', spawnDepth: 1 }, firstTs: at(1200) },
      // same label, but from another campaign months earlier: outside the window
      { id: 'ccc3', meta: { description: 'Build T012 (worker)', spawnDepth: 1 }, firstTs: '2026-01-01T00:00:00Z' },
      // a scout inside a worker: its wall is already inside its parent's
      { id: 'ddd4', meta: { description: 'Build T012 (worker)', spawnDepth: 2, parentAgentId: 'aaa1' }, firstTs: at(90) },
    ]);
    const found = discoverAgents([{ ...window, agentIds: {} }], root);
    expect(found.map(f => [path.basename(f.file), f.role, f.via]).sort()).toEqual([
      ['agent-aaa1.jsonl', 'worker', 'label'],
      ['agent-bbb2.jsonl', 'judge', 'label'],
    ]);
  });

  test('a missing projects root returns empty rather than throwing', () => {
    expect(discoverAgents([{ ...window, agentIds: {} }], '/nonexistent/projects')).toEqual([]);
  });
});

// Every label below is one a real campaign actually emitted, read off the
// storyweaver devcontainer's retained transcripts. The anchored `^build` /
// `^review` match this replaced found the judges and missed nearly every
// worker, which is how a campaign with all 471 transcripts on disk reported
// zero coverage and sent its retrospective at the wrong lever.
describe('classifyLabel', () => {
  const cases: Array<[string, { ticket: string; role: string } | null]> = [
    // what SKILL.md actually asks for
    ['Build T012 (worker)', { ticket: 'T012', role: 'worker' }],
    ['Review T012 (judge)', { ticket: 'T012', role: 'judge' }],
    // what the coordinator emitted instead — the whole reason this exists
    ['Worker T001 bundle upload perimeter', { ticket: 'T001', role: 'worker' }],
    ['Worker T012', { ticket: 'T012', role: 'worker' }],
    ['Build ticket T024', { ticket: 'T024', role: 'worker' }],
    ['Build ticket T012 retry', { ticket: 'T012', role: 'worker' }],
    ['Review T003 attempt 2', { ticket: 'T003', role: 'judge' }],
    ['Review ticket T025', { ticket: 'T025', role: 'judge' }],
    ['Adversarial review T013', { ticket: 'T013', role: 'judge' }],
    ['Second review T007 after amendment', { ticket: 'T007', role: 'judge' }],
    ['Rebuild T007 events route', { ticket: 'T007', role: 'worker' }],
    // a judge naming what it reviewed must stay a judge — hence judge-first
    ['Review T007 rebuild', { ticket: 'T007', role: 'judge' }],
    // neither seat: their wall is the coordinator's, never the ticket's
    ['Recover: T012 scope overflow', null],
    ['Recover: T021 fence contradiction', null],
    ['Critic pass T011 wiring', null],
    // no ticket at all
    ['Campaign sweep 2 at 10 closes', null],
    ['Hunt third jsonb-order defect site', null],
    ['', null],
  ];
  for (const [desc, want] of cases)
    test(`${JSON.stringify(desc)} → ${want ? `${want.role} ${want.ticket}` : 'dropped'}`, () => {
      expect(classifyLabel(desc)).toEqual(want as any);
    });
});
