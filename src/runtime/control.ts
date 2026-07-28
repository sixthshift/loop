// The operator's control surface — the one channel through which a display
// reaches the coordinator. Flags only: the drive loop reads them at its next
// decision point, so no input can interleave with a backlog write (those are
// synchronous — the event loop is parked while they run).
//
// Killing is the exception — it acts immediately on a child process, never on
// state — and lives with the processes it acts on: fleet.kill / fleet.killAll
// in agent/fleet.ts. The dead worker's promise rejects and settles through the
// same failed-attempt path as any other channel death.

export const control = {
  paused: false,          // stop dispatching; in-flight workers finish and settle
  // Concurrent *build* sessions. A ticket that has returned and is settling no
  // longer holds a slot — its review agent runs on top of the cap, deliberately:
  // holding the slot until the merge is what left workers idle behind one slow
  // settle. So live agents can exceed this, bounded by the dispatch graph.
  workerCap: parseInt(process.env.AILOOP_WORKERS ?? '3', 10),
  forceSweep: false,      // run the sweep at the next loop turn
};
