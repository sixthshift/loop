// The post-mortem is the campaign's only survivor, and since the report merged
// into it, also the human's only copy of the coordinator's verdict. Two things
// are worth pinning: the markdown subset renders (and escapes — the body is
// model prose going into a durable archive), and a journaled campaign-report
// actually surfaces on the page while its absence renders no empty shell.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { mdToHtml, writePostmortem } from './postmortem.ts';
import { buildEntry, buildTicket, withScratchCampaign } from './scratch-campaign.ts';

describe('mdToHtml', () => {
  test('headings nest below the page chrome, lists and inline marks render', () => {
    const html = mdToHtml('# Verdict\n\nAll **28** tickets closed via `loop close`.\n\n- one\n- two');
    expect(html).toContain('<h3>Verdict</h3>');
    expect(html).toContain('<strong>28</strong>');
    expect(html).toContain('<code>loop close</code>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
  });

  test('a pipe table renders with its header row', () => {
    const html = mdToHtml('| Req | Proof |\n|---|---|\n| R1 | T003 |');
    expect(html).toContain('<th>Req</th>');
    expect(html).toContain('<td>T003</td>');
  });

  test('code-span content stays literal — no bold/link rewriting inside backticks', () => {
    const html = mdToHtml('run `a**b**c` then `[T001](x.ts)` — but **this** binds');
    expect(html).toContain('<code>a**b**c</code>');
    expect(html).toContain('<code>[T001](x.ts)</code>');
    expect(html).toContain('<strong>this</strong>');
  });

  test('raw HTML in the body is escaped, fenced code verbatim', () => {
    const html = mdToHtml('a <script>alert(1)</script> claim\n\n```\n<b>kept</b>\n```');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<pre><code>&lt;b&gt;kept&lt;/b&gt;</code></pre>');
  });
});

describe('writePostmortem campaign report', () => {
  const render = (journal: ReturnType<typeof buildEntry>[]): string => {
    let html!: string;
    withScratchCampaign({
      backlog: { tickets: [buildTicket({ id: 'T001', status: 'closed' })] },
      journal,
    }, () => {
      const out = path.join(process.cwd(), 'pm.html');
      writePostmortem(out);
      html = fs.readFileSync(out, 'utf8');
    });
    return html;
  };
  const base = [
    buildEntry({ ts: '2026-01-01T00:00:00Z', kind: 'status', subject: 'T001', body: '→ in-flight' }),
    buildEntry({ ts: '2026-01-01T00:20:00Z', kind: 'close', subject: 'T001', body: 'closed' }),
  ];

  test('the last journaled campaign-report opens the page', () => {
    const html = render([
      ...base,
      buildEntry({ ts: '2026-01-01T00:21:00Z', kind: 'campaign-report', subject: 'campaign', body: '# First draft' }),
      buildEntry({ ts: '2026-01-01T00:22:00Z', kind: 'campaign-report', subject: 'campaign', body: '# Corrected verdict' }),
    ]);
    expect(html).toContain('<h2>Campaign report</h2>');
    expect(html).toContain('<h3>Corrected verdict</h3>');
    // The superseded draft still lives in the embedded raw journal (the page is
    // the archive); it just must not RENDER.
    expect(html).not.toContain('<h3>First draft</h3>');
  });

  test('no journaled report, no report card', () => {
    expect(render(base)).not.toContain('Campaign report');
  });
});
