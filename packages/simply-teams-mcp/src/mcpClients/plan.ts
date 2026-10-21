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

import { CLIENTS, pathFor } from './clients.js';
import type { ClientId, InstallEnvironment, InstallPlan, InstallScope, ServerSpec } from './types.js';

/** Entry names every client accepts: Codex, the strictest, takes nothing else as a TOML bare key. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** @returns Whether every client accepts `name` as an entry name. */
export function isValidServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

/**
 * Works out what installing `spec` into one client means: which file, or which CLI command. Reads
 * nothing and writes nothing; `applyPlan` does the rest.
 *
 * @param spec - The entry name and the process to launch.
 * @param client - The client to install into.
 * @param scope - The client's personal configuration, or its repo-level file under `environment.cwd`.
 * @param environment - Platform, home directory, working directory and environment variables.
 * @returns The plan. An unsupported client/scope pair, or an invalid name, plans as `unsupported`.
 */
export function planInstall(
  spec: ServerSpec,
  client: ClientId,
  scope: InstallScope,
  environment: InstallEnvironment,
): InstallPlan {
  const base = { client, scope, name: spec.name };
  const definition = CLIENTS[client];

  if (!isValidServerName(spec.name)) {
    return {
      ...base,
      kind: 'unsupported',
      reason: `"${spec.name}" is not a valid server name. Use only letters, digits, "-" and "_".`,
    };
  }

  const launch = { command: spec.command, args: [...spec.args] };

  if (scope === 'project') {
    if (!definition.project) {
      return {
        ...base,
        kind: 'unsupported',
        reason: `${definition.displayName} has no project-level configuration. Use --scope user.`,
      };
    }
    const { file, key, typed } = definition.project;
    return {
      ...base,
      kind: 'file',
      file: pathFor(environment).resolve(environment.cwd, file),
      key,
      entry: typed ? { type: 'stdio', ...launch } : launch,
    };
  }

  const location = definition.user(environment);
  if ('cli' in location) {
    if (location.cli === 'claude') {
      return {
        ...base,
        kind: 'cli',
        executable: 'claude',
        addArgs: ['mcp', 'add-json', spec.name, JSON.stringify({ type: 'stdio', ...launch }), '--scope', 'user'],
        removeArgs: ['mcp', 'remove', spec.name, '--scope', 'user'],
        launch,
        configFile: location.configFile,
        configFormat: 'claude-json',
      };
    }
    return {
      ...base,
      kind: 'cli',
      executable: 'codex',
      addArgs: ['mcp', 'add', spec.name, '--', launch.command, ...launch.args],
      removeArgs: ['mcp', 'remove', spec.name],
      launch,
      configFile: location.configFile,
      configFormat: 'codex-toml',
    };
  }

  return {
    ...base,
    kind: 'file',
    file: location.file,
    key: location.key,
    entry: location.typed ? { type: 'stdio', ...launch } : launch,
    clientDir: location.clientDir,
  };
}
