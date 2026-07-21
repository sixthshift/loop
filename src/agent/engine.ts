// The agent engines — one per CLI the loop can drive (claude, codex). Each
// turns our common options into that CLI's argv and its NDJSON stream back into
// our common shape: transcript lines, live deltas, and one terminal envelope.
// agent.ts owns everything shared — spawn, timeout, the fleet, the preference-
// ordered fallback across models; an engine owns only what its CLI makes
// different (flags, event schema, where the final answer and usage live).
//
// A model name carries its engine as a prefix — `claude-opus`,
// `codex-gpt-5.6-terra`. A bare name (`opus`) defaults to claude, so existing
// backlogs and prompts keep working. engineFor() is the one place that parsing
// lives; an unknown prefix fails loud rather than silently picking a CLI.

import { spawnSync } from 'node:child_process';
import { claude } from './engines/claude.ts';
import { codex } from './engines/codex.ts';

export type Sink = {
  event(line: string): void;
  delta(text: string, thinking: boolean): void;
};

// What an engine hands back at stream close. agent.ts resolves `structured` vs
// `text` against whether a schema was asked for — uniform across engines.
export type EngineEnvelope = {
  structured?: unknown; // a native structured-output field, when the CLI has one
  text: string;         // the final assistant message, always
  tokens: number;
  costUsd: number;      // 0 when the CLI doesn't report cost (codex)
  isError: boolean;
  errorText?: string;
  errorTransient?: boolean; // true → an infra/config/auth error, so fall back to the next candidate
};

export type BuildInput = {
  prompt: string;
  model: string;        // the CLI model — engine prefix already stripped
  cwd: string;
  schema?: object;
  tools?: string;
  bypassPermissions: boolean;
};

export type Engine = {
  bin: string;
  // The prompt rides `stdin`, never argv — a spec-sized prompt as a positional
  // arg trips the OS single-argument cap (Linux MAX_ARG_STRLEN ≈ 128 KB) and the
  // child never spawns (E2BIG). Each engine names the stdin form its CLI reads.
  buildArgv(o: BuildInput): { argv: string[]; stdin: string; cleanup?: () => void; env?: Record<string, string> };
  reader(): EngineReader;
};

// Stateful for one run: fed each parsed NDJSON event, then asked for the
// terminal envelope at close. null from finalize() means no result landed.
export type EngineReader = {
  handle(ev: any, sink: Sink): void;
  finalize(): EngineEnvelope | null;
};

const ENGINES: Record<string, Engine> = { claude, codex };

export function engineFor(model: string): { engine: Engine; cliModel: string; name: string } {
  for (const name of Object.keys(ENGINES)) {
    if (model === name) throw new Error(`model '${model}' names an engine but no model (e.g. ${name}-opus)`);
    if (model.startsWith(`${name}-`)) return { engine: ENGINES[name]!, cliModel: model.slice(name.length + 1), name };
  }
  return { engine: ENGINES.claude!, cliModel: model, name: 'claude' }; // bare name = claude, back-compat
}

// Is the engine this model names installed on the box? Probed once per binary
// and cached. Auth is not checked here — a present-but-unauthed CLI fails at
// spawn/run, which the fallback chain treats as transient and skips past.
const installed = new Map<string, boolean>();
export function available(model: string): boolean {
  let bin: string;
  try { bin = engineFor(model).engine.bin; } catch { return false; }
  if (!installed.has(bin)) installed.set(bin, spawnSync('which', [bin], { stdio: 'ignore' }).status === 0);
  return installed.get(bin)!;
}
