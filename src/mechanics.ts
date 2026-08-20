// The mechanics surface — every measurement and bookkeeping step of a campaign,
// as a verb.
//
// This is the whole program now, and it used not to be: loop began as a
// coordinator, a deterministic drive loop with an enumerated arm per fault, and
// these verbs were the door a second coordinator — the `ailoop` skill — came
// through. The two ran the same mechanics so a comparison between them would be
// about the seat rather than about who wrote a better backlog writer. That
// comparison is over. The skill drives; the drive loop is gone; what remains is
// the substrate underneath the seat, which is what these verbs always were.
//
// So the design rule is no longer "share the mechanics" but the thing that rule
// was protecting: **a coordinator that is a conversation cannot be trusted to
// remember, count, or measure.** Every one of these verbs exists because the
// alternative is a model doing arithmetic by eye and reporting the result as
// fact. The writer refuses illegal transitions, the frontier derives readiness,
// verify runs the checks and scope-checks the diff, jurisdiction reverts what
// recover shouldn't have touched. None of it asks the coordinator to be careful.
//
// Two properties follow from the seat being a conversation rather than a
// process, and neither is a preference:
//
//   • No coordinator lock. A model in the seat cannot hold a pidfile across
//     separate verb invocations, so no verb ever took one — and the lock that sat
//     unused in state.ts is now gone rather than standing there looking like
//     coverage. Nothing stops two coordinators from opening one campaign except
//     the producer stamp (see assertSkillSeat) and the fact that a human is
//     watching.
//   • stdout carries a result, never narration. The caller parses stdout, so
//     commentary goes to stderr — see runtime/narrate.ts, where that is now
//     structural rather than a mode.

import fs from 'node:fs';
import type { Command } from 'commander';
import { backlog, backlogWrite, campaignExists, renumber, wantsStdinPayload } from './campaign/backlog.ts';
import { currentRef } from './campaign/checkout.ts';
import { frontier } from './campaign/frontier.ts';
import type { Check, TicketDraft } from './campaign/agents/schemas.ts';
import { amendGate, gateAuthority, GATE_RED } from './campaign/gate.ts';
import { amendFastChecks } from './campaign/fastcheck.ts';
import { recoveryBudget } from './campaign/recovery-budget.ts';
import { verify, flakeProbe } from './campaign/verify.ts';
import { vet } from './campaign/vet.ts';
import { runGate } from './campaign/gate-run.ts';
import { bisect } from './campaign/bisect.ts';
import { dispatch, writeSchema } from './campaign/dispatch.ts';
import { snapshotTree, revertOutOfBounds } from './campaign/jurisdiction.ts';
import type { TreeSnapshot } from './campaign/jurisdiction.ts';
import { writePostmortem } from './campaign/postmortem.ts';
import { mergeLearnings } from './campaign/learn.ts';
import type { Harvest } from './campaign/learn.ts';
import { createBranch, attachBranch, discardCheckout, landBranch, deleteBranch } from './campaign/branch.ts';
import { rawPrompt, renderPrompt } from './campaign/agents/prompt.ts';
import { SCHEMAS } from './campaign/agents/schemas.ts';
import { MODELS, resolvedChain } from './campaign/agents/models.ts';
import { strictify } from './campaign/agents/engines.ts';

const fail = (msg: string): never => { console.error(msg); process.exit(1); };

const emit = (value: unknown): void => { console.log(JSON.stringify(value, null, 2)); };

// A campaign stamped `cli` was opened by the drive loop that no longer ships.
// Its live worktrees answered to a process that is gone and its in-flight
// tickets were measured against arms these verbs don't have, so continuing it is
// not a thing this binary can honestly do. Say that, rather than mutate it into
// a state half-owned by two coordinators — one of which no longer exists.
// A `skill` campaign without a recorded mainline is refused on the same
// grounds: it was opened before serial checkouts, and its state describes
// worktrees these verbs no longer have.
function assertSkillSeat(): void {
  if (!campaignExists()) return; // `init` legitimately runs before one exists
  const b = backlog();
  if ((b.coordinator ?? 'cli') === 'cli')
    fail('this campaign was opened by `loop campaign` (coordinator: cli), the deterministic drive loop, which was removed. Nothing here can continue it: archive `.ailoop/campaign/` with `loop postmortem --out <file>` and start fresh, or install the last release that still had that seat (v0.5.0).');
  if (!b.mainline)
    fail('this campaign predates serial checkouts — no mainline recorded in backlog.json. Nothing here can continue it: archive `.ailoop/campaign/` with `loop postmortem --out <file>` (postmortem still reads it), or continue with the last worktree release (v0.6).');
}

// `init` records the branch the campaign builds on. The writer demands the
// name and stays git-free; resolving it from HEAD is this layer's one git
// read, done here so a coordinator never types a branch name the repository
// disagrees with. A detached HEAD is refused — a campaign cut from no named
// branch has nothing for ticket branches to land back onto.
function withMainline(args: string[]): string[] {
  if (args[0] !== 'init' || args.includes('--mainline')) return args;
  const head = currentRef();
  if (!head) return fail('init: HEAD is detached — check out the branch the campaign should build on');
  return [...args, '--mainline', head];
}

// Commands that take a JSON payload read it from stdin, so a coordinator can
// pipe tickets in without staging a temp file it then has to clean up.
// Ticket context is prose, and prose routed through a shell argument is mangled
// by the shell's own vocabulary — the same reason the journal takes a report on
// stdin rather than in `--body`.
async function stdinText(): Promise<string> {
  if (process.stdin.isTTY) return fail('--context - expects the context on stdin');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function stdinJson(): Promise<unknown> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return fail('stdin is not valid JSON'); }
}

const readJsonFile = (file: string): unknown => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e: any) { return fail(`cannot read JSON from ${file}: ${e.message}`); }
};

export function registerMechanics(program: Command): void {
  const mechanic = (name: string): Command => program.command(name);

  mechanic('backlog')
    .description('the sole writer: init seed add update fast-checks gate gate-run gate-park set-status phase attempt close decompose recover-resolution probe-spent sweep-run note')
    .argument('<args...>', 'the writer command and its flags; JSON payloads arrive on stdin')
    // passThroughOptions keeps commander's hands off the writer's own flags — the
    // writer parses them itself, and its vocabulary must not need mirroring here
    // to stay reachable.
    .passThroughOptions()
    .allowUnknownOption()
    .action(async (args: string[]) => {
      // Read stdin only when a positional `-` asks for it: a payload-less
      // writer command under an inherited pipe that never closes must not
      // block on EOF it will never use.
      const input = wantsStdinPayload(args) ? await stdinJson() : undefined;
      assertSkillSeat();
      try { console.log(backlogWrite(withMainline(args), input)); }
      catch (e: any) { fail(e.message); }
    });

  mechanic('frontier')
    .description('the derived scheduler facts: problems, ready, dispatchable, walls, gate freshness, coverage, sweep due')
    .action(() => { emit(frontier()); });

  mechanic('recovery-budget')
    .description('may a recover be spent on this anomaly — the scoped key, what it has spent, and the prior fixes a park would cite')
    .requiredOption('--kind <kind>', 'the anomaly kind, e.g. attempt-wall, stalled, campaign-gate-red')
    .option('--ticket <id>', 'for a ticket-scoped kind: the ticket, which is part of the key')
    .action((opts: { kind: string; ticket?: string }) => {
      try { emit(recoveryBudget({ kind: opts.kind, ...(opts.ticket ? { ticketId: opts.ticket } : {}) })); }
      catch (e: any) { fail(e.message); }
    });

  mechanic('renumber')
    .description('allocate real ticket ids to proposed drafts, rewiring their internal depends_on edges (drafts on stdin)')
    .action(async () => {
      const drafts = await stdinJson();
      if (drafts === undefined) fail('renumber needs the proposed tickets as JSON on stdin');
      if (!Array.isArray(drafts)) fail('renumber takes an array of ticket drafts');
      assertSkillSeat();
      try { emit(renumber(drafts as TicketDraft[])); }
      catch (e: any) { fail(e.message); }
    });

  mechanic('verify')
    .description('measure a worker branch (--ticket --base), or probe one command for flake (--cmd)')
    .option('--ticket <id>', 'ticket to verify, or to label a flake probe')
    .option('--dir <path>', 'the checkout to measure in', '.')
    .option('--base <sha>', 'the mainline sha the branch was cut from')
    .option('--cmd <cmd>', 'flake-probe mode: the single command to repeat')
    .option('--repeat <n>', 'flake-probe repetitions', '5')
    .action(async (opts: { ticket?: string; dir: string; base?: string; cmd?: string; repeat: string }) => {
      if (opts.cmd) {
        // A spent probe budget throws, and an unhandled rejection here would
        // reach the coordinator as a crash trace rather than as the refusal it
        // is — the one shape the seat is told to read and act on.
        try { emit(await flakeProbe({ cmd: opts.cmd, dir: opts.dir, repeat: Number(opts.repeat), id: opts.ticket })); }
        catch (e: any) { fail(e.message); }
        return;
      }
      if (!opts.ticket || !opts.base) fail('verify requires --ticket and --base (or --cmd for a flake probe)');
      try { emit(await verify({ id: opts.ticket!, dir: opts.dir, base: opts.base! })); }
      catch (e: any) { fail(e.message); }
    });

  mechanic('vet')
    .description("the pre-dispatch vacuity measurement: which of a ticket's acceptance checks already pass on the base")
    .requiredOption('--ticket <id>', 'the ticket about to be dispatched')
    .option('--dir <path>', 'the checkout to measure in', '.')
    .action(async (opts: { ticket: string; dir: string }) => {
      assertSkillSeat();
      try { emit(await vet({ id: opts.ticket, dir: opts.dir })); }
      catch (e: any) { fail(e.message); }
    });

  mechanic('gate-run')
    .description('run the campaign gate on the merged tree and stamp its own verdict — refuses off-mainline or a dirty tree')
    .option('--dir <path>', 'the checkout to measure in', '.')
    .action(async (opts: { dir: string }) => {
      assertSkillSeat();
      try { emit(await runGate({ dir: opts.dir })); }
      catch (e: any) { fail(e.message); }
    });

  // The two check tiers get amendment verbs of their own, rather than leaving the
  // coordinator to reach the writer's `gate` / `fast-checks` commands directly,
  // because each tier's amendment rule is enforcement the writer does not carry.
  // `backlog gate` will happily replace a live command for anyone who asks; the
  // rule that only a red gate's own recovery may do so lives here. And the fast
  // tier's rule is a measurement — every candidate must exit 0 on the mainline —
  // which is not something a coordinator can honestly attest to having done.
  mechanic('dispatch')
    .description("everything one worker dispatch needs, in one call: vet the base, cut the branch, stamp in-flight, resolve the ladder rung, render the prompt")
    .requiredOption('--ticket <id>', 'the dispatchable ticket')
    .requiredOption('--context <text>', 'the one variable no verb can derive: what THIS worker needs to know ("-" reads stdin)')
    .option('--dir <path>', 'the checkout to measure in', '.')
    .option('--accept-vacuous', 'proceed although some acceptance checks already pass on the base — only for a ticket that legitimately adds proof for shipped behaviour')
    .option('--schema-out <file>', 'also write the worker output schema here, for codex --output-schema')
    .action(async (opts: { ticket: string; context: string; dir: string; acceptVacuous?: boolean; schemaOut?: string }) => {
      assertSkillSeat();
      const context = opts.context === '-' ? await stdinText() : opts.context;
      try {
        const plan = await dispatch({ id: opts.ticket, context, dir: opts.dir, acceptVacuous: !!opts.acceptVacuous });
        if (opts.schemaOut) writeSchema(plan.schema, opts.schemaOut);
        emit(opts.schemaOut ? { ...plan, schemaPath: opts.schemaOut } : plan);
      } catch (e: any) { fail(e.message); }
    });

  mechanic('bisect')
    .description('find the earliest landing at which a command was already red — binary search over closed tickets\' branches, HEAD restored to mainline whatever happens')
    .requiredOption('--cmd <cmd>', 'the failing check, verbatim')
    .option('--dir <path>', 'the checkout to measure in', '.')
    .action(async (opts: { cmd: string; dir: string }) => {
      assertSkillSeat();
      try { emit(await bisect({ cmd: opts.cmd, dir: opts.dir })); }
      catch (e: any) { fail(e.message); }
    });

  mechanic('gate-amend')
    .description("amend the campaign gate under the authority its anomaly grants (checks on stdin)")
    .requiredOption('--by <who>', 'the arm proposing the amendment, for the audit record')
    .requiredOption('--note <why>', 'the rationale — the record is worthless without it')
    .requiredOption('--anomaly <kind>', `the anomaly being answered; only \`${GATE_RED}\` may replace a live command`)
    .action(async (opts: { by: string; note: string; anomaly: string }) => {
      const checks = await stdinJson();
      if (!Array.isArray(checks)) fail('gate-amend takes an array of {name, cmd} on stdin');
      assertSkillSeat();
      try {
        emit({
          authority: gateAuthority(opts.anomaly),
          result: amendGate(checks as Check[], {
            by: opts.by, note: opts.note, replacements: gateAuthority(opts.anomaly),
          }),
        });
      } catch (e: any) { fail(e.message); }
    });

  mechanic('fastcheck-amend')
    .description('amend the fast tier, admitting only candidates that exit 0 on the mainline (checks on stdin)')
    .requiredOption('--by <who>', 'the arm proposing the amendment, for the audit record')
    .requiredOption('--note <why>', 'the rationale — the record is worthless without it')
    .action(async (opts: { by: string; note: string }) => {
      const checks = await stdinJson();
      if (!Array.isArray(checks)) fail('fastcheck-amend takes an array of {name, cmd} on stdin');
      assertSkillSeat();
      try { emit({ result: await amendFastChecks(checks as Check[], { by: opts.by, note: opts.note }) }); }
      catch (e: any) { fail(e.message); }
    });

  const branch = mechanic('branch')
    .description('the serial checkout lifecycle: create attach discard land delete');

  branch
    .command('create')
    .description('cut the ticket branch from mainline and check it out — refuses off-mainline or unclean trees')
    .argument('<id>', 'ticket id')
    .action((id: string) => {
      assertSkillSeat();
      try { emit(createBranch(id)); } catch (e: any) { fail(e.message); }
    });

  branch
    .command('attach')
    .description('check a surviving branch back out (resume); null when the branch is gone')
    .argument('<id>', 'ticket id')
    .action((id: string) => {
      assertSkillSeat();
      try { emit(attachBranch(id)); } catch (e: any) { fail(e.message); }
    });

  branch
    .command('discard')
    .description('erase worker litter and return the checkout to mainline, keeping the branch (bisection needs it until the gate is green)')
    .action(() => {
      assertSkillSeat();
      try { emit(discardCheckout()); } catch (e: any) { fail(e.message); }
    });

  branch
    .command('land')
    .description('return to mainline and fast-forward it onto the ticket branch; a non-ff result is interference, classified not resolved')
    .argument('<id>', 'ticket id')
    .action((id: string) => { assertSkillSeat(); emit(landBranch(id)); });

  branch
    .command('delete')
    .description('reap a landed branch once the campaign gate is green')
    .argument('<id>', 'ticket id')
    .action((id: string) => { assertSkillSeat(); deleteBranch(id); emit({ deleted: id }); });

  const jurisdiction = mechanic('jurisdiction')
    .description("recover's enforced product-code boundary: snapshot before it runs, revert after");

  jurisdiction
    .command('snapshot')
    .description('record the checkout recover is about to be trusted with')
    .requiredOption('--out <file>', 'where to persist the snapshot')
    .action((opts: { out: string }) => {
      assertSkillSeat();
      try {
        const snapshot = snapshotTree();
        fs.writeFileSync(opts.out, JSON.stringify(snapshot, null, 2) + '\n');
        emit(snapshot);
      } catch (e: any) { fail(e.message); }
    });

  jurisdiction
    .command('revert')
    .description('undo any tracked, non-manifest file the run changed; run it BEFORE reading the verdict')
    .requiredOption('--in <file>', 'the snapshot taken before the run')
    .action((opts: { in: string }) => {
      assertSkillSeat();
      emit(revertOutOfBounds(readJsonFile(opts.in) as TreeSnapshot));
    });

  mechanic('postmortem')
    .description('render the journal as a self-contained HTML archive — do this before campaign state is deleted')
    .requiredOption('--out <path>', 'where to write the HTML')
    // A campaign that ran in a devcontainer left its transcripts in the
    // container's projects tree, not this host's — the time split is otherwise
    // silently unavailable to a render done from outside. Point at that tree
    // (a copy of `<vol>/projects/<slug>`) and the split comes back.
    .option('--transcripts <dir>', 'projects dir holding the run\'s subagent transcripts (default: this host\'s ~/.claude/projects/<cwd>)')
    .action((opts: { out: string; transcripts?: string }) => {
      try { emit(writePostmortem(opts.out, opts.transcripts)); } catch (e: any) { fail(e.message); }
    });

  mechanic('learn')
    .description('merge a harvest into .ailoop/learnings/ — evidence counts, staleness eviction, size cap')
    .requiredOption('--campaign <name>', 'the campaign being harvested')
    .option('--in <file>', 'harvest JSON {checks?, flakes?}; stdin when omitted')
    .action(async (opts: { campaign: string; in?: string }) => {
      assertSkillSeat();
      const harvest = opts.in ? readJsonFile(opts.in) : await stdinJson();
      if (harvest === undefined) fail('learn needs a harvest: --in <file>, or JSON on stdin');
      emit(mergeLearnings({ harvest: harvest as Harvest, campaign: opts.campaign }));
    });

  mechanic('prompt')
    .description('the role prompt this program would use — the judgment layer, shared so only the seat differs')
    .argument('<role>', 'kickoff | decompose | worker | review | sweep | recover | coverage | harvest')
    .option('--vars <file>', 'JSON of {{placeholder}} values ("-" reads stdin); raw template when omitted')
    .action(async (role: string, opts: { vars?: string }) => {
      try {
        if (!opts.vars) { console.log(rawPrompt(role)); return; }
        const vars = opts.vars === '-' ? await stdinJson() : readJsonFile(opts.vars);
        console.log(renderPrompt(role, (vars ?? {}) as Record<string, unknown>));
      } catch (e: any) { fail(e.message); }
    });

  mechanic('schema')
    .description("the role's output contract — what its agent must return for the verdict to be legal")
    .argument('<role>', 'kickoff | decompose | worker | review | sweep | recover | coverage | harvest')
    // Codex's --output-schema is OpenAI strict mode: it rejects the optional keys
    // our canonical schemas carry. The adaptation lives at the codex perimeter
    // already, so serve it from there rather than describing it in prose.
    .option('--engine <name>', 'claude (canonical) | codex (strict-mode adapted)', 'claude')
    .action((role: string, opts: { engine: string }) => {
      const schema = SCHEMAS[role];
      if (!schema) fail(`unknown role: ${role} — roles: ${Object.keys(SCHEMAS).sort().join(', ')}`);
      if (opts.engine !== 'claude' && opts.engine !== 'codex') fail(`--engine must be claude or codex, got ${opts.engine}`);
      emit(opts.engine === 'codex' ? strictify(schema) : schema);
    });

  mechanic('models')
    .description('the model preference chain per role — the worker chain doubles as its escalation ladder')
    .argument('[role]', 'resolve one role to engine + CLI model + availability; omitted prints every chain')
    .action((role?: string) => {
      if (!role) { emit(MODELS); return; }
      try { emit(resolvedChain(role)); } catch (e: any) { fail(e.message); }
    });

}
