// Reconcile durable ticket artifacts after the coordinator process disappears.
// The backlog says which tickets were in flight; Git says whether their branch
// survived. A surviving branch re-enters the ordinary verify/review path.

import { backlog, backlogWrite } from './backlog.ts';
import { provision } from './provision.ts';
import { attachWorktree } from './worktree.ts';
import {
  discardTicketBuild,
  reviewTicket,
} from './ticket-execution.ts';

export async function reconcileStale(): Promise<void> {
  const stale = backlog().tickets.filter(ticket => ticket.status === 'in-flight');
  for (const ticket of stale) {
    const worktree = attachWorktree(ticket.id);
    if (!worktree || !ticket.baseSha) {
      discardTicketBuild(ticket.id);
      backlogWrite(['set-status', ticket.id, 'open', '--note',
        'stale in-flight on resume; no durable work found']);
      continue;
    }
    await provision(ticket.id, worktree.dir);
    await reviewTicket(
      ticket.id,
      { dir: worktree.dir, baseSha: ticket.baseSha },
      'resumed: worker session lost, branch survived — judge on the evidence alone',
      { workerTokens: 0, workerSeconds: 0, workerCostUsd: 0, model: '' },
    );
  }
}
