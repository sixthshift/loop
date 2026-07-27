// The shared checkout — the one resource every settling ticket contends for.
//
// backlog.json needs no lock: the sole writer is synchronous end to end
// (readFileSync → mutate → writeFileSync) and every git call in worktree.ts is
// spawnSync, so on a single-threaded loop each mutation runs to completion
// before any other task resumes, and the coordinator pidfile rules out a second
// process. What is NOT protected by that is a sequence spanning an `await`: the
// merge → close → integration-check run yields at the fast checks, and a second
// settle merging into the mainline mid-run makes the integration verdict a
// statement about a tree that no longer exists — attributed to the wrong ticket.
//
// So the lock is over the shared checkout, not over the writer. Whoever mutates
// or measures the mainline across an await takes it: the landing of a ticket,
// the campaign gate's run, and every recover agent (which holds full tools on
// the repo root for minutes).

import { AsyncLocalStorage } from 'node:async_hooks';

// A promise chain, not a flag: each section is queued behind the previous one's
// settlement, so ownership passes in arrival order and no caller spins.
let tail: Promise<unknown> = Promise.resolve();

// Reentrancy would deadlock — the inner call queues behind a section that
// cannot finish until the inner call returns — and a deadlocked coordinator
// reports nothing at all. Refuse it loudly instead: the storage marks the async
// subtree that already owns the checkout, so a nested take throws while an
// honest concurrent take still queues.
const holding = new AsyncLocalStorage<true>();

export function withMainline<T>(fn: () => Promise<T>): Promise<T> {
  if (holding.getStore()) {
    throw new Error('mainline: section is not reentrant — hoist the inner take out of the enclosing one');
  }
  const run = tail.then(() => holding.run(true, fn), () => holding.run(true, fn));
  tail = run.catch(() => { /* one section's failure must not wedge the queue */ });
  return run;
}
