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

import process from 'node:process';
import type { EnvLike } from './config.js';
import { ConfigError } from './errors.js';

/** The environment variable that marks a context as one that does not make changes. */
export const READ_ONLY_ENV = 'TEAMS_READ_ONLY';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Whether the environment says this context does not write. Any value not meaning "yes" is ignored. */
export function isReadOnly(env: EnvLike = process.env): boolean {
  const raw = env[READ_ONLY_ENV];
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Refuses a write when the environment says this context does not write.
 *
 * A guardrail, not a security boundary: an agent with shell access can unset the variable. It
 * exists for the different and real problem of a person, or an agent, running against the wrong
 * credentials or in the wrong context — a message posted to the wrong chat cannot be unsent from
 * the notifications it already raised. The boundary that actually binds is an app registration
 * consented only for read scopes, which makes Graph refuse the write server-side.
 *
 * Shared by the CLI (checked once in its base command before any write command runs) and the
 * MCP server (checked before any write tool runs), so the two cannot disagree about what the
 * variable means.
 */
export function assertWritesAllowed(env: EnvLike = process.env): void {
  if (isReadOnly(env)) {
    throw new ConfigError(
      `${READ_ONLY_ENV} is set, so this context does not make changes. Unset it, or pass a ` +
        'credential file that is meant for writing, to proceed.',
    );
  }
}
