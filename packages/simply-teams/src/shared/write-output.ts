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

import { Flags } from '@oclif/core';
import {
  type GraphClient,
  type PlannedWrite,
  sendPlanned,
  type TeamsMessage,
  type WriteInput,
} from '@simplysf/simply-teams-core';
import { renderMessage } from './message-output.js';

/**
 * The flags every write command takes (design 0004): the message as text or HTML, who to
 * mention, and a dry run. The same names and meanings across the three commands.
 */
export const messageFlags = {
  text: Flags.string({
    summary: 'The message as plain text. Markup in it is shown, not applied.',
    exclusive: ['html'],
  }),
  html: Flags.string({ summary: 'The message as Teams HTML, for formatting.', exclusive: ['text'] }),
  mention: Flags.string({
    summary: 'Someone to @-mention, by email, UPN, or user ID. Repeatable. Mentions go at the start.',
    multiple: true,
  }),
  'dry-run': Flags.boolean({
    summary: 'Print the request that would be sent and exit without sending it.',
    default: false,
  }),
};

/** Reads the message flags into what the core plans from. */
export function writeInput(flags: { text?: string; html?: string; mention?: string[] }): WriteInput {
  return { text: flags.text, html: flags.html, mentions: flags.mention };
}

/** What a write command returns: the stored message, or under `--dry-run` the request it would send. */
export type WriteResult = TeamsMessage | PlannedWrite;

/**
 * Sends a planned write, or with `dryRun` only shows it. Rendering is given to the caller as
 * `log` so a command keeps printing through its own `logSafe`.
 */
export async function deliver(
  graph: GraphClient,
  planned: PlannedWrite,
  dryRun: boolean,
  log: (message: string) => void,
): Promise<WriteResult> {
  if (dryRun) {
    log(`Dry run: nothing was sent. ${planned.method} ${planned.path}\n${JSON.stringify(planned.body, null, 2)}`);
    return planned;
  }
  const posted = await sendPlanned(graph, planned);
  log(`Posted as ${posted.from?.name ?? 'you'}.\n\n${renderMessage(posted)}\n\nref: ${posted.ref}`);
  return posted;
}
