// Escalation: the loop's honest exit. An escalation closes nothing —
// .ailoop/run/ stays put and the campaign resumes where it stopped.

import { backlogWrite, campaignExists } from './run.mjs';

export class Escalation extends Error {
  constructor(reason, detail) {
    super(reason);
    this.detail = detail;
  }
}

export function escalate(reason, detail) {
  // The journal entry is bookkeeping around the escalation, not the
  // escalation itself — it must never mask the throw.
  if (campaignExists()) {
    try {
      backlogWrite(['note', '--kind', 'escalation', '--subject', 'campaign', '--body', reason]);
    } catch { /* journaling failed; the throw below still surfaces the reason */ }
  }
  throw new Escalation(reason, detail);
}
