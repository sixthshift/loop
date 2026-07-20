// JSON Schemas for every agent verdict. Passed to `claude -p --json-schema`,
// so the CLI validates before the coordinator ever sees the reply — the
// boundary to a model's output is defended here, once. Each schema's TS type
// lives beside it in this file: the schema is the runtime guard, the type is
// the same contract pushed into the interior — adjacency keeps them in sync.

export type Severity = 'low' | 'medium' | 'high';
export type ModelName = 'opus' | 'sonnet' | 'haiku';
export type Check = { name: string; cmd: string };

export type TicketDraft = {
  id: string;
  title: string;
  phase: string;
  depends_on?: string[];
  files: string[];
  resources?: string[];
  origin: string;
  context: string;
  acceptance: string;
  acceptanceChecks: Check[];
  model?: ModelName;
};

export type TicketPatch = Partial<Omit<TicketDraft, 'id' | 'origin'>>;

export type SeedVerdict = {
  blockers: { item: string; needed: string }[];
  fastChecks: Check[];
  phases: { id: string; delivers: string; gate: Check[] }[];
  outOfScope: string[];
  notes: string;
};

export type DecomposeVerdict = { tickets: TicketDraft[] };

export type CriticVerdict = {
  tickets: {
    ticketId: string;
    findings: { question: 'gaming' | 'blindness' | 'coverage' | 'dependency' | 'scope'; issue: string; severity: Severity }[];
    patch?: TicketPatch;
    acceptedRisks: { issue: string; severity: Severity; why: string }[];
  }[];
};

export type WorkerVerdict = {
  done?: boolean;
  summary?: string;
  tooBig?: boolean;
  proposedTickets?: TicketDraft[];
  blocked?: boolean;
  reason?: string;
};

export type GamingVerdict = { flags: { issue: string; why: string; severity: Severity }[] };

export type JudgeVerdict = {
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

export type TriageAction = {
  command: 'update' | 'set-status' | 'add' | 'note' | 'repair';
  ticketId?: string;
  patch?: TicketPatch;
  to?: string;
  tickets?: TicketDraft[];
  kind?: string;
  subject?: string;
  body?: string;
  note?: string;
  instruction?: string;
};

export type TriageVerdict = { actions: TriageAction[]; escalate?: string; summary: string };

export type RepairVerdict = { resolved: boolean; summary: string };

export type ReviewerProposal = {
  type: 'note' | 'ticket' | 'sharpen' | 'escalate';
  kind?: string;
  subject?: string;
  body?: string;
  ticket?: TicketDraft;
  ticketId?: string;
  patch?: TicketPatch;
  note?: string;
  reason?: string;
};

export type ReviewerVerdict = { proposals: ReviewerProposal[]; summary: string };

export type ReintegrateVerdict = { composes: boolean; tripwire?: string; repairs: TicketDraft[]; notes: string };

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
    phase: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    resources: { type: 'array', items: { type: 'string' } },
    origin: { type: 'string' },
    context: { type: 'string' },
    acceptance: { type: 'string' },
    acceptanceChecks: { type: 'array', items: CHECK },
    model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
  },
  required: ['id', 'title', 'phase', 'files', 'origin', 'context', 'acceptance', 'acceptanceChecks'],
  additionalProperties: false,
};

// Contract fields a critic/triage/reviewer patch may touch — mirrors
// backlog-write.mjs's MUTABLE list.
const TICKET_PATCH = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    phase: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    resources: { type: 'array', items: { type: 'string' } },
    model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
    context: { type: 'string' },
    acceptance: { type: 'string' },
    acceptanceChecks: { type: 'array', items: CHECK },
  },
  additionalProperties: false,
};

export const SEED = {
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
    phases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          delivers: { type: 'string' },
          gate: { type: 'array', items: CHECK },
        },
        required: ['id', 'delivers', 'gate'],
        additionalProperties: false,
      },
    },
    outOfScope: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['blockers', 'fastChecks', 'phases', 'outOfScope', 'notes'],
  additionalProperties: false,
};

export const DECOMPOSE = {
  type: 'object',
  properties: { tickets: { type: 'array', items: TICKET } },
  required: ['tickets'],
  additionalProperties: false,
};

export const CRITIC = {
  type: 'object',
  properties: {
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', enum: ['gaming', 'blindness', 'coverage', 'dependency', 'scope'] },
                issue: { type: 'string' },
                severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              },
              required: ['question', 'issue', 'severity'],
              additionalProperties: false,
            },
          },
          patch: TICKET_PATCH,
          acceptedRisks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                issue: { type: 'string' },
                severity: { type: 'string', enum: ['low', 'medium', 'high'] },
                why: { type: 'string' },
              },
              required: ['issue', 'severity', 'why'],
              additionalProperties: false,
            },
          },
        },
        required: ['ticketId', 'findings', 'acceptedRisks'],
        additionalProperties: false,
      },
    },
  },
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

export const GAMING = {
  type: 'object',
  properties: {
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue: { type: 'string' },
          why: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['issue', 'why', 'severity'],
        additionalProperties: false,
      },
    },
  },
  required: ['flags'],
  additionalProperties: false,
};

export const JUDGE = {
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

export const TRIAGE = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: ['update', 'set-status', 'add', 'note', 'repair'] },
          ticketId: { type: 'string' },
          patch: TICKET_PATCH,
          to: { type: 'string' },
          tickets: { type: 'array', items: TICKET },
          kind: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          note: { type: 'string' },
          instruction: { type: 'string' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    escalate: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['actions', 'summary'],
  additionalProperties: false,
};

export const REPAIR = {
  type: 'object',
  properties: {
    resolved: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['resolved', 'summary'],
  additionalProperties: false,
};

export const REVIEWER = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['note', 'ticket', 'sharpen', 'escalate'] },
          kind: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          ticket: TICKET,
          ticketId: { type: 'string' },
          patch: TICKET_PATCH,
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

export const REINTEGRATE = {
  type: 'object',
  properties: {
    composes: { type: 'boolean' },
    tripwire: { type: 'string' },
    repairs: { type: 'array', items: TICKET },
    notes: { type: 'string' },
  },
  required: ['composes', 'repairs', 'notes'],
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
