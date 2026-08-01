// The live window's one job is to not lie about what is running. A stale file
// shown as a live check sends the operator to look at a process that ended
// minutes ago; worse, it makes the dashboard's only measured signal — a probed pid
// — the thing that is wrong.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { LIVE, liveStart, livePid, liveData, liveEnd, liveRuns } from './live.ts';
import { withScratchCampaign, withScratchCampaignAsync } from './scratch-campaign.ts';

const onScratch = (body: () => void) => withScratchCampaign({ backlog: { tickets: [] } }, body);
const onScratchAsync = (body: () => Promise<void>) =>
  withScratchCampaignAsync({ backlog: { tickets: [] } }, body);

// Writes are batched on a 250ms timer so a chatty suite doesn't turn its own
// stdout into a stream of fs writes. A test reading the published file has to
// clear that window rather than the deadline it happens to beat locally.
const flushed = () => new Promise(resolve => setTimeout(resolve, 400));

describe('the live window', () => {
  test('a started run is published immediately, before it prints anything', () => {
    onScratch(() => {
      liveStart('verify:T001 · unit', 'bun test', 'T001');
      livePid('verify:T001 · unit', process.pid);
      const runs = liveRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ cmd: 'bun test', ticketId: 'T001' });
      liveEnd('verify:T001 · unit');
    });
  });

  test('a label with characters a path cannot hold still lands as a file', () => {
    onScratch(() => {
      liveStart('verify:T001 · type/check', 'tsc', 'T001');
      expect(fs.readdirSync(LIVE).filter(f => f.endsWith('.json'))).toHaveLength(1);
      expect(liveRuns()[0]?.label).toBe('verify:T001 · type/check');
      liveEnd('verify:T001 · type/check');
    });
  });

  // A chunk almost never ends on a newline, so splitting per chunk shreds every
  // line that straddles one — and the shredded half is usually the failure message
  // the operator opened the pane to read. The trailing fragment is held back as
  // `partial` rather than published as a line, because a progress bar mid-redraw
  // is not a line yet.
  test('output is reassembled across chunk boundaries, not split per chunk', async () => {
    await onScratchAsync(async () => {
      liveStart('gate:e2e', 'bun test:e2e');
      liveData('gate:e2e', 'first li');
      liveData('gate:e2e', 'ne\nsecond line\ntrailing frag');
      await flushed();
      const run = liveRuns()[0]!;
      expect(run.tail.map(l => l.line)).toEqual(['first line', 'second line']);
      expect(run.partial).toBe('trailing frag');
      liveEnd('gate:e2e');
    });
  });

  test('the file is gone once the run ends — a finished check is not a live one', () => {
    onScratch(() => {
      liveStart('gate:e2e', 'bun test:e2e');
      expect(liveRuns()).toHaveLength(1);
      liveEnd('gate:e2e');
      expect(liveRuns()).toHaveLength(0);
    });
  });

  // The case that matters: a verb killed mid-check cannot clean up after itself,
  // because the process that would do the cleaning is the one that died. The
  // reader has to recognize the leftover rather than render it.
  test('a run whose writer is dead is dropped, not shown as running', () => {
    onScratch(() => {
      fs.mkdirSync(LIVE, { recursive: true });
      fs.writeFileSync(path.join(LIVE, 'orphan.json'), JSON.stringify({
        label: 'verify:T009 · unit', cmd: 'bun test', startedAt: Date.now(),
        // pid 1 is init and always alive, so a plausibly-dead pid is synthesized:
        // an unused high pid in a namespace this test owns nothing in.
        pid: 0x7ffffffe, tail: [], partial: '',
      }));
      expect(liveRuns()).toHaveLength(0);
    });
  });

  test('a run that has not reported its pid yet is kept — that gap is a spawn, not a death', () => {
    onScratch(() => {
      liveStart('verify:T001 · unit', 'bun test', 'T001');
      expect(liveRuns()[0]?.pid).toBeUndefined();
      expect(liveRuns()).toHaveLength(1);
      liveEnd('verify:T001 · unit');
    });
  });

  test('a malformed file is skipped rather than taking the whole pane down', () => {
    onScratch(() => {
      fs.mkdirSync(LIVE, { recursive: true });
      fs.writeFileSync(path.join(LIVE, 'torn.json'), '{"label":"half-writ');
      liveStart('gate:e2e', 'bun test:e2e');
      expect(liveRuns()).toHaveLength(1);
      liveEnd('gate:e2e');
    });
  });
});
