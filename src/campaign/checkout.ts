// What every verb needs to know about the working checkout before it measures
// anything: which branch HEAD is on, and what is lying in the tree that git
// history doesn't explain.
//
// Both questions were answered independently in six and four places
// respectively, with the same two shell commands and the same `.ailoop/`
// exclusion re-typed each time. That is not a style problem: the exclusion is a
// rule — the campaign's own state is never the operator's dirt — and a rule
// spelled out per caller is one a later caller spells differently. The same goes
// for the mainline refusal, whose four copies differed only in the sentence
// after the dash.
//
// So the sentence after the dash is the parameter. Each caller still says why
// its own measurement needs mainline, because those reasons are genuinely
// different and each is the thing the reader needs; what they no longer own is
// the comparison, the detached-HEAD spelling, or the wording of the refusal.
//
// The two callers that do NOT throw — `branch create` reports its refusal as a
// value, `verify` reports a dirty tree as a failing check — take the primitives
// and keep their own shape. Their answer to a dirty tree is part of their
// contract, not a guard they can delegate.

import { sh } from './state.ts';
import { mainline } from './backlog.ts';

// The branch HEAD is on; '' when detached, which every caller renders rather
// than branching on, since a detached HEAD is never a state any of them accept.
export const currentRef = (): string => sh('git symbolic-ref --short -q HEAD').stdout.trim();

// Refuse to measure anywhere but the recorded mainline, and return it.
//
// `why` is what this particular measurement loses by running off it — the whole
// point of the refusal, since the failure it prevents is silent in every case: a
// verdict about a ticket branch reads exactly like a verdict about the merged
// tree. `verb` is the caller's CLI name, so the message names the command the
// operator actually typed.
export function assertOnMainline(verb: string, why: string): string {
  const main = mainline();
  const at = currentRef();
  if (at !== main)
    throw new Error(`${verb}: HEAD is on ${at || '(detached)'}, not ${main} — ${why}`);
  return main;
}

// Porcelain lines for everything in the tree git history doesn't explain, minus
// the campaign's own state.
//
// The exclusion is the rule this function exists to keep in one place: a
// coordinator writing backlog.json and a journal entry mid-ticket is the loop
// working, not the operator leaving a mess, and a verb that counted it would
// refuse every measurement it was asked to make.
export const dirtyLines = (dir = '.'): string[] =>
  sh('git status --porcelain', dir).stdout.split('\n')
    .filter(l => l.trim() && !l.slice(3).startsWith('.ailoop/'));

// The same reading as one block of text, for the callers that put it in a
// refusal message rather than acting on the paths.
export const dirtyText = (dir = '.'): string => dirtyLines(dir).join('\n').trim();
