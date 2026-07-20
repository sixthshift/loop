// The operator's control surface — the one channel through which the
// dashboard reaches the coordinator. Flags only: the drive loop reads them
// at its next decision point, so no keypress can interleave with a backlog
// write (those are spawnSync — the event loop is parked while they run).
//
// Killing is the exception: it acts immediately, but only on a child
// process, never on state. The dead worker's promise rejects and settles
// through the same failed-attempt path as any other channel death.

export const control = {
  paused: false,          // stop dispatching; in-flight workers finish and settle
  workerCap: parseInt(process.env.AILOOP_WORKERS ?? '3', 10),
  forceReview: false,     // run the reviewer at the next loop turn
};

// label -> kill fn, registered by agent.ts for the life of the child.
// Kill is operator-intent, not a channel flake: the rejection it causes is
// marked non-transient so agentRetry never silently re-runs killed work.
const killers = new Map<string, () => void>();

export function registerKill(label: string, kill: () => void): void {
  killers.set(label, kill);
}

export function unregisterKill(label: string): void {
  killers.delete(label);
}

export function killAgent(label: string): boolean {
  const kill = killers.get(label);
  if (kill) kill();
  return Boolean(kill);
}

export function killAllAgents(): void {
  for (const kill of killers.values()) kill();
}
