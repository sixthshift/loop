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

export const codex: Engine = {
  bin: 'codex',
  buildArgv({ prompt, model, cwd, schema, bypassPermissions }) {
    const argv = ['exec', '--json', '--skip-git-repo-check', '-m', model, '-C', cwd];
    let cleanup: (() => void) | undefined;
    if (schema) {
      const file = path.join(os.tmpdir(), `loop-schema-${process.pid}-${schemaSeq++}.json`);
      fs.writeFileSync(file, JSON.stringify(schema));
      argv.push('--output-schema', file);
      cleanup = () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
    }
    // No per-tool allowlist: a worker needs full write access, a read-only role
    // gets the sandbox instead of a --tools list.
    argv.push('-s', bypassPermissions ? 'danger-full-access' : 'read-only');
    if (bypassPermissions) argv.push('--dangerously-bypass-approvals-and-sandbox');
    argv.push(prompt); // positional, last
    return { argv, cleanup };
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
        // Structured output is delivered as the message text (constrained by
        // --output-schema); agent.ts parses it against the schema. No native
        // structured field, no cost.
        return saw ? { text, tokens, costUsd: 0, isError, errorTransient, errorText } : null;
      },
    };
  },
};

const oneLine = (s: unknown) => String(s).replace(/\s+/g, ' ').trim().slice(0, 300);
