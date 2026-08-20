// JSON Schemas for every campaign-agent verdict. Passed to `claude -p --json-schema`,
// so the CLI validates before the coordinator ever sees the reply — the
// boundary to a model's output is defended here, once. Each schema's TS type
// lives beside it in this file: the schema is the runtime guard, the type is
// the same contract pushed into the interior — adjacency keeps them in sync.

export type Severity = 'low' | 'medium' | 'high';
export type Check = { name: string; cmd: string };

export type TicketDraft = {
  id: string;
  title: string;
  depends_on?: string[];
  // Repo-relative directories the ticket lives in — its footprint. See
  // campaign/footprint.ts for why this is a module and not a file list.
  modules: string[];
  // Requirement ids from the kickoff enumeration that this ticket delivers.
  satisfies?: string[];
  origin: string;
  context: string;
  acceptance: string;
  acceptanceChecks: Check[];
};

// `satisfies` is deliberately absent: a patch may reshape how a ticket does its
// job, never which clause it answers for. Losing a claim silently un-covers a
// requirement, and the frontier would report the gap with no one to blame.
export type TicketPatch = Partial<Omit<TicketDraft, 'id' | 'origin' | 'satisfies'>>;

// One normative clause of the locked spec. `id` is stable for the campaign's
// life — tickets, the frontier, and coverage all join on it.
export type Requirement = { id: string; clause: string };

// A named checkpoint over requirement ids — the spec's own account of where a
// coherent slice of the product lands. Purely observational: it never gates
// dispatch and carries no checks of its own. Its whole job is to give the sweep
// a moment worth reflecting at, in place of a ticket count that means nothing
// about the product. `delivers` cites requirement ids, so milestones are a view
// over the enumeration rather than a second grouping of it — which is what keeps
// dependencies the only thing sequencing the campaign.
export type Milestone = { id: string; name: string; delivers: string[] };

export type KickoffVerdict = {
  blockers: { item: string; needed: string }[];
  fastChecks: Check[];
  gate: Check[];
  outOfScope: string[];
  requirements: Requirement[];
  milestones: Milestone[];
  caps: Caps | null;
  notes: string;
};

// How much the campaign may spend on one ticket before the answer is the
// human's. Declared by the spec rather than defaulted, because the question a
// cost bound asks — "it has failed three times, may it try again?" — has no
// right answer the loop can derive, and every firing of it costs a park.
export type Caps = { maxAttempts: number; thrash: number; infraCap?: number };

export type DecomposeVerdict = { tickets: TicketDraft[] };

export type CriticFinding = {
  ticketId: string;
  variant: string;
  patch?: TicketPatch;
  acceptedRisk?: string;
  severity?: 'low' | 'medium' | 'high';
};

export type CriticVerdict = { findings: CriticFinding[]; summary: string };

export type WorkerVerdict = {
  done?: boolean;
  summary?: string;
  tooBig?: boolean;
  proposedTickets?: TicketDraft[];
  blocked?: boolean;
  reason?: string;
};

// `gamed` and `sharpen` both carry sharpenChecks — the escaped-bug rule either
// way — but fork on the build: gamed discards it (deliberate evasion, or a blind
// spot the reviewer cannot clear the diff of), sharpen preserves it (the diff is
// affirmed correct; only the checks failed to prove it).
export type ReviewVerdict = {
  verdict: 'close' | 'retry' | 'gamed' | 'sharpen' | 'flake-probe' | 'amend-typo' | 'escalate';
  note?: string;
  failing?: string[];
  hypothesis?: string;
  fixNote?: string;
  sharpenChecks?: Check[];
  probeCmd?: string;
  fixedChecks?: Check[];
  reason?: string;
};

export type RecoverAction = {
  command: 'update' | 'set-status' | 'add' | 'note' | 'gate' | 'fast-checks';
  ticketId?: string;
  patch?: TicketPatch;
  to?: string;
  tickets?: TicketDraft[];
  gates?: Check[];
  // Fast-tier amendment. Unlike `gates`, admission is decided by running each
  // command at the repo root, not by which anomaly is being recovered.
  fastChecks?: Check[];
  kind?: string;
  subject?: string;
  body?: string;
  note?: string;
  resetAttempts?: boolean; // update only: clear a stale wall when this patch changes the contract
};

// The recover agent has a runtime (full tools): it runs checks to verify a fix,
// fixes the environment directly, and returns the backlog mutations it proved
// green with the evidence. It self-audits; the coordinator applies the actions.
// Resolved with no actions is legitimate — an environment-only fix.
export type RecoverVerdict = { resolved: boolean; actions: RecoverAction[]; evidence: string; reason?: string };

export type SweepProposal = {
  type: 'note' | 'ticket' | 'sharpen' | 'gate' | 'escalate';
  kind?: string;
  subject?: string;
  body?: string;
  ticket?: TicketDraft;
  ticketId?: string;
  patch?: TicketPatch;
  gates?: Check[];
  note?: string;
  reason?: string;
};

export type SweepVerdict = { proposals: SweepProposal[]; summary: string };

export type CoverageVerdict = { done: boolean; missing: TicketDraft[]; summary: string };

export type HarvestVerdict = {
  checks: { name: string; cmd: string; tier: 'fast' | 'gate'; note?: string; retire?: boolean }[];
  flakes: { test: string; cmd?: string; mode?: string; discriminator: string; retire?: boolean }[];
  sizingMd: string;
  gamingMd: string;
  landminesMd: string;
  report: string;
};

const CHECK = {
  type: 'object',
  properties: { name: { type: 'string' }, cmd: { type: 'string' } },
  required: ['name', 'cmd'],
  additionalProperties: false,
};

// One normative clause of the locked spec, enumerated once at kickoff and
// referenced by id thereafter. The id is the join key between the spec and the
// backlog: tickets claim it, the frontier counts it, coverage grades it.
const REQUIREMENT = {
  type: 'object',
  properties: { id: { type: 'string' }, clause: { type: 'string' } },
  required: ['id', 'clause'],
  additionalProperties: false,
};

// The JSON-schema mirror of `Milestone`. `delivers` holds requirement ids; the
// writer refuses one that is not in the same seed's enumeration, so a milestone
// can never be reached by citing a clause nobody enumerated.
const MILESTONE = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    delivers: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'name', 'delivers'],
  additionalProperties: false,
};

export const TICKET = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
    modules: { type: 'array', items: { type: 'string' } },
    // Requirement ids this ticket delivers. Optional in the schema because a
    // repair or proof ticket answers a defect rather than a clause; decompose's
    // prompt requires it, and an unclaimed requirement is what the frontier's
    // coverage arithmetic reports.
    satisfies: { type: 'array', items: { type: 'string' } },
    origin: { type: 'string' },
    context: { type: 'string' },
    acceptance: { type: 'string' },
    acceptanceChecks: { type: 'array', items: CHECK },
  },
  required: ['id', 'title', 'modules', 'origin', 'context', 'acceptance', 'acceptanceChecks'],
  additionalProperties: false,
};

// Contract fields a recover/sweep patch may touch — mirrors
// backlog.ts's sole-writer MUTABLE list.
const TICKET_PATCH = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
    modules: { type: 'array', items: { type: 'string' } },
    context: { type: 'string' },
    acceptance: { type: 'string' },
    acceptanceChecks: { type: 'array', items: CHECK },
  },
  additionalProperties: false,
};

export const KICKOFF = {
  type: 'object',
  properties: {
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: { type: 'string' }, needed: { type: 'string' } },
        required: ['item', 'needed'],
        additionalProperties: false,
      },
    },
    fastChecks: { type: 'array', items: CHECK },
    gate: { type: 'array', items: CHECK },
    outOfScope: { type: 'array', items: { type: 'string' } },
    requirements: { type: 'array', items: REQUIREMENT },
    milestones: { type: 'array', items: MILESTONE },
    caps: {
      type: ['object', 'null'],
      properties: {
        maxAttempts: { type: 'number' },
        thrash: { type: 'number' },
        infraCap: { type: 'number' },
      },
      required: ['maxAttempts', 'thrash'],
      additionalProperties: false,
    },
    notes: { type: 'string' },
  },
  required: ['blockers', 'fastChecks', 'gate', 'outOfScope', 'requirements', 'milestones', 'caps', 'notes'],
  additionalProperties: false,
};

export const DECOMPOSE = {
  type: 'object',
  properties: { tickets: { type: 'array', items: TICKET } },
  required: ['tickets'],
  additionalProperties: false,
};

export const WORKER = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    summary: { type: 'string' },
    tooBig: { type: 'boolean' },
    proposedTickets: { type: 'array', items: TICKET },
    blocked: { type: 'boolean' },
    reason: { type: 'string' },
  },
  additionalProperties: false,
};

export const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['close', 'retry', 'gamed', 'sharpen', 'flake-probe', 'amend-typo', 'escalate'] },
    note: { type: 'string' },
    failing: { type: 'array', items: { type: 'string' } },
    hypothesis: { type: 'string' },
    fixNote: { type: 'string' },
    sharpenChecks: { type: 'array', items: CHECK },
    probeCmd: { type: 'string' },
    fixedChecks: { type: 'array', items: CHECK },
    reason: { type: 'string' },
  },
  required: ['verdict'],
  additionalProperties: false,
};

// One legal backlog mutation the recover agent may return.
const ACTION = {
  type: 'object',
  properties: {
    command: { type: 'string', enum: ['update', 'set-status', 'add', 'note', 'gate', 'fast-checks'] },
    ticketId: { type: 'string' },
    patch: TICKET_PATCH,
    to: { type: 'string' },
    tickets: { type: 'array', items: TICKET },
    gates: { type: 'array', items: CHECK },
    fastChecks: { type: 'array', items: CHECK },
    kind: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
    note: { type: 'string' },
    resetAttempts: { type: 'boolean' },
  },
  required: ['command'],
  additionalProperties: false,
};

export const RECOVER = {
  type: 'object',
  properties: {
    resolved: { type: 'boolean' },
    actions: { type: 'array', items: ACTION },
    evidence: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['resolved', 'actions', 'evidence'],
  additionalProperties: false,
};

export const SWEEP = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['note', 'ticket', 'sharpen', 'gate', 'escalate'] },
          kind: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          ticket: TICKET,
          ticketId: { type: 'string' },
          patch: TICKET_PATCH,
          gates: { type: 'array', items: CHECK },
          note: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['type'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['proposals', 'summary'],
  additionalProperties: false,
};

export const COVERAGE = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    missing: { type: 'array', items: TICKET },
    summary: { type: 'string' },
  },
  required: ['done', 'missing', 'summary'],
  additionalProperties: false,
};

export const HARVEST = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, cmd: { type: 'string' },
          tier: { type: 'string', enum: ['fast', 'gate'] }, note: { type: 'string' },
          retire: { type: 'boolean' },
        },
        required: ['name', 'cmd', 'tier'],
        additionalProperties: false,
      },
    },
    flakes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          test: { type: 'string' }, cmd: { type: 'string' },
          mode: { type: 'string' }, discriminator: { type: 'string' },
          retire: { type: 'boolean' },
        },
        required: ['test', 'discriminator'],
        additionalProperties: false,
      },
    },
    sizingMd: { type: 'string' },
    gamingMd: { type: 'string' },
    landminesMd: { type: 'string' },
    report: { type: 'string' },
  },
  required: ['checks', 'flakes', 'sizingMd', 'gamingMd', 'landminesMd', 'report'],
  additionalProperties: false,
};

// The output contract per role, keyed exactly as the prompt registry
// (agents/prompt.ts): a role is its prompt plus its schema, and the two halves
// belong together. The coordinator reads both (`loop prompt`, `loop schema`), so
// every agent answers in the shape the writer and the verbs expect — a verdict
// parsed loosely is a verdict the mechanics below cannot refuse.
// One finding per ticket, and the finding must arrive as a fix or as a risk the
// judge will be handed — a bare complaint at this stage would cost a read and
// change nothing, which is what got the original pre-dispatch pass deleted.
export const CRITIC = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          // The variant that would pass the current checks — concrete, not a doubt.
          variant: { type: 'string' },
          patch: TICKET_PATCH,
          acceptedRisk: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['ticketId', 'variant'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
  additionalProperties: false,
};

export const SCHEMAS: Record<string, object> = {
  kickoff: KICKOFF, decompose: DECOMPOSE, critic: CRITIC, worker: WORKER, review: REVIEW,
  recover: RECOVER, sweep: SWEEP, coverage: COVERAGE, harvest: HARVEST,
};
