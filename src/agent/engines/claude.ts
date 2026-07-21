// The Claude CLI engine (`claude -p`). Output rides stream-json: token deltas
// while it generates, tool events as it works, and one final `result` event
// carrying the structured output, usage, and cost all together.

import type { Engine, EngineEnvelope } from '../engine.ts';

// The final `result` event — an external contract, so every field is optional
// until checked.
type ResultEnvelope = {
  type: 'result';
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: { output_tokens?: number };
  total_cost_usd?: number;
};

export const claude: Engine = {
  bin: 'claude',
  buildArgv({ prompt, model, schema, tools, bypassPermissions }) {
    // `-p` with no positional prompt reads it from stdin — keeps a spec-sized
    // prompt out of argv, where it would trip the OS single-arg cap.
    const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model, '--no-session-persistence'];
    if (schema) argv.push('--json-schema', JSON.stringify(schema));
    if (tools !== undefined) argv.push('--tools', tools);
    if (bypassPermissions) argv.push('--dangerously-skip-permissions');
    return { argv, stdin: prompt };
  },
  reader() {
    let envelope: ResultEnvelope | null = null;
    return {
      handle(ev, sink) {
        if (ev.type === 'result') { envelope = ev; return; }
        if (ev.type === 'stream_event') {
          const d = ev.event?.delta;
          if (d?.type === 'text_delta') sink.delta(d.text, false);
          else if (d?.type === 'thinking_delta') sink.delta(d.thinking, true);
          return;
        }
        for (const line of transcript(ev)) sink.event(line);
      },
      finalize(): EngineEnvelope | null {
        if (!envelope) return null;
        return {
          structured: envelope.structured_output,
          text: envelope.result ?? '',
          tokens: envelope.usage?.output_tokens ?? 0,
          costUsd: envelope.total_cost_usd ?? 0,
          isError: Boolean(envelope.is_error),
          errorText: envelope.result,
        };
      },
    };
  },
};

// Stream event → human lines for the live tail. Lossy on purpose: enough to
// answer "what is this agent doing", not a session replay.
function transcript(ev: any): string[] {
  if (ev.type === 'system' && ev.subtype === 'init') return ['· session started'];
  if (ev.type !== 'assistant' && ev.type !== 'user') return [];
  const out: string[] = [];
  for (const c of ev.message?.content ?? []) {
    if (c.type === 'text' && c.text?.trim()) out.push(oneLine(c.text));
    if (c.type === 'tool_use') out.push(`→ ${c.name} ${oneLine(JSON.stringify(c.input ?? {}))}`);
    if (c.type === 'tool_result') {
      const body = typeof c.content === 'string' ? c.content
        : (c.content ?? []).map((b: any) => b.text ?? '').join(' ');
      out.push(`←${c.is_error ? ' ✗' : ''} ${oneLine(body) || '(empty)'}`);
    }
  }
  return out;
}

const oneLine = (s: unknown) => String(s).replace(/\s+/g, ' ').trim().slice(0, 300);
