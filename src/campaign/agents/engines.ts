// The two agent CLIs, as far as this program still needs to know them: which one
// a model name selects, whether it is installed, and the one place codex's
// structured output differs from Claude's in a way a caller cannot guess.
//
// This used to be an engine layer — argv builders, NDJSON readers, a spawn loop,
// a fleet of live children — because this program ran the agents itself. It
// doesn't any more: the coordinator is a model in a conversation, and it spawns
// its own subagents through its own harness. What survives is only what a
// coordinator cannot derive for itself and would get wrong by hand.
//
// Three things, and each earns its place by that test:
//
//   • engineFor  — a model name carries its engine as a prefix (`claude-opus`,
//     `codex-gpt-5.6-terra`); a bare name means claude, so old backlogs keep
//     working. One parser, or every caller invents a slightly different one.
//   • available  — is that CLI on the box. Decides which rung of a chain is
//     reachable, so a coordinator that guessed would dispatch into a missing
//     binary and read the failure as the agent's.
//   • strictify / stripNulls — codex's --output-schema is OpenAI strict mode,
//     which rejects the optional keys our canonical schemas carry. Both halves of
//     that adaptation live here.

import { spawnSync } from 'node:child_process';

// Just the binary: nothing left in this file needs to know how to invoke it.
const ENGINES: Record<string, { bin: string }> = {
  claude: { bin: 'claude' },
  codex: { bin: 'codex' },
};

export function engineFor(model: string): { bin: string; cliModel: string; name: string } {
  for (const name of Object.keys(ENGINES)) {
    if (model === name) throw new Error(`model '${model}' names an engine but no model (e.g. ${name}-opus)`);
    if (model.startsWith(`${name}-`)) return { bin: ENGINES[name]!.bin, cliModel: model.slice(name.length + 1), name };
  }
  return { bin: ENGINES.claude!.bin, cliModel: model, name: 'claude' }; // bare name = claude, back-compat
}

// Is the engine this model names installed on the box? Probed once per binary
// and cached. Auth is not checked here — a present-but-unauthed CLI fails at
// spawn/run, which the coordinator reads as a transient failure and skips past.
//
// `env` is passed explicitly and is not decoration: spawnSync snapshots the
// environment at process start, so without it this probe answers "was the binary
// on the PATH when the program launched" while claiming to answer "is it on the
// box". Those differ for anything that resolves its tools at runtime, and the
// wrong answer here is silent — an unavailable rung is skipped, so a chain that
// should have dispatched simply reports that no engine exists.
const installed = new Map<string, boolean>();
export function available(model: string): boolean {
  let bin: string;
  try { bin = engineFor(model).bin; } catch { return false; }
  if (!installed.has(bin))
    installed.set(bin, spawnSync('which', [bin], { stdio: 'ignore', env: process.env }).status === 0);
  return installed.get(bin)!;
}

// Codex's `--output-schema` is OpenAI strict structured output: every object's
// `required` must list every key in `properties`, and every object must forbid
// extra keys. Our canonical schemas (schemas.ts) are standard JSON Schema with
// genuinely-optional fields — Claude accepts them, codex rejects the whole
// request with a 400 (`invalid_json_schema`). So the OpenAI-ism lives here, at
// the codex perimeter, not in the shared schema: `strictify` makes every object
// strict — all keys required, no extras — and re-expresses each originally-
// optional key as nullable, preserving "may be absent" as "may be null".
//
// Served to the coordinator as `loop schema <role> --engine codex` (mechanics.ts)
// rather than described in prose, because re-deriving this from a paragraph is
// how a seat ends up shipping a schema codex 400s on.
export function strictify(node: any): any {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== 'object') return node;
  const out: any = { ...node };
  if (out.properties && typeof out.properties === 'object') {
    const keys = Object.keys(out.properties);
    const required = new Set(Array.isArray(out.required) ? out.required : []);
    out.properties = Object.fromEntries(keys.map(k => {
      const child = strictify(out.properties[k]);
      return [k, required.has(k) ? child : nullable(child)];
    }));
    out.required = keys;
    out.additionalProperties = false;
  }
  if (out.items) out.items = strictify(out.items);
  return out;
}

// Widen a schema node's type to admit null, so a key that was optional upstream
// can be returned as null under strict mode's all-keys-required rule.
function nullable(node: any): any {
  if (!node || typeof node !== 'object' || !('type' in node)) return node;
  const t = node.type;
  if (Array.isArray(t)) return t.includes('null') ? node : { ...node, type: [...t, 'null'] };
  return t === 'null' ? node : { ...node, type: [t, 'null'] };
}

// The read half of the same adaptation: `strictify` forces every optional key to
// be present, so codex returns it as null. Dropping those nulls makes the parsed
// object shape-identical to what Claude returns — the writer distinguishes null
// from absent in places (`{depends_on: [], ...t}` lets a null override the
// default), so the boundary has to erase the difference rather than pass it on.
//
// KNOWN LIMIT: no verb serves this yet, so a coordinator running codex applies
// the write half of the adaptation and not the read half. It is exported for the
// verb that should exist rather than deleted, because the argument for sharing
// `strictify` is the same argument, and the failure it prevents is quieter — a
// null `depends_on` that overrides a default reads as a ticket with no
// dependencies rather than as a 400.
export function stripNulls(v: any): any {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (!v || typeof v !== 'object') return v;
  const out: any = {};
  for (const [k, val] of Object.entries(v)) if (val !== null) out[k] = stripNulls(val);
  return out;
}
