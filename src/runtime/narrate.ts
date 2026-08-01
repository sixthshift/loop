// Operator narration — the running commentary a verb leaves while it works.
//
// Always stderr, and that is structural rather than a setting. Every verb's
// stdout is a result payload the calling coordinator parses, so one line of
// commentary on stdout corrupts the parse. This used to be a toggle because one
// caller owned stdout for its own narration — this program's drive loop, which
// printed its progress there because it WAS the progress. That caller is gone,
// and with it the only reason the channel was ever a choice.
//
// The durable record is journal.jsonl. This is the part that doesn't survive:
// what a verb was doing while it ran, for whoever is watching it run.

export function narrate(msg: string): void {
  console.error(`${new Date().toTimeString().slice(0, 8)} ${msg}`);
}
