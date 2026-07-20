// The verify-capable resolution arm — the gap that used to make a human
// necessary. triage/reviewer are read-only: they diagnose but can't run, so a
// fix that needs proof (does this narrowed gate pass? does this rewired dep
// unblock?) had nowhere to go but escalation. The resolver has full tools: it
// reproduces the fault, decides a fix WITHIN its jurisdiction — the campaign's
// definition (gates, scope, tickets), never product code — verifies it by
// running the actual check, and returns the mutations it PROVED green.
//
// It never applies them itself: a fixer that both changes a gate and runs it is
// an advocate for its own fix (it could make a gate pass by quietly loosening
// it — the exact thing the read-only-judge design exists to prevent). So the
// resolver only proposes; a fresh-context auditor checks the proposal didn't
// weaken any invariant or scope; and the coordinator applies only what clears
// audit. Its exit — if it can't make the fault green within jurisdiction — is a
// park, not a stop.

import { backlogWrite } from './backlog.ts';
import { journalTail } from './journal.ts';
import { agent, renderPrompt } from '../agent/agent.ts';
import { MODELS } from './models.ts';
import { RESOLVER, AUDIT } from '../agent/schemas.ts';
import type { ResolveVerdict, AuditVerdict } from '../agent/schemas.ts';
import { execAction, backlogSummary, type Anomaly } from './triage.ts';
import { park } from './escalate.ts';
import * as tui from '../tui/tui.ts';

// A decision the deterministic spine can't make: first try to resolve it with a
// verified fix; park it for the human only if the fix can't be made or can't
// pass audit. This replaces escalation for every decision-class anomaly — the
// only remaining hard exit is a repeated coordinator fault.
export async function resolveOrPark(anomaly: Anomaly, target?: { ticketId?: string; subject?: string }): Promise<void> {
  const proposal = (await agent<ResolveVerdict>({
    prompt: renderPrompt('resolver', {
      anomaly,
      backlogSummary: backlogSummary(),
      journal: journalTail(60),
    }),
    models: MODELS.resolver,
    bypassPermissions: true, // full tools: the resolver must RUN checks to verify
    schema: RESOLVER,
    label: `resolve:${anomaly.kind}`,
  })).output;

  if (!proposal.resolved || !proposal.actions.length) {
    return park(proposal.reason || `resolver could not resolve ${anomaly.kind} within jurisdiction`, target);
  }

  const audit = (await agent<AuditVerdict>({
    prompt: renderPrompt('auditor', {
      anomaly,
      actions: proposal.actions,
      evidence: proposal.evidence,
      backlogSummary: backlogSummary(),
    }),
    models: MODELS.auditor,
    schema: AUDIT,
    tools: 'Read,Glob,Grep', // read-only: independent judgment, never the advocate
    label: `audit:${anomaly.kind}`,
  })).output;

  if (!audit.clean) {
    return park(`resolver fix for ${anomaly.kind} failed audit: ${audit.why}`, { ...target, detail: proposal });
  }

  // Audited clean → the coordinator (not the resolver) applies. A refused
  // mutation is journaled, never silently dropped.
  const applied: string[] = [];
  for (const a of proposal.actions) {
    try {
      applied.push(await execAction(a, anomaly));
    } catch (e: any) {
      backlogWrite(['note', '--kind', 'resolve-refused', '--subject', a.ticketId ?? a.command,
        '--body', `${a.command}: ${e.message}`]);
    }
  }
  backlogWrite(['note', '--kind', 'resolved', '--subject', anomaly.kind,
    '--body', `${proposal.evidence} — applied [${applied.join(', ')}]; audit: ${audit.why}`]);
  tui.log(`✓ resolved ${anomaly.kind} (audited): [${applied.join(', ')}]`);
}
