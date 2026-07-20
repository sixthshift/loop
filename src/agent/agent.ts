// Run an agent to a verdict, across whichever CLI its model names. This module
// owns everything engine-agnostic — spawning the child, the timeout, feeding
// the fleet, and the preference-ordered fallback across candidate models — and
// delegates the CLI-specific parts (argv, stream schema, where the answer and
// usage live) to the engine (engine.ts). `schema` forces the CLI to validate
// its own output, so the coordinator never parses free text; callers name the
// verdict type the schema guarantees via the generic.
//
// The live process — registry entry, transcript, spend, kill handle — belongs
// to the fleet; this module only feeds it as the child comes and goes.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fleet from './fleet.ts';
import { engineFor, available } from './engine.ts';
import type { EngineEnvelope } from './engine.ts';

const PROMPTS = fileURLToPath(new URL('./prompts/', import.meta.url));

export type AgentOptions = {
  prompt: string;
  models: string[];            // preference order; first installed engine wins, next on transient failure
  schema?: object;
  cwd?: string;
  tools?: string;              // e.g. 'Read,Glob,Grep' — omit for the full set
  bypassPermissions?: boolean;
  timeoutMs?: number;
  label?: string;
};

export type AgentResult<T> = { output: T; model: string; tokens: number; seconds: number; costUsd: number };

export class AgentError extends Error {
  transient: boolean;
  killed: boolean; // operator intent — never auto-retried
  constructor(message: string, { transient = false, killed = false }: { transient?: boolean; killed?: boolean } = {}) {
    super(message);
    this.transient = transient;
    this.killed = killed;
  }
}

// {{key}} substitution; objects render as pretty JSON. A missing key is a
// programming error, not a prompt to silently ship with a hole in it.
export function renderPrompt(name: string, vars: Record<string, unknown> = {}): string {
  let text = fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8');
  text = text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`prompt ${name}: missing var ${key}`);
    const v = vars[key];
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  });
  return text;
}

// Walk the candidate chain: skip models whose engine isn't installed, then try
// the rest in order. A transient failure (spawn, timeout, garbled stream, an
// unauthed CLI, unparseable schema output) falls through to the next candidate;
// an operator kill or a real error reply is intent, not a channel flake, and
// stops the chain. A lone surviving candidate is retried once, so single-engine
// resilience matches the retry this replaced.
export async function agent<T = string>(opts: AgentOptions): Promise<AgentResult<T>> {
  const label = opts.label ?? 'agent';
  const chain = opts.models.filter(available);
  if (!chain.length) throw new AgentError(`${label}: no engine installed for [${opts.models.join(', ')}]`);
  const attempts = chain.length === 1 ? [chain[0]!, chain[0]!] : chain;

  let last: unknown;
  for (const model of attempts) {
    try { return await runOnce<T>(model, opts); }
    catch (e) {
      if (e instanceof AgentError && (e.killed || !e.transient)) throw e;
      last = e;
    }
  }
  throw last;
}

async function runOnce<T>(model: string, opts: AgentOptions): Promise<AgentResult<T>> {
  const { prompt, schema, cwd = '.', tools, bypassPermissions = false, timeoutMs = 60 * 60 * 1000, label = 'agent' } = opts;
  const { engine, cliModel } = engineFor(model);
  const { argv, cleanup } = engine.buildArgv({ prompt, model: cliModel, cwd, schema, tools, bypassPermissions });
  const reader = engine.reader();
  const startedAt = Date.now();

  const envelope = await new Promise<EngineEnvelope>((resolve, reject) => {
    const child = spawn(engine.bin, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '', killed = false;
    // The child is live from here — the fleet owns it (transcript, pid, spend,
    // kill handle) until close/error removes it. The full prefixed model is the
    // display name, so the dashboard shows which engine is running.
    fleet.register(label, { model, pid: child.pid, kill: () => { killed = true; child.kill('SIGKILL'); } });
    const sink = { event: (l: string) => fleet.event(label, l), delta: (t: string, th: boolean) => fleet.delta(label, t, th) };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AgentError(`${label}: timed out after ${Math.round(timeoutMs / 60000)}m`, { transient: true }));
    }, timeoutMs);

    child.stdout.on('data', d => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? ''; // keep the partial tail
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; } // never die on a garbled event
        reader.handle(ev, sink);
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); cleanup?.(); fleet.remove(label); reject(new AgentError(`${label}: ${e.message}`, { transient: true })); });
    child.on('close', code => {
      clearTimeout(timer);
      cleanup?.();
      const env = reader.finalize();
      // Tally spend only when a result actually landed; a kill or a resultless
      // exit removes the agent with none.
      fleet.remove(label, env ? { tokens: env.tokens, costUsd: env.costUsd } : undefined);
      if (killed) return reject(new AgentError(`${label}: killed by operator`, { killed: true }));
      if (env) return resolve(env);
      reject(new AgentError(`${label}: exit ${code} with no result: ${err.slice(-2000)}`, { transient: true }));
    });
  });

  if (envelope.isError) throw new AgentError(`${label}: ${String(envelope.errorText).slice(0, 2000)}`, { transient: Boolean(envelope.errorTransient) });
  const output = (schema
    ? (envelope.structured ?? JSON.parse(envelope.text))
    : envelope.text) as T;
  return {
    output,
    model,
    tokens: envelope.tokens,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    costUsd: envelope.costUsd,
  };
}
