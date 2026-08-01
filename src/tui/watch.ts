// `loop watch` — the dashboard as its own process.
//
// It owns nothing and holds nothing: no lock, no campaign state, no child
// processes. That is what lets it be started, killed, and restarted at any point
// in a campaign it has no part in, including before one exists and after it ends.
// Run it in a second pane beside the session that is driving.
//
// The mount lives here rather than in the dashboard because the terminal
// handshake — alternate screen in, alternate screen out, whatever happens in
// between — is this file's whole job, and it has to be honored on every exit path
// or it leaves the operator's shell in a broken state.

import { campaignExists } from '../campaign/backlog.ts';
import { renderProgress } from '../campaign/progress.ts';

export async function runWatch(): Promise<void> {
  // A pipe or a CI log wants one rendering, not an interactive frame that redraws
  // forever into a file. `status` is exactly that rendering, so defer to it rather
  // than growing a second non-interactive mode here.
  if (!process.stdout.isTTY) {
    console.log(renderProgress());
    return;
  }

  if (!campaignExists()) {
    // Not an error: a watcher opened before kickoff is the normal way to see one
    // happen. But say so, because an empty dashboard and a broken dashboard look
    // the same for the first few seconds.
    console.log('no campaign in .ailoop/campaign yet — watching for one to appear.');
  }

  process.stdout.write('\x1b[?1049h'); // alt screen; Ink manages the cursor
  const restore = () => process.stdout.write('\x1b[?1049l\x1b[?25h');

  // Dynamic so a non-TTY run never loads Ink at all.
  const { mount } = await import('./dashboard.tsx');
  const app = mount();

  // Every exit path restores the terminal: a clean unmount, a signal, and a crash
  // inside a render. Ink's own exit handling covers the first; the other two are
  // why this is wired explicitly rather than left to a finally block.
  process.on('SIGTERM', () => { restore(); process.exit(130); });
  process.on('SIGHUP', () => { restore(); process.exit(130); });
  try {
    await app.waitUntilExit();
  } finally {
    restore();
  }
}
