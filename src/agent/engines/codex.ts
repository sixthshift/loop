// The Codex CLI engine (`codex exec --json`). Differences from Claude that this
// file absorbs: the prompt is positional; the schema is a file path, not inline
// JSON (so a temp file is written and cleaned up); tool restriction is a sandbox
// mode, not a tool allowlist; and the terminal state is split across two events
// — the final answer arrives as an `agent_message` item, the token usage in the
// closing `turn.completed`. Codex reports no cost, so cost is 0.
//
// Verified against codex-cli 0.144.5: thread.started, turn.started,
// item.completed{agent_message}, turn.completed{usage}. The other item types
// and the failure event are handled defensively — anything unrecognized still
// surfaces a transcript line rather than vanishing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Engine, EngineEnvelope } from '../engine.ts';

let schemaSeq = 0;

// Codex's `--output-schema` is OpenAI strict structured output: every object's
// `required` must list every key in `properties`, and every object must forbid
// extra keys. Our canonical schemas (schemas.ts) are standard JSON Schema with
// genuinely-optional fields — Claude accepts them, codex rejects the whole
// request with a 400 (`invalid_json_schema`), which the fallback chain then
// silently demotes to Claude. So the OpenAI-ism lives here, at the codex
// perimeter, not in the shared schema: `strictify` makes every object strict —
// all keys required, no extras — and re-expresses each originally-optional key
// as nullable, preserving "may be absent" as "may be null" (the interior reads
// these through `?.`/`??`, so null and absent are equivalent to it).
function strictify(node: any): any {
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

// The read half of the same adaptation: `strictify` forces every optional key
// to be present, so codex returns it as null. Drop those nulls back out so the
// parsed object is shape-identical to Claude's (optional key simply absent) —
// the interior distinguishes null from absent in places (`{depends_on: [], ...t}`
// would let a null override the default), so the boundary erases the difference.
function stripNulls(v: any): any {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (!v || typeof v !== 'object') return v;
  const out: any = {};
  for (const [k, val] of Object.entries(v)) if (val !== null) out[k] = stripNulls(val);
  return out;
}

export const codex: Engine = {
  bin: 'codex',
  buildArgv({ prompt, model, cwd, schema, bypassPermissions }) {
    const argv = ['exec', '--json', '--skip-git-repo-check', '-m', model, '-C', cwd];
    let cleanup: (() => void) | undefined;
    if (schema) {
      const file = path.join(os.tmpdir(), `loop-schema-${process.pid}-${schemaSeq++}.json`);
      fs.writeFileSync(file, JSON.stringify(strictify(schema)));
      argv.push('--output-schema', file);
      cleanup = () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
    }
    // No per-tool allowlist: a worker needs full write access, a read-only role
    // gets the sandbox instead of a --tools list.
    argv.push('-s', bypassPermissions ? 'danger-full-access' : 'read-only');
    if (bypassPermissions) argv.push('--dangerously-bypass-approvals-and-sandbox');
    argv.push(prompt); // positional, last
    // codex is Rust: a bare `os error 2` names no path. A backtrace turns the
    // next flake into something diagnosable rather than a one-line dead end.
    return { argv, cleanup, env: { RUST_BACKTRACE: '1' } };
  },
  reader() {
    let text = '', tokens = 0, isError = false, errorTransient = false, errorText: string | undefined, saw = false;
    return {
      handle(ev, sink) {
        switch (ev.type) {
          case 'thread.started': sink.event('· session started'); return;
          case 'item.completed': {
            const it = ev.item ?? {};
            if (it.type === 'agent_message') { text = it.text ?? ''; saw = true; if (it.text?.trim()) sink.event(oneLine(it.text)); }
            else if (it.type === 'command_execution') sink.event(`→ ${oneLine(it.command ?? JSON.stringify(it))}`);
            else if (it.type === 'file_change') sink.event(`✎ ${oneLine(JSON.stringify(it.changes ?? it))}`);
            else if (it.type === 'reasoning') { if (it.text?.trim()) sink.event(`… ${oneLine(it.text)}`); }
            else sink.event(`· ${oneLine(JSON.stringify(it))}`);
            return;
          }
          case 'turn.completed': tokens = ev.usage?.output_tokens ?? 0; saw = true; return;
          // `error` is an API/transport/config failure (bad model, auth) — try
          // the next candidate. `turn.failed` is the agent genuinely failing its
          // task: a real outcome, not a channel flake, so it stops the chain.
          case 'error': isError = true; errorTransient = true; errorText = oneLine(ev.error?.message ?? ev.message ?? JSON.stringify(ev)); saw = true; return;
          case 'turn.failed': isError = true; errorText = oneLine(ev.error?.message ?? ev.message ?? JSON.stringify(ev)); saw = true; return;
        }
      },
      finalize(): EngineEnvelope | null {
        if (!saw) return null;
        // Structured output arrives as the message text (constrained by
        // --output-schema). Parse and strip the strict-mode nulls here so the
        // coordinator receives the same shape it gets from Claude; on a parse
        // miss, leave it to agent.ts to parse the raw text. No cost from codex.
        let structured: unknown;
        if (text && !isError) { try { structured = stripNulls(JSON.parse(text)); } catch { /* not JSON; agent.ts handles text */ } }
        return { structured, text, tokens, costUsd: 0, isError, errorTransient, errorText };
      },
    };
  },
};

const oneLine = (s: unknown) => String(s).replace(/\s+/g, ' ').trim().slice(0, 300);
