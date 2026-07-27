#!/usr/bin/env bun
// Release build: one self-contained binary per platform, plus the checksum file
// install.sh verifies its download against. Output names are what install.sh
// derives from `uname -sm`, so renaming one here breaks the installer there.
//
// This uses the Bun.build() JS API rather than `bun build --compile` because the
// devtools stub below is a plugin, and the CLI cannot take one.

import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { version } from './package.json' with { type: 'json' };

const OUT = 'dist';

const TARGETS = [
  { target: 'bun-darwin-arm64', name: 'loop-darwin-arm64' },
  { target: 'bun-darwin-x64', name: 'loop-darwin-x64' },
  { target: 'bun-linux-x64', name: 'loop-linux-x64' },
  { target: 'bun-linux-arm64', name: 'loop-linux-arm64' },
] as const;

// ink's reconciler statically imports `react-devtools-core` behind a
// `process.env.DEV === 'true'` runtime guard, and the bundler follows that import
// graph regardless of the guard — so a compiled binary dies at startup with
// `Cannot find package 'react-devtools-core'` before ink's guard ever runs.
// Resolving the specifier to an inert stub is the only fix that holds: marking it
// external fails the same way (externals resolve at bundle init), and defining
// DEV=false fails too (the graph is walked before dead-code elimination).
const stubDevtools: Bun.BunPlugin = {
  name: 'stub-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'rdc', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} };',
      loader: 'js',
    }));
  },
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const sums: string[] = [];

for (const { target, name } of TARGETS) {
  const outfile = path.join(OUT, name);
  const built = await Bun.build({
    entrypoints: ['src/index.ts'],
    plugins: [stubDevtools],
    compile: { target, outfile },
  });
  // A partial dist is worse than none: install.sh would checksum-verify a
  // binary that was never built for the platform claiming it.
  if (!built.success) {
    for (const l of built.logs) console.error(l);
    throw new Error(`build failed for ${target}`);
  }

  const bytes = await Bun.file(outfile).bytes();
  sums.push(`${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}  ${name}`);
  console.log(`${name}  ${(bytes.length / 1024 / 1024).toFixed(0)} MB`);
}

await Bun.write(path.join(OUT, 'sha256sums.txt'), `${sums.join('\n')}\n`);
console.log(`\nloop ${version} → ${OUT}/ (${TARGETS.length} binaries + sha256sums.txt)`);
