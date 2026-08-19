// Where a campaign keeps its things. A leaf on purpose: this module imports
// nothing, so anything may import it.
//
// These used to live in state.ts alongside shell execution and the coordinator
// lock, which was fine until live.ts — written for a dashboard in another process
// — needed a path from a module that state.ts itself depends on. That is a cycle,
// and it surfaced as a TDZ error rather than as anything resembling its cause.
// Two constants that everything reads and nothing computes belong on their own.

// Campaign state: the authoritative snapshot, the audit journal, per-ticket
// evidence, and the live-run window. Deleted when a campaign terminates, which is
// how `campaignExists` works, so nothing durable may be kept here.
export const RUN = '.ailoop/campaign';

// Cross-campaign memory: survives termination, git-tracked, capped. Written by
// the harvest at the end of a campaign and read at the next one's kickoff.
export const LEARNINGS = '.ailoop/learnings';

// Where a measurement leaves what it read: per-ticket check logs and diff
// patches, and the campaign gate's own run. One constant rather than one per
// measuring module, because a reader looking for "what did this campaign
// actually observe" must not have to know which verb wrote it.
export const EVIDENCE = `${RUN}/evidence`;
