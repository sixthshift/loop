// The live-process window — what a running check looks like to a dashboard that
// cannot talk to the process running it.
//
// This exists because of who drives now. The coordinator is a model in a
// conversation, and it learns about a check the way any caller does: it invokes
// `loop verify`, waits, and reads the result. It never sees the stream. So a
// dashboard asking the coordinator "what is the test suite printing right now"
// is asking the one participant that structurally cannot know — while the verb
// holding the child process can, and is already the thing being watched.
//
// So the verb writes its own window here and deletes it on the way out. Files
// rather than a socket because the reader is a separate process that may start
// after the writer, restart mid-run, or never attach at all: a dashboard opened
// two minutes into a gate should see the gate, and none of that should be the
// verb's problem.
//
// Two properties the reader depends on:
//
//   • Every write is tmp+rename, like the backlog's. A reader polling a file the
//     writer is mid-append to would otherwise parse a truncated line and treat a
//     torn read as a malformed process.
//   • The pid is in the payload, so a crashed verb's leftover file is
//     recognizable as leftover. Nothing here is cleaned up on a crash by
//     definition — the process that would do the cleaning is the one that died.

import fs from 'node:fs';
import path from 'node:path';
import { RUN } from './paths.ts';

export const LIVE = path.join(RUN, 'live');

// A check the operator can watch: what is running, since when, and the tail of
// what it has said. `partial` holds a chunk that hasn't hit a newline yet —
// progress bars and prompts live there, and dropping it would make a suite that
// redraws one line look silent.
export type LiveRun = {
  label: string;
  cmd: string;
  startedAt: number;
  pid?: number;
  ticketId?: string;
  tail: { ts: number; line: string }[];
  partial: string;
};

// Enough tail to fill a detail pane, not enough to make the file a log. The
// journal is the record; this is a window.
const TAIL_KEEP = 60;

// A chatty suite writes thousands of lines. The dashboard needs ~2fps, so the
// file is rewritten on a timer rather than per chunk — otherwise a test run's
// stdout becomes a stream of fs writes that outnumber the lines it produced.
const FLUSH_MS = 250;

const runs = new Map<string, { run: LiveRun; timer: ReturnType<typeof setTimeout> | null }>();

// One file per label, and the label decides the name, so a filesystem-hostile
// label (`verify:T007 · typecheck`) can't produce a path that quietly fails to
// write on some platform and silently blanks the pane.
const fileFor = (label: string): string =>
  path.join(LIVE, `${label.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`);

function flush(label: string): void {
  const entry = runs.get(label);
  if (!entry) return;
  entry.timer = null;
  const file = fileFor(label);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(LIVE, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(entry.run));
    fs.renameSync(tmp, file);
  } catch {
    // The window is inessential by construction: it annotates a check, and a
    // check that fails because its progress file couldn't be written would be
    // the annotation breaking the thing it annotates.
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
  }
}

const schedule = (label: string): void => {
  const entry = runs.get(label);
  if (!entry || entry.timer) return;
  entry.timer = setTimeout(() => flush(label), FLUSH_MS);
};

export function liveStart(label: string, cmd: string, ticketId?: string): void {
  runs.set(label, {
    run: { label, cmd, startedAt: Date.now(), ticketId, tail: [], partial: '' },
    timer: null,
  });
  flush(label); // immediately: a check that produces no output for a minute still exists
}

export function livePid(label: string, pid: number | undefined): void {
  const entry = runs.get(label);
  if (!entry) return;
  entry.run.pid = pid;
  flush(label);
}

// Raw stdout/stderr chunk, reassembled into lines across chunk boundaries — a
// chunk rarely ends on a newline, and splitting per chunk would shred every line
// that straddles one.
export function liveData(label: string, chunk: string): void {
  const entry = runs.get(label);
  if (!entry) return;
  const lines = (entry.run.partial + chunk).split('\n');
  entry.run.partial = lines.pop() ?? '';
  for (const line of lines) if (line.length) entry.run.tail.push({ ts: Date.now(), line });
  if (entry.run.tail.length > TAIL_KEEP) entry.run.tail.splice(0, entry.run.tail.length - TAIL_KEEP);
  schedule(label);
}

export function liveEnd(label: string): void {
  const entry = runs.get(label);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  runs.delete(label);
  try { fs.unlinkSync(fileFor(label)); } catch { /* never written, or already reaped */ }
}

// What a reader sees. Files whose writer is gone are dropped rather than shown
// as running: a verb killed mid-check leaves its window behind, and a dashboard
// reporting a dead process as live is the specific lie this whole surface exists
// to avoid. A file with no pid yet is kept — that is the gap between spawn and
// the first flush, not a dead process.
export function liveRuns(): LiveRun[] {
  let names: string[];
  try { names = fs.readdirSync(LIVE); } catch { return []; }
  const out: LiveRun[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const run = JSON.parse(fs.readFileSync(path.join(LIVE, name), 'utf8')) as LiveRun;
      if (run.pid === undefined || alive(run.pid)) out.push(run);
    } catch { /* mid-rename or malformed — the next poll gets it */ }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  // EPERM proves the process exists and belongs to someone else, which on a
  // shared checkout is still a live check.
  catch (error: any) { return error.code === 'EPERM'; }
};
