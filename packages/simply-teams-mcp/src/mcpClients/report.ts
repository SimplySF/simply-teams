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

import { CLIENTS } from './clients.js';
import { CLIENT_IDS, type ClientId, type InstallOutcome, type InstallResult, type Launcher } from './types.js';

const OUTCOME_TEXT: Record<InstallOutcome, { done: string; planned: string }> = {
  added: { done: 'added', planned: 'would add' },
  replaced: { done: 'replaced', planned: 'would replace' },
  unchanged: { done: 'already installed', planned: 'already installed' },
  conflict: { done: 'not changed (conflict)', planned: 'would not change (conflict)' },
  failed: { done: 'failed', planned: 'would fail' },
};

/**
 * Renders results as the text a command prints. Returned rather than printed, so this module never
 * touches a stream.
 *
 * @param results - From `installServer`.
 * @param launcher - Adds the note about a pinned Node binary when it is `absolute`.
 * @returns The report, ending with what to do next in each client that changed.
 */
export function formatInstallReport(results: readonly InstallResult[], launcher?: Launcher): string {
  const lines: string[] = [];
  for (const result of results) {
    const outcome = OUTCOME_TEXT[result.outcome][result.dryRun ? 'planned' : 'done'];
    lines.push(`${CLIENTS[result.client].displayName}: ${outcome} "${result.name}"`, `  ${result.target}`);
    if (result.message) lines.push(...result.message.split('\n').map((line) => `  ${line}`));
    if (result.dryRun && result.outcome !== 'failed' && result.outcome !== 'unchanged') {
      lines.push(...result.preview.split('\n').map((line) => `    ${line}`));
    }
  }

  const changed = results.filter((result) => !result.dryRun && ['added', 'replaced'].includes(result.outcome));
  if (changed.length > 0) {
    lines.push('', 'Next:');
    for (const result of changed)
      lines.push(`  ${CLIENTS[result.client].displayName}: ${CLIENTS[result.client].nextStep}`);
    if (launcher === 'absolute') {
      lines.push(
        '',
        'These entries start this exact Node binary. If a Node upgrade (nvm, fnm, Volta) moves it, ' +
          'run this command again with --force.',
      );
    }
  }
  return lines.join('\n');
}

/** @returns The message for a missing `--client`: every id, marking the ones installed here. */
export function formatClientChoices(installed: readonly ClientId[]): string {
  return [
    'Name at least one client with --client. Clients:',
    ...CLIENT_IDS.map(
      (client) =>
        `  ${client.padEnd(15)} ${CLIENTS[client].displayName}${installed.includes(client) ? ' (found on this machine)' : ''}`,
    ),
  ].join('\n');
}
