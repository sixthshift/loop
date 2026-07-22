// JSON Schemas for every agent verdict. Passed to `claude -p --json-schema`,
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
  files: string[];
  resources?: string[];
  origin: string;
  context: string;
  acceptance: string;
  acceptanceChecks: Check[];
};

export type TicketPatch = Partial<Omit<TicketDraft, 'id' | 'origin'>>;

export type KickoffVerdict = {
  blockers: { item: string; needed: string }[];
  fastChecks: Check[];
  gate: Check[];
  outOfScope: string[];
  notes: string;
};

export type DecomposeVerdict = { tickets: TicketDraft[] };

export type WorkerVerdict = {
  done?: boolean;
  summary?: string;
  tooBig?: boolean;
  proposedTickets?: TicketDraft[];
  blocked?: boolean;
  reason?: string;
};

export type ReviewVerdict = {
  verdict: 'close' | 'retry' | 'gamed' | 'flake-probe' | 'amend-typo' | 'escalate';
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
  command: 'update' | 'set-status' | 'add' | 'note' | 'gate';
  ticketId?: string;
  patch?: TicketPatch;
  to?: string;
  tickets?: TicketDraft[];
  gates?: Check[];
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

export const TICKET = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    resources: { type: 'array', items: { type: 'string' } },
    origin: { type: 'string' },
    context: { type: 'string' },
    acceptance: { type: 'string' },
    acceptanceChecks: { type: 'array', items: CHECK },
  },
  required: ['id', 'title', 'files', 'origin', 'context', 'acceptance', 'acceptanceChecks'],
  additionalProperties: false,
};

// Contract fields a recover/sweep patch may touch — mirrors
// backlog-write.mjs's MUTABLE list.
const TICKET_PATCH = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    resources: { type: 'array', items: { type: 'string' } },
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
    notes: { type: 'string' },
  },
  required: ['blockers', 'fastChecks', 'gate', 'outOfScope', 'notes'],
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
    verdict: { type: 'string', enum: ['close', 'retry', 'gamed', 'flake-probe', 'amend-typo', 'escalate'] },
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
    command: { type: 'string', enum: ['update', 'set-status', 'add', 'note', 'gate'] },
    ticketId: { type: 'string' },
    patch: TICKET_PATCH,
    to: { type: 'string' },
    tickets: { type: 'array', items: TICKET },
    gates: { type: 'array', items: CHECK },
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
