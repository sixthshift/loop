// JSON Schemas for every agent verdict. Passed to `claude -p --json-schema`,
// so the CLI validates before the coordinator ever sees the reply — the
// boundary to a model's output is defended here, once.

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
          command: { type: 'string', enum: ['update', 'set-status', 'add', 'note'] },
          ticketId: { type: 'string' },
          patch: TICKET_PATCH,
          to: { type: 'string' },
          tickets: { type: 'array', items: TICKET },
          kind: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          note: { type: 'string' },
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
