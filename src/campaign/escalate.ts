// Escalation: the loop's honest exit. An escalation closes nothing —
// .ailoop/campaign/ stays put and the campaign resumes where it stopped.

import { backlogWrite } from './backlog.ts';
import { campaignExists } from './index.ts';

export class Escalation extends Error {
  detail: unknown;
  constructor(reason: string, detail?: unknown) {
    super(reason);
    this.detail = detail;
  }
}

export function escalate(reason: string, detail?: unknown): never {
  // The journal entry is bookkeeping around the escalation, not the
  // escalation itself — it must never mask the throw.
  if (campaignExists()) {
    try {
      backlogWrite(['note', '--kind', 'escalation', '--subject', 'campaign', '--body', reason]);
    } catch { /* journaling failed; the throw below still surfaces the reason */ }
  }
  throw new Escalation(reason, detail);
}
