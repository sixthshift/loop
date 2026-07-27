// `loop update` — replace this binary in place with the latest release.
//
// Native rather than piping the remote install.sh back through bash: the running
// binary already knows its own path, so it upgrades where it actually lives
// rather than assuming ~/.local/bin, and it can answer "already current" without
// first downloading 90 MB. The cost is that download-then-verify exists twice,
// here and in install.sh — they serve different moments (no binary yet vs. a
// binary that can speak for itself), and neither can call the other.

import { chmod, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { version } from '../package.json' with { type: 'json' };

const REPO = 'sixthshift/loop';

// Only the platforms the release workflow builds. Anything else has no asset to
// fetch, and naming the platform beats a 404 on a guessed filename.
function releaseAsset(): string {
  const os = process.platform === 'darwin' || process.platform === 'linux' ? process.platform : null;
  const arch = process.arch === 'arm64' || process.arch === 'x64' ? process.arch : null;
  if (!os || !arch) {
    throw new Error(`no prebuilt binary for ${process.platform}-${process.arch} — build from source: https://github.com/${REPO}`);
  }
  return `loop-${os}-${arch}`;
}

async function latestTag(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `loop/${version}` },
  });
  // 404 here is "nothing published yet", not "unreachable" — the two send the
  // user to completely different places, so they don't share a message.
  if (res.status === 404) throw new Error(`${REPO} has no published releases yet`);
  if (!res.ok) throw new Error(`could not reach the GitHub release API (${res.status} ${res.statusText})`);
  const tag = ((await res.json()) as { tag_name?: string }).tag_name;
  if (!tag) throw new Error('the latest release carries no tag name');
  return tag;
}

// Returns the verified bytes, or throws. Nothing reaches the filesystem until the
// checksum matches: a corrupt or substituted download must never become the
// binary the user runs next.
async function downloadVerified(tag: string, asset: string): Promise<Uint8Array> {
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const [binary, sums] = await Promise.all([fetch(`${base}/${asset}`), fetch(`${base}/sha256sums.txt`)]);
  if (!binary.ok) throw new Error(`${tag} publishes no ${asset} (${binary.status})`);
  if (!sums.ok) throw new Error(`${tag} publishes no sha256sums.txt (${sums.status})`);

  const bytes = new Uint8Array(await binary.arrayBuffer());
  const expected = (await sums.text())
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  if (!expected) throw new Error(`sha256sums.txt has no entry for ${asset}`);

  const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset} (expected ${expected}, got ${actual})`);
  return bytes;
}

export async function runUpdate(): Promise<void> {
  try {
    // A source install runs through bun with its entrypoint symlinked into a
    // checkout; replacing that path would clobber the repo. git is the update
    // channel there, and saying so beats succeeding at the wrong thing.
    if (!import.meta.url.startsWith('file:///$bunfs/')) {
      console.log(`loop ${version} is running from source — update with git pull`);
      return;
    }

    const self = process.execPath;
    const asset = releaseAsset();
    const tag = await latestTag();
    if (tag === `v${version}`) {
      console.log(`loop ${version} is already the latest`);
      return;
    }

    console.log(`loop ${version} → ${tag}: downloading ${asset}`);
    const bytes = await downloadVerified(tag, asset);

    // Staged beside the target so the rename is a same-filesystem atomic swap:
    // this very process keeps its open inode, and an interrupted update cannot
    // leave a half-written binary on PATH.
    const staged = path.join(path.dirname(self), `.${path.basename(self)}.new`);
    try {
      await Bun.write(staged, bytes);
      await chmod(staged, 0o755);
      await rename(staged, self);
    } catch (e) {
      await unlink(staged).catch(() => {});
      throw new Error(`could not replace ${self}: ${(e as Error).message}`);
    }

    console.log(`loop ${tag.replace(/^v/, '')} installed to ${self}`);
  } catch (e) {
    console.error(`loop: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
