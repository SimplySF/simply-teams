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

import { AuthError, CliError, HttpError, NetworkError } from './errors.js';
import { stripControlOneLine } from './text.js';
import type { TokenProvider } from './token.js';

/** A single query value, or a list Graph takes comma-joined (`$select=id,body`). */
export type QueryValue = string | number | boolean | undefined | ReadonlyArray<string | number>;

/** One REST call, relative to the transport's base URL. */
export interface JsonCall {
  readonly method: string;
  /**
   * Relative to the base URL, or an absolute URL on the same origin. Absolute URLs exist for
   * Graph's `@odata.nextLink`, which arrives fully formed; any other origin is refused rather
   * than handed the bearer token.
   */
  readonly path: string;
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
  /** Short scope names this call needs; the token provider's default when omitted. */
  readonly scopes?: readonly string[];
}

/** Where and how a transport talks: fixed per client instance. */
export interface TransportTarget {
  /** Graph origin plus version, e.g. `https://graph.microsoft.com/v1.0`. */
  readonly baseUrl: string;
  readonly tokens: TokenProvider;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const RETRY_AFTER_CAP_MS = 60_000;

/** Certificate problems: the trust store is wrong, so retrying changes nothing. */
const CERT_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Transport failures another attempt cannot fix: the host or the trust decision is wrong. */
const PERMANENT_TRANSPORT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', ...CERT_CODES]);

/** What one attempt concluded: a parsed value, a retryable failure, or a token Graph refused. */
type AttemptOutcome<T> =
  | { kind: 'done'; value: T }
  | { kind: 'retry'; delayMs?: number; exhausted: () => HttpError }
  | { kind: 'unauthorized'; error: AuthError };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Digs the syscall-level error code out of however deeply the runtime wrapped it. */
function transportCode(error: unknown): string | undefined {
  for (let cursor = error; cursor instanceof Error; cursor = cursor.cause as Error) {
    const code = (cursor as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function isAbort(error: unknown): boolean {
  // Deliberately not `instanceof Error`: fetch aborts reject with a DOMException, which isn't one.
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * JSON-over-HTTPS transport bound to one Graph endpoint. Each client owns one; everything that
 * would otherwise be an argument (base URL, token source, timing) is fixed at construction so
 * call sites stay small.
 *
 * Certificate verification is always on. A network that intercepts TLS with an internal CA is
 * supported by pointing Node at that CA — `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` — which keeps
 * verification intact rather than turning it off.
 */
export class HttpTransport {
  private readonly target: TransportTarget;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  public constructor(target: TransportTarget) {
    this.target = target;
    this.origin = new URL(target.baseUrl).origin;
    this.timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = target.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * Executes a call and parses the JSON response.
   *
   * The bearer token is fetched for every attempt. A 401 is answered once by forcing a fresh
   * token, because a token can be revoked or expire between being issued and being used; a
   * second 401, or any 403, is an `AuthError`. 429/5xx retry with exponential backoff, deferring
   * to a (capped) `Retry-After` — Graph throttles hard and says how long to wait. Other non-2xx
   * become `HttpError`. Timeouts, DNS misses, and certificate failures become `NetworkError`
   * without pointless retries; transient socket failures retry. The timeout covers the whole
   * exchange, response body included.
   */
  public async json<T>(call: JsonCall): Promise<T> {
    const url = this.resolve(call);
    let refreshed = false;

    /* Each attempt must observe the previous one's outcome before starting — sequential awaiting
       is the mechanism, not an accident. */
    /* eslint-disable no-await-in-loop */
    for (let attempt = 1; ; attempt += 1) {
      let outcome: AttemptOutcome<T>;
      try {
        const { token } = await this.target.tokens.getToken({ forceRefresh: refreshed, scopes: call.scopes });
        outcome = await this.attempt<T>(url, call, token);
      } catch (error) {
        const verdict = this.triage(error, call, url, attempt);
        if (verdict !== TRANSIENT) throw verdict;
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      if (outcome.kind === 'done') return outcome.value;
      if (outcome.kind === 'unauthorized') {
        if (refreshed) throw outcome.error;
        // A token refresh is not a retry of a failure, so it does not spend an attempt.
        refreshed = true;
        attempt -= 1;
        continue;
      }
      if (attempt >= this.maxAttempts) throw outcome.exhausted();
      await delay(outcome.delayMs ?? BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
    /* eslint-enable no-await-in-loop */
  }

  /** Runs one attempt under a deadline that spans connection, headers, AND body. */
  private async attempt<T>(url: URL, call: JsonCall, token: string): Promise<AttemptOutcome<T>> {
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}` };
      if (call.body !== undefined) headers['Content-Type'] = 'application/json';

      const response = await fetch(url, {
        method: call.method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        signal: controller.signal,
        // A redirect would carry the Authorization header to wherever it points.
        redirect: 'error',
      });

      if (response.status === 401) {
        const detail = await describeBody(response);
        return {
          kind: 'unauthorized',
          error: new AuthError(
            `Graph rejected the access token: ${call.method} ${call.path} returned 401.${detail}`,
            401,
          ),
        };
      }

      if (response.status === 403) {
        // Graph's own message names the permission it wanted, which is the useful part. It is
        // reported as-is rather than turned into advice: an agent told to "grant the app more
        // permissions" after an ordinary refusal would be escalating its own access.
        const detail = await describeBody(response);
        throw new AuthError(`${call.method} ${call.path} was refused (403).${detail}`, 403);
      }

      if (response.ok) {
        const text = await response.text();
        if (text.trim() === '') return { kind: 'done', value: {} as T };
        try {
          return { kind: 'done', value: JSON.parse(text) as T };
        } catch {
          throw new HttpError(`${call.method} ${call.path} returned malformed JSON.`, response.status, text);
        }
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = readRetryAfter(response.headers.get('retry-after'));
        const status = response.status;
        const detail = await describeBody(response);
        return {
          kind: 'retry',
          delayMs: retryAfter,
          exhausted: () => new HttpError(`${call.method} ${call.path} failed (${status}).${detail}`, status),
        };
      }

      const body = await bodyAsJsonOrText(response);
      throw new HttpError(
        `${call.method} ${call.path} failed (${response.status}).${formatSnippet(body)}`,
        response.status,
        body,
      );
    } finally {
      clearTimeout(deadline);
    }
  }

  /** Wraps raw transport failures in typed, user-explainable errors; rethrows deliberate ones. */
  private triage(error: unknown, call: JsonCall, url: URL, attempt: number): CliError | typeof TRANSIENT {
    if (error instanceof CliError) return error;

    if (isAbort(error)) {
      return new NetworkError(
        `${call.method} ${call.path} did not complete within ${this.timeoutMs} ms (${url.host}).`,
      );
    }

    const code = transportCode(error);
    if (code !== undefined && PERMANENT_TRANSPORT_CODES.has(code)) {
      const hint = CERT_CODES.has(code)
        ? ` The certificate could not be verified. If this network inspects TLS with an internal or agency CA, point Node at that CA bundle with NODE_EXTRA_CA_CERTS=/path/to/ca.pem.`
        : '';
      return new NetworkError(`Cannot reach ${url.host}: ${code}.${hint}`);
    }

    if (attempt < this.maxAttempts) {
      // Transient transport failure (connection reset, refused, mid-flight drop): try again.
      return TRANSIENT;
    }

    const description = code ?? (error instanceof Error ? error.message : String(error));
    return new NetworkError(`${call.method} ${call.path} failed after ${attempt} attempts: ${description}.`);
  }

  private resolve(call: JsonCall): URL {
    let url: URL;
    if (/^https?:\/\//i.test(call.path)) {
      url = new URL(call.path);
      if (url.origin !== this.origin) {
        throw new CliError(`Refusing to send the access token to ${url.origin}; only ${this.origin} is trusted.`);
      }
    } else {
      url = new URL(this.target.baseUrl);
      const root = url.pathname.replace(/\/+$/, '');
      url.pathname = call.path.startsWith('/') ? `${root}${call.path}` : `${root}/${call.path}`;
    }
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (value === undefined) continue;
      // Graph's OData options take a list as one comma-joined value: `$select=id,body`.
      url.searchParams.set(name, Array.isArray(value) ? value.join(',') : String(value));
    }
    return url;
  }
}

/** Sentinel: the triage step decided this attempt's failure is worth another try. */
const TRANSIENT = Symbol('transient-transport-failure');

/** `Retry-After` arrives as delay-seconds or an HTTP date; both are capped so a hostile value can't park the CLI. */
function readRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, RETRY_AFTER_CAP_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_CAP_MS);
}

/** Drains an error response and renders a short human-readable suffix, never throwing. */
async function describeBody(response: Response): Promise<string> {
  return formatSnippet(await bodyAsJsonOrText(response));
}

async function bodyAsJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Graph wraps every failure as `{ error: { code, message } }`; those two fields are the useful part. */
function graphError(body: unknown): string | undefined {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  if (typeof error !== 'object' || error === null) return undefined;
  const parts = [error.code, error.message].filter((part): part is string => typeof part === 'string' && part !== '');
  return parts.length === 0 ? undefined : parts.join(': ');
}

/**
 * Renders a response body into an error message, on one line.
 *
 * This is the only point where wholly server-controlled text joins an error message, so it is
 * where the newline has to go — not at the assembled message, which also carries this CLI's own
 * deliberate line structure. A multi-line body would otherwise forge extra stderr lines,
 * including one shaped like this CLI's JSON error object, which a caller parsing stderr
 * line-by-line could not tell from the real thing.
 */
function formatSnippet(body: unknown): string {
  if (body === undefined) return '';
  const text = graphError(body) ?? (typeof body === 'string' ? body : JSON.stringify(body));
  const rendered = stripControlOneLine(text);
  return rendered === '' ? '' : ` ${rendered}`;
}
