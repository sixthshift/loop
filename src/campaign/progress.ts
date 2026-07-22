// The campaign's status tree, rendered for a human — read-only, zero tokens.
// This is the one-shot text view behind `loop status`; the live, always-on
// view is the Ink dashboard, so the watch mode the old script carried is gone.

import { backlog } from './backlog.ts';

const GLYPH: Record<string, string> = {
  open: '·', 'in-flight': '◐', closed: '●', parked: '✕', decomposed: '▽', 'failed-wall': '■',
};

export function renderProgress(): string {
  const b = backlog();
  const lines: string[] = [];
  lines.push(`\n${b.project} — ${new Date().toLocaleTimeString()}`);
  const counts = b.tickets.reduce<Record<string, number>>((m, t) => (m[t.status] = (m[t.status] ?? 0) + 1, m), {});
  lines.push(Object.entries(GLYPH).map(([s, g]) => `${g} ${s}:${counts[s] ?? 0}`).join('  '));
  lines.push('─'.repeat(72));
  const done = b.tickets.filter(t => t.status === 'closed').length;
  const liveN = b.tickets.filter(t => !['closed', 'decomposed'].includes(t.status)).length;
  lines.push(`[${done}/${done + liveN} closed]${liveN === 0 && b.tickets.length ? '  ← DRAINED' : ''}`);
  for (const t of b.tickets) {
    const att = (t.attempts ?? []).length ? ` (a${t.attempts!.length})` : '';
    const deps = (t.depends_on ?? []).length ? `  ⇐ ${t.depends_on!.join(',')}` : '';
    lines.push(`  ${GLYPH[t.status] ?? '?'} ${t.id} ${t.title}${att}${deps}`);
  }
  return lines.join('\n');
}
