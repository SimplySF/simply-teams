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

import type { TeamsConfig } from './config.js';
import { HttpTransport, type QueryValue } from './http.js';
import type { TokenProvider } from './token.js';

/** Everything a caller needs after following pages: the items plus why paging stopped. */
export interface ListResult<T = unknown> {
  readonly items: readonly T[];
  readonly pages: number;
  /** False when the caller's limit cut the results short. */
  readonly complete: boolean;
}

export interface PageOptions {
  /** Short scope names the endpoint needs. */
  readonly scopes: readonly string[];
  readonly query?: Record<string, QueryValue>;
  /** The most pages to follow; defaults to {@link MAX_PAGES}. */
  readonly maxPages?: number;
}

export interface ListOptions extends PageOptions {
  /** Stop once this many items have been collected. */
  readonly limit: number;
}

/** The signed-in user, as much of it as `whoami`-style output needs. */
export interface GraphUser {
  readonly id: string;
  readonly displayName?: string;
  readonly userPrincipalName?: string;
  readonly mail?: string;
}

/** Graph's collection envelope. */
interface ODataPage<T> {
  readonly value?: readonly T[];
  readonly '@odata.nextLink'?: string;
}

/** One page as {@link GraphClient.pages} yields it: its items, and whether Graph has another. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
}

/** How many pages one list call will follow before giving up, however small the page size. */
const MAX_PAGES = 100;

/** Only v1.0 is used; a beta endpoint needs a design doc saying why (design 0001). */
const API_VERSION = 'v1.0';

/** Test seams: a local server's URL, and faster timing. */
export interface GraphClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

/**
 * Microsoft Graph, bound to one cloud and one token source. Commands and tools build one per
 * invocation; the transport asks the token provider per request, so the client itself holds no
 * credential.
 */
export class GraphClient {
  private readonly transport: HttpTransport;

  public constructor(config: TeamsConfig, tokens: TokenProvider, options: GraphClientOptions = {}) {
    this.transport = new HttpTransport({
      baseUrl: options.baseUrl ?? `${config.endpoints.graphUrl}/${API_VERSION}`,
      tokens,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.maxAttempts,
    });
  }

  public me(): Promise<GraphUser> {
    return this.get<GraphUser>('/me', ['User.Read'], { $select: ['id', 'displayName', 'userPrincipalName', 'mail'] });
  }

  public get<T>(path: string, scopes: readonly string[], query?: Record<string, QueryValue>): Promise<T> {
    return this.transport.json<T>({ method: 'GET', path, query, scopes });
  }

  /** A POST that reads, such as `/search/query`. Writes go through {@link send}. */
  public post<T>(path: string, body: unknown, scopes: readonly string[]): Promise<T> {
    return this.transport.json<T>({ method: 'POST', path, body, scopes });
  }

  /**
   * A POST that changes something in Teams (design 0004). Marked mutating, so it is never sent
   * twice: a failure that could have followed a posted message is reported, not retried.
   */
  public send<T>(path: string, body: unknown, scopes: readonly string[]): Promise<T> {
    return this.transport.json<T>({ method: 'POST', path, body, scopes, mutating: true });
  }

  /**
   * Yields one page at a time, following `@odata.nextLink`, so a caller can stop as soon as it
   * has what it needs — a `--since` cutoff, a message it was looking for — instead of fetching
   * pages it will throw away. The next link is used verbatim, because Graph encodes its paging
   * state in it (a skip token) and the original query is already folded in.
   */
  public async *pages<T>(path: string, options: PageOptions): AsyncGenerator<Page<T>> {
    let next: string | undefined = path;
    const maxPages = options.maxPages ?? MAX_PAGES;

    /* Each page's link comes from the previous page, so the requests cannot overlap. */
    /* eslint-disable no-await-in-loop */
    for (let count = 0; next !== undefined && count < maxPages; count += 1) {
      const page: ODataPage<T> = await this.transport.json<ODataPage<T>>({
        method: 'GET',
        path: next,
        // The next link already carries the query; adding it again would duplicate parameters.
        query: count === 0 ? options.query : undefined,
        scopes: options.scopes,
      });
      next = page['@odata.nextLink'];
      yield { items: page.value ?? [], hasMore: next !== undefined };
    }
    /* eslint-enable no-await-in-loop */
  }

  /** Collects pages until the limit is reached, Graph runs out of pages, or the page ceiling is hit. */
  public async list<T>(path: string, options: ListOptions): Promise<ListResult<T>> {
    const items: T[] = [];
    let pages = 0;
    let hasMore = false;
    for await (const page of this.pages<T>(path, options)) {
      pages += 1;
      items.push(...page.items);
      hasMore = page.hasMore;
      if (items.length >= options.limit) break;
    }
    return { items: items.slice(0, options.limit), pages, complete: !hasMore && items.length <= options.limit };
  }
}
