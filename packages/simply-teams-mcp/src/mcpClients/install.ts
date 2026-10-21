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
import { applyPlan } from './apply.js';
import { clientMarker } from './clients.js';
import { planInstall } from './plan.js';
import {
  CLIENT_IDS,
  type ApplyOptions,
  type ClientId,
  type InstallEnvironment,
  type InstallResult,
  type InstallScope,
  type ServerSpec,
} from './types.js';

/**
 * Installs one server into each named client, in order. Every client is attempted whatever happened
 * to the ones before it.
 *
 * @returns One result per client, in the order given.
 */
export async function installServer(
  spec: ServerSpec,
  clients: readonly ClientId[],
  scope: InstallScope,
  environment: InstallEnvironment,
  options: ApplyOptions = {},
): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  for (const client of new Set(clients)) {
    // eslint-disable-next-line no-await-in-loop -- one client at a time keeps CLI output and file writes in a predictable order
    results.push(await applyPlan(planInstall(spec, client, scope, environment), options));
  }
  return results;
}

/** @returns The exit code for a set of results: the highest any one of them contributes. */
export function exitCodeFor(results: readonly InstallResult[]): 0 | 1 | 2 {
  return results.reduce<0 | 1 | 2>((highest, result) => (result.exitCode > highest ? result.exitCode : highest), 0);
}

/** @returns The clients whose configuration directory exists for this user. */
export async function detectInstalledClients(environment: InstallEnvironment): Promise<ClientId[]> {
  const found = await Promise.all(
    CLIENT_IDS.map(async (client) => {
      try {
        return (await fs.stat(clientMarker(client, environment))).isDirectory();
      } catch {
        return false;
      }
    }),
  );
  return CLIENT_IDS.filter((_, index) => found[index]);
}

/** @returns Whether `value` is a client id this module knows. */
export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}
