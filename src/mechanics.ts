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
//   • No coordinator lock. A model in the seat cannot hold `coordinator.pid`
//     across separate verb invocations, so these verbs never take it. Nothing
//     stops two coordinators from opening one campaign except the producer stamp
//     (see assertSkillSeat) and the fact that a human is watching.
//   • stdout carries a result, never narration. The caller parses stdout, so
//     commentary goes to stderr — see runtime/narrate.ts, where that is now
//     structural rather than a mode.

import fs from 'node:fs';
import type { Command } from 'commander';
import { backlog, backlogWrite, campaignExists, renumber } from './campaign/backlog.ts';
import { frontier } from './campaign/frontier.ts';
import type { Check, TicketDraft } from './campaign/agents/schemas.ts';
import { amendGate, gateAuthority, GATE_RED } from './campaign/gate.ts';
import { amendFastChecks } from './campaign/fastcheck.ts';
import { recoveryBudget } from './campaign/recovery-budget.ts';
import { verify, flakeProbe } from './campaign/verify.ts';
import { provision } from './campaign/provision.ts';
import { snapshotTree, revertOutOfBounds } from './campaign/jurisdiction.ts';
import type { TreeSnapshot } from './campaign/jurisdiction.ts';
import { writePostmortem } from './campaign/postmortem.ts';
import { mergeLearnings } from './campaign/learn.ts';
import type { Harvest } from './campaign/learn.ts';
import { createWorktree, attachWorktree, removeWorktree, deleteBranch, mergeBranch } from './campaign/worktree.ts';
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
function assertSkillSeat(): void {
  if (!campaignExists()) return; // `init` legitimately runs before one exists
  if ((backlog().coordinator ?? 'cli') === 'cli')
    fail('this campaign was opened by `loop campaign` (coordinator: cli), the deterministic drive loop, which was removed. Nothing here can continue it: archive `.ailoop/campaign/` with `loop postmortem --out <file>` and start fresh, or install the last release that still had that seat (v0.5.0).');
}

// Commands that take a JSON payload read it from stdin, so a coordinator can
// pipe tickets in without staging a temp file it then has to clean up.
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
    .description('the sole writer: init seed add update fast-checks gate gate-run gate-park set-status phase attempt close decompose recover-resolution sweep-run note')
    .argument('<args...>', 'the writer command and its flags; JSON payloads arrive on stdin')
    // passThroughOptions keeps commander's hands off the writer's own flags — the
    // writer parses them itself, and its vocabulary must not need mirroring here
    // to stay reachable.
    .passThroughOptions()
    .allowUnknownOption()
    .action(async (args: string[]) => {
      const input = await stdinJson();
      assertSkillSeat();
      try { console.log(backlogWrite(args, input)); }
      catch (e: any) { fail(e.message); }
    });

  mechanic('frontier')
    .description('the derived scheduler facts: problems, ready, dispatchable, walls, gate freshness, coverage')
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
    .description('measure a worker branch (--ticket --dir --base), or probe one command for flake (--cmd --dir)')
    .option('--ticket <id>', 'ticket to verify, or to label a flake probe')
    .option('--dir <path>', 'the worktree to measure in')
    .option('--base <sha>', 'the sha the worktree was cut from')
    .option('--cmd <cmd>', 'flake-probe mode: the single command to repeat')
    .option('--repeat <n>', 'flake-probe repetitions', '5')
    .action(async (opts: { ticket?: string; dir?: string; base?: string; cmd?: string; repeat: string }) => {
      if (!opts.dir) fail('verify requires --dir <worktree>');
      if (opts.cmd) {
        emit(await flakeProbe({ cmd: opts.cmd, dir: opts.dir!, repeat: Number(opts.repeat), id: opts.ticket }));
        return;
      }
      if (!opts.ticket || !opts.base) fail('verify requires --ticket and --base (or --cmd for a flake probe)');
      try { emit(await verify({ id: opts.ticket!, dir: opts.dir!, base: opts.base! })); }
      catch (e: any) { fail(e.message); }
    });

  // The two check tiers get amendment verbs of their own, rather than leaving the
  // coordinator to reach the writer's `gate` / `fast-checks` commands directly,
  // because each tier's amendment rule is enforcement the writer does not carry.
  // `backlog gate` will happily replace a live command for anyone who asks; the
  // rule that only a red gate's own recovery may do so lives here. And the fast
  // tier's rule is a measurement — every candidate must exit 0 on the mainline —
  // which is not something a coordinator can honestly attest to having done.
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

  const worktree = mechanic('worktree')
    .description('worker checkout lifecycle: add attach remove merge delete-branch');

  worktree
    .command('add')
    .description('cut a worktree outside the repository and copy the installed dependency trees in')
    .argument('<id>', 'ticket id')
    .action(async (id: string) => {
      assertSkillSeat();
      try {
        const cut = createWorktree(id);
        emit({ ...cut, provision: await provision(id, cut.dir) });
      } catch (e: any) { fail(e.message); }
    });

  worktree
    .command('attach')
    .description('rebuild a worktree from a surviving branch (resume); null when the branch is gone')
    .argument('<id>', 'ticket id')
    .action((id: string) => {
      assertSkillSeat();
      try { emit(attachWorktree(id)); } catch (e: any) { fail(e.message); }
    });

  worktree
    .command('remove')
    .description('drop the worktree, keeping the branch (bisection needs it until the gate is green)')
    .argument('<id>', 'ticket id')
    .action((id: string) => { assertSkillSeat(); removeWorktree(id); emit({ removed: id }); });

  worktree
    .command('merge')
    .description('land the branch on mainline, fast-forwarding when its base is still the tip')
    .argument('<id>', 'ticket id')
    .action((id: string) => { assertSkillSeat(); emit(mergeBranch(id)); });

  worktree
    .command('delete-branch')
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
      const snapshot = snapshotTree();
      fs.writeFileSync(opts.out, JSON.stringify(snapshot, null, 2) + '\n');
      emit(snapshot);
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
    .action((opts: { out: string }) => {
      try { emit(writePostmortem(opts.out)); } catch (e: any) { fail(e.message); }
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
