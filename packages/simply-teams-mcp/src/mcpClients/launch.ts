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

import fs from 'node:fs/promises';
import os from 'node:os';
import { pathFor } from './clients.js';
import type { InstallEnvironment, InstallScope, Launcher } from './types.js';

/** The package `npx` fetches for the `npx` launcher. */
export const SIMPLY_CLI_PACKAGE = '@simplysf/simply-cli';

/** @returns The environment of the running process, for `planInstall` and friends. */
export function currentEnvironment(): InstallEnvironment {
  return { platform: process.platform, homedir: os.homedir(), cwd: process.cwd(), env: process.env };
}

/**
 * `absolute` for personal configuration, where the path is right for the only person who reads it;
 * `simply` for a committed project file, where an absolute path is wrong for everyone else.
 *
 * @returns The launcher to use when the caller didn't name one.
 */
export function defaultLauncher(scope: InstallScope): Launcher {
  return scope === 'project' ? 'simply' : 'absolute';
}

/**
 * Builds the process an entry launches.
 *
 * @param launcher - How to start `simply`.
 * @param simplyArgs - The `simply` arguments, e.g. `['atlassian', 'mcp', '--allow-writes']`.
 * @param host - For `absolute`: the Node binary (`process.execPath`) and the host's `bin/run.js`.
 * @returns The entry's `command` and `args`.
 */
export function buildLaunch(
  launcher: Launcher,
  simplyArgs: readonly string[],
  host: { nodePath: string; runScript: string },
): { command: string; args: string[] } {
  switch (launcher) {
    case 'absolute':
      return { command: host.nodePath, args: [host.runScript, ...simplyArgs] };
    case 'npx':
      return { command: 'npx', args: ['-y', SIMPLY_CLI_PACKAGE, ...simplyArgs] };
    case 'simply':
      return { command: 'simply', args: [...simplyArgs] };
  }
}

/**
 * Makes an `--env-file` path absolute and checks it exists, here, at install time. A client starts
 * the server from a working directory of its own, so `~` and relative paths written into its
 * configuration would resolve somewhere else, or nowhere.
 *
 * @returns The absolute path.
 * @throws When the file doesn't exist or isn't a file.
 */
export async function resolveEnvFile(file: string, environment: InstallEnvironment): Promise<string> {
  const p = pathFor(environment);
  const expanded = /^~(?=$|[/\\])/.test(file) ? p.join(environment.homedir, file.slice(1)) : file;
  const absolute = p.resolve(environment.cwd, expanded);
  let isFile = false;
  try {
    isFile = (await fs.stat(absolute)).isFile();
  } catch {
    // Reported below, with the resolved path, which is the useful part.
  }
  if (!isFile) throw new Error(`--env-file ${absolute} does not exist or is not a file.`);
  return absolute;
}
