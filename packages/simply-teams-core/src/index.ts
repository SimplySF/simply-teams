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

// Everything exported from this file is this package's public API and is semver-covered: adding
// an export is a minor/patch change, but removing or renaming one is breaking.
// `test/index.test.ts` pins the exported-key list so an accidental removal fails a test instead
// of silently shipping in a patch release. See docs/design/0001-teams-client-core-and-auth.md.
//
// Nothing here touches a terminal or a process: no oclif, no child processes, no `process.argv`,
// nothing written to stdout or stderr. `process.env` is read only through an injectable `env`
// parameter that defaults to it. The repo's lint config enforces the import side of that rule.
//
// Nor does anything here sign in. Tokens arrive through the `TokenProvider` interface, which
// `@simplysf/simply-teams-auth` implements against the operating system's broker; keeping MSAL
// and its native binary out of this package is what keeps it dependency-free.

// --- Configuration, tokens, transport, client, errors ---
export {
  ACCESS_TOKEN_ENV,
  CLIENT_ID_ENV,
  CLOUD_ENV,
  CLOUDS,
  DEFAULT_TENANT,
  NO_INTERACTIVE_ENV,
  resolveTeamsConfig,
  TENANT_ID_ENV,
  type CloudEndpoints,
  type ConfigOverrides,
  type EnvLike,
  type TeamsCloud,
  type TeamsConfig,
} from './config.js';
export {
  ADMIN_CONSENT_SCOPES,
  BASE_SCOPES,
  describeStaticToken,
  graphScopes,
  missingScopes,
  READ_SCOPES,
  USER_CONSENT_SCOPES,
  WRITE_SCOPES,
  shortScope,
  staticTokenProvider,
  type AccessToken,
  type TokenProvider,
  type TokenRequest,
  type TokenSource,
} from './token.js';
export { loadEnvFile, parseEnvFile } from './env-file.js';
export { AuthError, CliError, ConfigError, HttpError, NetworkError } from './errors.js';
export { HttpTransport, type JsonCall, type QueryValue, type TransportTarget } from './http.js';
export {
  GraphClient,
  type GraphClientOptions,
  type GraphUser,
  type ListOptions,
  type ListResult,
  type Page,
  type PageOptions,
} from './graph-client.js';
export { channelMessageRef, chatMessageRef, parseRef, type RefKind, type Selector, type TeamsRef } from './refs.js';
export { stripControl, stripControlOneLine } from './text.js';

// --- Safety: the read-only guard and credential redaction, shared by every consumer ---
export { assertWritesAllowed, isReadOnly, READ_ONLY_ENV } from './write-safety.js';
export { collectSecrets, redactSecrets, sanitiseDeep, SECRET_ENV, secretValues } from './redaction.js';

// --- Shared rendering ---
export { formatKeyValue, formatTable, type Column, type Pair } from './output.js';
export { decodeEntities, htmlToText, type AttachmentLabel } from './html-text.js';
export {
  normalizeChat,
  normalizeMessage,
  normalizeSearchHit,
  renderSummary,
  type AttachmentKind,
  type ChannelLocation,
  type GraphChat,
  type GraphChatMessage,
  type GraphSearchHit,
  type MessageAuthor,
  type TeamsChat,
  type TeamsMessage,
  type TeamsSearchHit,
} from './messages.js';
export { buildSearchQuery, parseDate, type SearchFilters } from './kql.js';
export {
  buildMessageBody,
  escapeHtml,
  textToHtml,
  type GraphMention,
  type MentionTarget,
  type MessageBody,
  type MessageInput,
  validateMessageInput,
} from './message-body.js';

// --- Operations: what each command does between parsing its input and rendering its result ---
export {
  adminConsentUrl,
  authStatus,
  signIn,
  type AuthStatus,
  type SignInOptions,
  type SignInResult,
} from './auth-status.js';
export {
  listChannelMessages,
  listChannels,
  listChatMessages,
  listChats,
  listTeams,
  MAX_CONTEXT,
  planChannelPost,
  planChannelReply,
  planChatSend,
  parseReplyRef,
  resolveChannel,
  resolveMentions,
  resolveTeamId,
  SCOPES,
  searchMessages,
  sendPlanned,
  viewMessage,
  type ChannelMessageOptions,
  type PlannedWrite,
  type WriteInput,
  type MessageListOptions,
  type MessageView,
  type SearchResult,
  type TeamsChannel,
  type TeamsTeam,
} from './operations.js';
