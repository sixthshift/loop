// Display composition boundary. This is the one module that joins generic live
// reporting to the campaign-aware Ink dashboard; keeping the mount here means
// runtime/reporting.ts never points back into campaign or UI code.

import {
  beginReporting,
  endReporting,
  interactive,
  store,
} from '../runtime/reporting.ts';

let app: { unmount(): void } | null = null;
let signalInstalled = false;

export function start(): void {
  if (store.startedAt) return;
  beginReporting();
  if (!signalInstalled) {
    signalInstalled = true;
    process.on('SIGTERM', () => { stop(); process.exit(130); });
  }
  if (!interactive) return;

  process.stdout.write('\x1b[?1049h'); // alt screen; Ink manages the cursor
  // Dynamic so the non-TTY path never loads Ink. The stopped-already guard
  // covers fast exits that race the import.
  import('./dashboard.tsx').then(module => {
    if (store.startedAt) app = module.mount();
  }).catch(error => {
    process.stdout.write('\x1b[?1049l');
    console.error(`dashboard failed to mount, continuing headless: ${error.message}`);
  });
}

export function stop(): void {
  if (app) {
    app.unmount();
    app = null;
  }
  if (interactive && store.startedAt) process.stdout.write('\x1b[?1049l\x1b[?25h');
  endReporting();
}
