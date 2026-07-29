// The mechanics surface — every measurement and bookkeeping step of a campaign,
// reachable as a verb by a coordinator that is not this program.
//
// loop carries two coordinators for one architecture: this program's
// deterministic drive loop, and the `ailoop` skill's model sitting in the same
// seat. Which seat drives a spec better is the open question both exist to
// answer, and that answer is only legible if the seat is the ONLY difference
// between them. A skill with its own backlog writer and its own scope check
// measures its mechanics against ours — a file list against `modules`, an
// unprovisioned worktree against a provisioned one — and then reports the delta
// as a fact about judgment. So the mechanics are shared, and this file is the
// door the other seat comes through.
//
// Two properties follow from that other seat being a conversation rather than a
// process, and neither is a preference:
//
//   • No coordinator lock. A model in the seat cannot hold `coordinator.pid`
//     across separate verb invocations, so these verbs never take it. What keeps
//     the two seats off one campaign is the producer stamp instead: whoever ran
//     `init` owns the campaign until it closes, and each side refuses the
//     other's (see assertSkillSeat, and establishCampaign in campaign/index.ts).
//   • stdout carries a result, never narration. The caller parses stdout, so the
//     live commentary steps aside to stderr before any verb body runs.
//
// Verbs that only read (frontier, postmortem) are open to either seat: they are
// how a finished campaign gets compared with its twin.

import fs from 'node:fs';
import type { Command } from 'commander';
import { backlog, backlogWrite, campaignExists } from './campaign/backlog.ts';
import { frontier } from './campaign/frontier.ts';
import { verify, flakeProbe } from './campaign/verify.ts';
import { provision } from './campaign/provision.ts';
import { snapshotTree, revertOutOfBounds } from './campaign/jurisdiction.ts';
import type { TreeSnapshot } from './campaign/jurisdiction.ts';
import { writePostmortem } from './campaign/postmortem.ts';
import { mergeLearnings } from './campaign/learn.ts';
import type { Harvest } from './campaign/learn.ts';
import { createWorktree, attachWorktree, removeWorktree, deleteBranch, mergeBranch } from './campaign/worktree.ts';
import { rawPrompt, renderPrompt } from './campaign/agents/run.ts';
import { SCHEMAS } from './campaign/agents/schemas.ts';
import { MODELS, resolvedChain } from './campaign/agents/models.ts';
import { strictify } from './agent/engines/codex.ts';
import { narrateToStderr } from './runtime/reporting.ts';

const fail = (msg: string): never => { console.error(msg); process.exit(1); };

const emit = (value: unknown): void => { console.log(JSON.stringify(value, null, 2)); };

// A mechanics verb is the skill's hand. This program's own drive calls these
// modules in-process, never through argv, so an argv mutation aimed at a
// cli-stamped campaign is one seat reaching into the other's work — with a
// diverged ticket schema and no lock between them. Refuse before the write.
function assertSkillSeat(): void {
  if (!campaignExists()) return; // `init` legitimately runs before one exists
  if ((backlog().coordinator ?? 'cli') === 'cli')
    fail('this campaign was started by `loop campaign` (coordinator: cli) — the two seats never share a campaign in flight. Finish it with `loop resume`, or start a skill campaign in a repository without one.');
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
  const registered: Command[] = [];
  const mechanic = (name: string): Command => {
    const cmd = program.command(name);
    registered.push(cmd);
    return cmd;
  };

  mechanic('backlog')
    .description('the sole writer: init seed add update fast-checks gate gate-run gate-park set-status attempt close decompose recover-resolution sweep-run note')
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
    .description('the derived scheduler facts: problems, ready, dispatchable, walls, coverage')
    .action(() => { emit(frontier()); });

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

  // One hook rather than a line in every action: these verbs own stdout, and
  // `loop campaign` — which does not — must keep narrating to it.
  const names = new Set(registered.map(cmd => cmd.name()));
  program.hook('preSubcommand', (_parent, sub) => { if (names.has(sub.name())) narrateToStderr(); });
}
