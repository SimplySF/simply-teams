#!/usr/bin/env node
/**
 * Fully resets cached/generated artifacts across the monorepo: node_modules,
 * the pnpm lockfile, wireit caches, build output, and TS/ESLint caches.
 *
 * Usage:
 *   node scripts/reset.mjs             # remove caches only
 *   node scripts/reset.mjs --install   # also reinstall deps afterwards
 *   node scripts/reset.mjs --store     # also prune the global pnpm store
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const packagesDir = join(rootDir, 'packages');

const args = new Set(process.argv.slice(2));
const shouldInstall = args.has('--install');
const shouldPruneStore = args.has('--store');

const packageDirs = existsSync(packagesDir)
  ? readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(packagesDir, entry.name))
  : [];

// Paths relative to the repo root.
const rootTargets = ['node_modules', 'pnpm-lock.yaml', '.eslintcache'];

// Paths relative to each package directory.
const packageTargets = ['node_modules', '.wireit', 'lib', 'dist', 'tsconfig.tsbuildinfo', '.eslintcache'];

const targets = [
  ...rootTargets.map((target) => join(rootDir, target)),
  ...packageDirs.flatMap((packageDir) => packageTargets.map((target) => join(packageDir, target))),
];

for (const target of targets) {
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
}

if (shouldPruneStore) {
  console.log('Pruning pnpm store...');
  spawnSync('pnpm', ['store', 'prune'], { stdio: 'inherit', shell: true });
}

if (shouldInstall) {
  console.log('Reinstalling dependencies...');
  const result = spawnSync('pnpm', ['install'], { cwd: rootDir, stdio: 'inherit', shell: true });
  process.exit(result.status ?? 0);
}
