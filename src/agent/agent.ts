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
import { log } from '../tui/tui.ts';
import { appendJournal } from '../campaign/journal.ts';
import { engineFor, available } from './engine.ts';
import type { EngineEnvelope } from './engine.ts';

const PROMPTS = fileURLToPath(new URL('./prompts/', import.meta.url));

export type AgentOptions = {
  prompt: string;
  models: (string | string[])[]; // preference order; first installed engine wins, next on transient
                                 // failure. A string[] element is a consensus group: its members
                                 // draft in parallel, then one reconciles them into a single output.
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

// The display name of a candidate: a bare model, or the members of a consensus
// group so a fallback line reads `consensus[a+b]` rather than `[object Object]`.
const candidateName = (c: string | string[]): string => Array.isArray(c) ? `consensus[${c.join('+')}]` : c;

// Walk the candidate chain: skip candidates whose engine isn't installed (a
// group needs at least one installed member), then try the rest in order. A
// transient failure (spawn, timeout, garbled stream, an unauthed CLI,
// unparseable schema output) falls through to the next candidate; an operator
// kill or a real error reply is intent, not a channel flake, and stops the
// chain. A lone surviving *leaf* is retried once, so single-engine resilience
// matches the retry this replaced — a lone group isn't duplicated, it already
// carries its own internal resilience (see runConsensus).
export async function agent<T = string>(opts: AgentOptions): Promise<AgentResult<T>> {
  const label = opts.label ?? 'agent';
  const usable = opts.models.filter(c => Array.isArray(c) ? c.some(available) : available(c));
  if (!usable.length) throw new AgentError(`${label}: no engine installed for [${opts.models.map(candidateName).join(', ')}]`);
  const attempts = usable.length === 1 && !Array.isArray(usable[0]) ? [usable[0]!, usable[0]!] : usable;

  let last: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const cand = attempts[i]!;
    try { return Array.isArray(cand) ? await runConsensus<T>(cand, opts) : await runOnce<T>(cand, opts); }
    catch (e) {
      if (e instanceof AgentError && (e.killed || !e.transient)) throw e;
      last = e;
      // A transient fall-through is never silent — and never undiagnosable. A
      // worker quietly demoted from its preferred engine to the fallback costs
      // more and can collapse the author≠judge engine split, so the swap goes on
      // the record; and the FULL error (the failed CLI's stderr) is journaled,
      // because a fallback opus then recovers would otherwise vanish with nothing
      // to grep the next time the same engine flakes.
      const full = (e as Error).message ?? String(e);
      const from = candidateName(cand);
      const next = attempts[i + 1];
      const move = !next ? `${from} failed, no fallback left`
        : next === cand ? `${from} failed → retrying`
          : `${from} failed → falling back to ${candidateName(next)}`;
      try { appendJournal({ kind: 'engine-fallback', subject: label, body: `${move}: ${full}` }); }
      catch { /* outside a campaign (no journal) — the tui line still surfaces it */ }
      log(`⚠ ${label}: ${move} (${full.slice(0, 200)})`);
    }
  }
  throw last;
}

// A consensus group: draft with every installed member in parallel, then have
// one fresh call reconcile the drafts into a single output. This buys diversity
// (different engines approach the task differently) without a vote — the merge
// keeps the best of each. It only makes sense where the schema output IS the
// artifact (a backlog, a gap list); a role whose product is a side effect (a
// worker's diff in a worktree) can't be reconciled from serialized JSON.
//
// Each draft is a single-model agent() call, so it retries on its own engine but
// never falls to another — the whole point is that codex stays codex and claude
// stays claude. Degrade-to-survivor: a dead draft just shrinks the pool; only an
// empty pool fails the group (transient, so the outer chain tries the next
// candidate). The reconciler is the first *surviving* member, run fresh over
// anonymized drafts so it can't preferentially defend the one it authored.
async function runConsensus<T>(group: string[], opts: AgentOptions): Promise<AgentResult<T>> {
  const label = opts.label ?? 'agent';
  const members = group.filter(available);
  // Distinct labels: the fleet keys live agents by label, so parallel drafts
  // sharing one label would clobber each other in the registry.
  const settled = await Promise.allSettled(
    members.map((m, i) => agent<T>({ ...opts, models: [m], label: `${label}#${i + 1}` })),
  );
  const drafts = settled
    .filter((s): s is PromiseFulfilledResult<AgentResult<T>> => s.status === 'fulfilled')
    .map(s => s.value);
  if (!drafts.length) throw new AgentError(`${label}: every consensus draft failed`, { transient: true });
  if (drafts.length === 1) return drafts[0]!; // a merge over one draft is a costly identity

  const reconciler = drafts[0]!.model;
  const block = drafts
    .map((d, i) => `### Draft ${i + 1}\n${typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 2)}`)
    .join('\n\n');
  const mergePrompt = renderPrompt('consensus', { base: opts.prompt, drafts: block });

  let merged: AgentResult<T>;
  try {
    merged = await agent<T>({ ...opts, models: [reconciler], prompt: mergePrompt, label: `${label}:merge` });
  } catch (e) {
    // The drafts are valid; only the reconcile failed. Degrade to the primary
    // draft and disclose it rather than lose the role's work to a merge flake.
    const full = (e as Error).message ?? String(e);
    try { appendJournal({ kind: 'consensus', subject: label, body: `merge failed, returning primary draft: ${full}` }); } catch {}
    log(`⚠ ${label}: consensus merge failed → primary draft (${full.slice(0, 200)})`);
    return drafts[0]!;
  }

  try { appendJournal({ kind: 'consensus', subject: label, body: `${drafts.map(d => d.model).join(' + ')} → reconciled by ${reconciler}` }); } catch {}
  return {
    output: merged.output,
    model: `consensus(${drafts.map(d => d.model).join('+')}→${reconciler})`,
    tokens: drafts.reduce((s, d) => s + d.tokens, 0) + merged.tokens,
    // Wall-clock: drafts overlap, the merge follows.
    seconds: Math.max(...drafts.map(d => d.seconds)) + merged.seconds,
    costUsd: drafts.reduce((s, d) => s + d.costUsd, 0) + merged.costUsd,
  };
}

async function runOnce<T>(model: string, opts: AgentOptions): Promise<AgentResult<T>> {
  const { prompt, schema, cwd = '.', tools, bypassPermissions = false, timeoutMs = 60 * 60 * 1000, label = 'agent' } = opts;
  const { engine, cliModel } = engineFor(model);
  // codex joins its `-C` onto its own process cwd, so a *relative* dir handed to
  // both spawn's cwd and the engine's `-C` resolves twice into a nonexistent
  // nested path — a startup ENOENT the fallback chain then silently ate. Both
  // callers pass a relative WORKTREES dir; absolutize once here so every engine
  // gets a real path no matter how the caller expressed it.
  const dir = path.resolve(cwd);
  const { argv, stdin, cleanup, env } = engine.buildArgv({ prompt, model: cliModel, cwd: dir, schema, tools, bypassPermissions });
  const reader = engine.reader();
  const startedAt = Date.now();

  const envelope = await new Promise<EngineEnvelope>((resolve, reject) => {
    const child = spawn(engine.bin, argv, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
    // The prompt rides stdin (never argv — see Engine.buildArgv). Swallow EPIPE:
    // if the child dies before draining stdin, that death surfaces on 'close'
    // with its own diagnosis; a raw stdin error here would just mask it.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
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
