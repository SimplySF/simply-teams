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

import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

/**
 * Pins down this package's public API surface. Types are erased at runtime and so can't be
 * checked here — TypeScript's own compilation of the barrel is what catches a type export being
 * removed or renamed. This test guards the *value* exports (functions, classes, constants) that
 * survive to runtime.
 *
 * Updating this list is expected when the API deliberately grows. A test failure from a removed
 * or renamed key is the signal to treat the change as breaking (see `src/index.ts`'s header).
 */
describe('@simplysf/simply-teams-core', () => {
  it('exports the expected set of runtime values', () => {
    expect(Object.keys(api).sort()).toStrictEqual(
      [
        // configuration
        'ACCESS_TOKEN_ENV',
        'CLIENT_ID_ENV',
        'CLOUD_ENV',
        'CLOUDS',
        'DEFAULT_TENANT',
        'NO_INTERACTIVE_ENV',
        'TENANT_ID_ENV',
        'resolveTeamsConfig',
        'loadEnvFile',
        'parseEnvFile',
        // tokens
        'ADMIN_CONSENT_SCOPES',
        'BASE_SCOPES',
        'USER_CONSENT_SCOPES',
        'READ_SCOPES',
        'describeStaticToken',
        'graphScopes',
        'missingScopes',
        'shortScope',
        'staticTokenProvider',
        // transport, client, errors
        'AuthError',
        'CliError',
        'ConfigError',
        'GraphClient',
        'HttpError',
        'HttpTransport',
        'NetworkError',
        // safety
        'READ_ONLY_ENV',
        'SECRET_ENV',
        'assertWritesAllowed',
        'collectSecrets',
        'isReadOnly',
        'redactSecrets',
        'sanitiseDeep',
        'secretValues',
        // rendering
        'formatKeyValue',
        'formatTable',
        'stripControl',
        'stripControlOneLine',
        // references, rendering, and the message shape
        'channelMessageRef',
        'chatMessageRef',
        'parseRef',
        'decodeEntities',
        'htmlToText',
        'normalizeChat',
        'normalizeMessage',
        'normalizeSearchHit',
        'renderSummary',
        'buildSearchQuery',
        'parseDate',
        // operations
        'adminConsentUrl',
        'authStatus',
        'signIn',
        'listChannelMessages',
        'listChannels',
        'listChatMessages',
        'listChats',
        'listTeams',
        'MAX_CONTEXT',
        'resolveChannel',
        'resolveTeamId',
        'SCOPES',
        'searchMessages',
        'viewMessage',
      ].sort(),
    );
  });
});
