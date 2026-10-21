/*
 * Copyright (c) 2026, SimplySF.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));
const setupFile = fileURLToPath(new URL('./vitest.setup.ts', import.meta.url));

// Vitest's `projects` glob only inherits the parent `test` config for directories that have
// their own vitest config file; bare directories (all of ours) get nothing but CLI-flag
// overrides. Building explicit project entries here — one per package — makes each project
// actually inherit `setupFiles`, `include`, `environment`, and `globals` below, and also makes
// them resolve correctly regardless of which directory `vitest run` is invoked from (each
// package's `test:only` wireit task runs it from that package's own directory).
const packageProjects = fs
  .readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    test: {
      name: entry.name,
      root: fileURLToPath(new URL(`./packages/${entry.name}/`, import.meta.url)),
      globals: true,
      environment: 'node',
      include: ['test/**/*.test.ts'],
      setupFiles: [setupFile],
      // The first `Command.run()` in a worker pays for oclif's whole `Config.load()` — plugin
      // discovery, manifest reads, and a walk over a symlink-heavy pnpm node_modules — and vitest
      // charges all of it to whichever test happened to run first. That start-up cost is well
      // under a second locally but repeatedly blew past 10s on cold Windows CI runners, failing
      // whichever test drew the short straw rather than anything actually wrong with it. These
      // suites load real commands, so the ceiling has to clear a cold start, not a warm one.
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }));

export default defineConfig({
  root: rootDir,
  test: {
    projects: packageProjects,
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
