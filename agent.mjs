// Spawn one Claude agent (`claude -p`) and return its result + telemetry.
// Judgment lives in agents; this module only carries prompts out and
// structured verdicts back. `schema` forces CLI-side JSON validation, so the
// coordinator never parses free text.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tui from './tui.mjs';

const PROMPTS = fileURLToPath(new URL('./prompts/', import.meta.url));

export class AgentError extends Error {
  constructor(message, { transient = false } = {}) {
    super(message);
    this.transient = transient;
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
  const argv = ['-p', prompt, '--output-format', 'json', '--model', model, '--no-session-persistence'];
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
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AgentError(`${label}: timed out after ${Math.round(timeoutMs / 60000)}m`, { transient: true }));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(new AgentError(`${label}: ${e.message}`, { transient: true })); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) return reject(new AgentError(`${label}: exit ${code}: ${err.slice(-2000)}`, { transient: true }));
      try { resolve(JSON.parse(out)); }
      catch { reject(new AgentError(`${label}: unparseable envelope: ${out.slice(-500)}`, { transient: true })); }
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

// One retry on transient failures (timeout, spawn error, garbled envelope) —
// a *judgment* we disagree with is never retried, only a channel failure.
export async function agentRetry(opts) {
  try { return await agent(opts); }
  catch (e) {
    if (!(e instanceof AgentError) || !e.transient) throw e;
    return agent(opts);
  }
}
