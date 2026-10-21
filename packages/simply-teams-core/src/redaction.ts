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
import { stripControl } from './text.js';

/** The environment variables that carry credentials, and so must never reach any output. */
export const SECRET_ENV = ['TEAMS_ACCESS_TOKEN'] as const;

/** Shorter values would mangle unrelated text; real tokens are far longer than this. */
const MIN_SECRET_LENGTH = 8;

/**
 * Keeps the values worth redacting out of whatever a caller collected — the environment, a
 * command line, a config file — and drops the ones too short to be a credential.
 */
export function collectSecrets(values: Iterable<string | undefined>): Set<string> {
  const secrets = new Set<string>();
  for (const value of values) {
    if (value !== undefined && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  }
  return secrets;
}

/** The credential values present in an environment. */
export function secretValues(env: EnvLike = process.env): Set<string> {
  return collectSecrets(SECRET_ENV.map((name) => env[name]));
}

/** Blanks out any credential that could otherwise ride along in a message. */
export function redactSecrets(message: string, secrets: Iterable<string>): string {
  let redacted = message;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '<redacted>');
  return redacted;
}

/**
 * Applies the same guards to a response body that an error message gets.
 *
 * A message that was redacted and stripped while the `body` beside it — the same bytes from the
 * same response — went out untouched is a credential disclosure whenever the far side echoes
 * the token back: a captive portal, a proxy, or an agency gateway does exactly that.
 * `JSON.stringify` escapes C0 but not C1, U+2028/U+2029, or the invisible ranges, so a hostile
 * body would also reach an agent's context with live escape sequences intact.
 *
 * Recursive because the body is arbitrary server JSON — Graph nests its messages under
 * `message` and `error` in shapes that vary by endpoint — so guarding only a top-level string
 * would miss the common case.
 */
export function sanitiseDeep(value: unknown, secrets: Iterable<string>, depth = 0): unknown {
  // The body comes from Graph, so the walk is bounded rather than trusted to be shallow.
  if (depth > 12) return undefined;
  if (typeof value === 'string') return stripControl(redactSecrets(value, secrets));
  if (Array.isArray(value)) return value.map((item) => sanitiseDeep(item, secrets, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [stripControl(key), sanitiseDeep(item, secrets, depth + 1)]),
    );
  }
  return value;
}
