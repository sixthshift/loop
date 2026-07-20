// Spawn one Claude agent (`claude -p`) and return its result + telemetry.
// Judgment lives in agents; this module only carries prompts out and
// structured verdicts back. `schema` forces CLI-side JSON validation, so the
// coordinator never parses free text.
//
// Output rides stream-json (NDJSON events, final `result` event = the same
// envelope the old json format returned) so the dashboard can tail what an
// agent is doing while it runs, instead of staring at a black box.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tui from './tui.mjs';
import { registerKill, unregisterKill } from './control.mjs';

const PROMPTS = fileURLToPath(new URL('./prompts/', import.meta.url));

export class AgentError extends Error {
  constructor(message, { transient = false, killed = false } = {}) {
    super(message);
    this.transient = transient;
    this.killed = killed; // operator intent — never auto-retried
  }
}

// {{key}} substitution; objects render as pretty JSON. A missing key is a
// programming error, not a prompt to silently ship with a hole in it.
export function renderPrompt(name, vars = {}) {
  let text = fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8');
  text = text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`prompt ${name}: missing var ${key}`);
    const v = vars[key];
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  });
  return text;
}

export async function agent({
  prompt, model = 'opus', schema, cwd = '.',
  tools,                    // e.g. 'Read,Glob,Grep' — omit for the full set
  bypassPermissions = false,
  timeoutMs = 60 * 60 * 1000,
  label = 'agent',
}) {
  const argv = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model, '--no-session-persistence'];
  if (schema) argv.push('--json-schema', JSON.stringify(schema));
  if (tools !== undefined) argv.push('--tools', tools);
  if (bypassPermissions) argv.push('--dangerously-skip-permissions');

  // The one seam every agent passes through — the TUI's live pane and spend
  // tally hook here, so no caller carries display concerns.
  tui.agentStart(label, model);
  try {
    const result = await runAgent({ argv, cwd, schema, timeoutMs, label });
    tui.agentEnd(label, result);
    return result;
  } catch (e) {
    tui.agentEnd(label, {});
    throw e;
  }
}

async function runAgent({ argv, cwd, schema, timeoutMs, label }) {
  const envelope = await new Promise((resolve, reject) => {
    const child = spawn('claude', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '', result = null, killed = false;
    registerKill(label, () => { killed = true; child.kill('SIGKILL'); });
    tui.agentPid(label, child.pid);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AgentError(`${label}: timed out after ${Math.round(timeoutMs / 60000)}m`, { transient: true }));
    }, timeoutMs);

    child.stdout.on('data', d => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop(); // keep the partial tail
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; } // never die on a garbled event
        if (ev.type === 'result') result = ev;
        if (ev.type === 'stream_event') {
          const d = ev.event?.delta;
          if (d?.type === 'text_delta') tui.agentDelta(label, d.text, false);
          else if (d?.type === 'thinking_delta') tui.agentDelta(label, d.thinking, true);
          continue;
        }
        for (const t of transcript(ev)) tui.agentEvent(label, t);
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); unregisterKill(label); reject(new AgentError(`${label}: ${e.message}`, { transient: true })); });
    child.on('close', code => {
      clearTimeout(timer);
      unregisterKill(label);
      if (killed) return reject(new AgentError(`${label}: killed by operator`, { killed: true }));
      if (result) return resolve(result);
      reject(new AgentError(`${label}: exit ${code} with no result event: ${err.slice(-2000)}`, { transient: true }));
    });
  });

  if (envelope.is_error) throw new AgentError(`${label}: ${String(envelope.result).slice(0, 2000)}`);
  const output = schema
    ? (envelope.structured_output ?? JSON.parse(envelope.result))
    : envelope.result;
  return {
    output,
    tokens: envelope.usage?.output_tokens ?? 0,
    seconds: Math.round((envelope.duration_ms ?? 0) / 1000),
    costUsd: envelope.total_cost_usd ?? 0,
  };
}

// Stream event → human lines for the live tail pane. Lossy on purpose:
// enough to answer "what is this agent doing", not a session replay.
function transcript(ev) {
  if (ev.type === 'system' && ev.subtype === 'init') return ['· session started'];
  if (ev.type !== 'assistant' && ev.type !== 'user') return [];
  const out = [];
  for (const c of ev.message?.content ?? []) {
    if (c.type === 'text' && c.text?.trim()) out.push(oneLine(c.text));
    if (c.type === 'tool_use') out.push(`→ ${c.name} ${oneLine(JSON.stringify(c.input ?? {}))}`);
    if (c.type === 'tool_result') {
      const body = typeof c.content === 'string' ? c.content
        : (c.content ?? []).map(b => b.text ?? '').join(' ');
      out.push(`←${c.is_error ? ' ✗' : ''} ${oneLine(body) || '(empty)'}`);
    }
  }
  return out;
}

const oneLine = s => String(s).replace(/\s+/g, ' ').trim().slice(0, 300);

// One retry on transient failures (timeout, spawn error, garbled envelope) —
// a *judgment* we disagree with is never retried, and neither is an
// operator kill: that rejection is intent, not noise.
export async function agentRetry(opts) {
  try { return await agent(opts); }
  catch (e) {
    if (!(e instanceof AgentError) || !e.transient) throw e;
    return agent(opts);
  }
}
