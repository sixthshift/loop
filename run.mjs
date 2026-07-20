// Campaign state access — reads and script execution against .ailoop/run/.
// All mutations go through backlog-write.mjs (the sole writer); this module
// never touches backlog.json or journal.jsonl directly except to read.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RUN = '.ailoop/run';
export const LEARNINGS = '.ailoop/learnings';
export const WORKTREES = '.ailoop/worktrees';
// The skill's templates are the shared substrate — one source of truth for
// the mechanical scripts, two coordinators (skill and this one) driving them.
export const TEMPLATES = fileURLToPath(new URL('../claude/skills/ailoop/templates/', import.meta.url));

export function sh(cmd, cwd = '.') {
  return spawnSync('bash', ['-lc', cmd], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// For measurements that run minutes (verify, gates): keeps the event loop —
// and therefore the live display — breathing while a test suite grinds.
export function shAsync(cmd, cwd = '.') {
  return new Promise(resolve => {
    const child = spawn('bash', ['-lc', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.on('error', e => resolve({ status: 127, stdout, stderr: String(e) }));
  });
}

export function campaignExists() {
  return fs.existsSync(path.join(RUN, 'backlog.json'));
}

export function backlog() {
  return JSON.parse(fs.readFileSync(path.join(RUN, 'backlog.json'), 'utf8'));
}

export function ticket(id) {
  const t = backlog().tickets.find(x => x.id === id);
  if (!t) throw new Error(`no ticket ${id}`);
  return t;
}

// Parsed-journal cache keyed on size+mtime: the dashboard re-renders many
// times a second while agents stream, and an append-only jsonl only needs
// re-parsing when it actually grew.
let journalCache = { key: '', entries: [] };

export function journalEntries() {
  const file = path.join(RUN, 'journal.jsonl');
  if (!fs.existsSync(file)) return [];
  const st = fs.statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  if (journalCache.key !== key) {
    journalCache = { key, entries: fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) };
  }
  return journalCache.entries;
}

export function journalTail(n = 40) {
  return journalEntries().slice(-n);
}

export function frontier() {
  const r = sh(`node ${path.join(RUN, 'frontier.mjs')}`);
  if (r.status !== 0) throw new Error(`frontier.mjs failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// One command against the sole writer. `input` (object|array) is piped as
// stdin JSON for commands that take a payload. Throws with the script's
// refusal text — callers decide whether a refusal is a bug or a triage case.
export function backlogWrite(args, input) {
  const argv = ['node', path.join(RUN, 'backlog-write.mjs'), ...args];
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    input: input === undefined ? undefined : JSON.stringify(input),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`backlog-write ${args[0]} REFUSED: ${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
}

export async function verify({ id, dir, base }) {
  const r = await shAsync(`node ${path.join(process.cwd(), RUN, 'verify.mjs')} --ticket ${id} --dir ${dir} --base ${base} --run ${path.join(process.cwd(), RUN)}`);
  return JSON.parse(r.stdout);
}

export async function flakeProbe({ cmd, dir, repeat = 5 }) {
  const quoted = cmd.replace(/'/g, `'\\''`);
  const r = await shAsync(`node ${path.join(process.cwd(), RUN, 'verify.mjs')} --cmd '${quoted}' --repeat ${repeat} --dir ${dir} --run ${path.join(process.cwd(), RUN)}`);
  return JSON.parse(r.stdout);
}

// Single-coordinator lock. backlog-write.mjs validates transitions but has
// no lock — two coordinators interleaving writes on one campaign is silent
// corruption, so the second one must refuse to start.
const PIDFILE = () => path.join(RUN, 'coordinator.pid');

export function lockHolder() {
  if (!fs.existsSync(PIDFILE())) return null;
  const pid = parseInt(fs.readFileSync(PIDFILE(), 'utf8'), 10);
  if (!pid || pid === process.pid) return null;
  try { process.kill(pid, 0); return pid; }   // alive → held
  catch { return null; }                       // stale → claimable
}

export function acquireLock() {
  fs.writeFileSync(PIDFILE(), String(process.pid));
  process.on('exit', () => {
    try {
      if (parseInt(fs.readFileSync(PIDFILE(), 'utf8'), 10) === process.pid) fs.unlinkSync(PIDFILE());
    } catch { /* run/ already deleted at campaign close */ }
  });
}

export function nextTicketIds(n) {
  const used = new Set(backlog().tickets.map(t => t.id));
  const out = [];
  for (let i = 1; out.length < n; i++) {
    const id = `T${String(i).padStart(3, '0')}`;
    if (!used.has(id)) { out.push(id); used.add(id); }
  }
  return out;
}

export function specSha(specPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(specPath)).digest('hex');
}

export function readLearnings() {
  if (!fs.existsSync(LEARNINGS)) return null;
  const facets = {};
  for (const f of fs.readdirSync(LEARNINGS)) {
    facets[f] = fs.readFileSync(path.join(LEARNINGS, f), 'utf8');
  }
  return Object.keys(facets).length ? facets : null;
}
