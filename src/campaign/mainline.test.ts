// The mainline lock is the one place the drive's concurrency is load-bearing,
// so its three properties are asserted directly: sections never overlap, a
// failed section doesn't wedge the queue, and a nested take fails loudly rather
// than deadlocking.

import { describe, expect, test } from 'bun:test';
import { withMainline } from './mainline.ts';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

describe('withMainline', () => {
  test('sections never overlap, however they interleave their awaits', async () => {
    const trace: string[] = [];
    const section = (name: string, ms: number) => withMainline(async () => {
      trace.push(`${name}:enter`);
      await tick(ms);
      trace.push(`${name}:exit`);
    });
    // The slow section is taken first: without the lock its exit would land
    // after both of the fast sections' entries.
    await Promise.all([section('a', 20), section('b', 0), section('c', 0)]);
    expect(trace).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit', 'c:enter', 'c:exit']);
  });

  test('ownership passes in arrival order', async () => {
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map(n => withMainline(async () => { await tick(4 - n); order.push(n); })));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  test('a failing section releases the lock and does not wedge the queue', async () => {
    const boom = withMainline(async () => { throw new Error('boom'); });
    expect(boom).rejects.toThrow('boom');
    await boom.catch(() => {});
    expect(await withMainline(async () => 'after')).toBe('after');
  });

  test('the caller sees the section\'s own resolution, not the queue\'s', async () => {
    const [a, b] = await Promise.all([
      withMainline(async () => { await tick(5); return 'a'; }),
      withMainline(async () => 'b'),
    ]);
    expect([a, b]).toEqual(['a', 'b']);
  });

  test('a nested take throws instead of deadlocking', async () => {
    const nested = withMainline(async () => withMainline(async () => 'unreachable'));
    expect(nested).rejects.toThrow('not reentrant');
    await nested.catch(() => {});
    // …and the outer failure left the lock takeable.
    expect(await withMainline(async () => 'still works')).toBe('still works');
  });
});
