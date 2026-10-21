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

import spawn from 'cross-spawn';
import type { ProcessRunner } from './types.js';

/**
 * Runs a client CLI with its output captured. `cross-spawn` rather than `child_process.spawn`
 * because npm installs `claude` and `codex` as `.cmd` shims on Windows, which plain `spawn` refuses
 * to start without a shell, and a shell would need the JSON argument quoted for `cmd.exe`.
 */
export const runProcess: ProcessRunner = (executable, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });

/** @returns A command line a person can paste: POSIX quoting, or double quotes on Windows. */
export function formatCommandLine(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const quote =
    platform === 'win32'
      ? (arg: string): string => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`)
      : (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);
  return [executable, ...args].map(quote).join(' ');
}
