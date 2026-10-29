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

import { AuthError, HttpError } from './errors.js';
import type { GraphClient, Page } from './graph-client.js';
import type { GraphChatMessage } from './messages.js';

/**
 * Finds the root post of a channel reply whose reference names only the reply.
 *
 * A search hit carries no reply-to ID, and the Teams link Graph attaches to it (`webLink`) does
 * not always name the root either: on the tenant checked on 2026-10-29 it was the bare
 * `/l/message/{channelId}/{id}` form, with no `parentMessageId`. Graph can only fetch a reply
 * under its root (`…/messages/{root}/replies/{id}`; the reply's own ID answers 404), so a
 * root-less ref to a reply reads as "deleted". This scans the channel's newest posts, with their
 * replies expanded, for the one whose replies hold the ID. Pages are read only as far as needed
 * and kept, so every lookup in the same channel reuses them.
 */
export const ROOT_SCAN_PAGE_SIZE = 50;
/** The most pages scanned per channel: a reply to an older post than this is left unresolved. */
export const ROOT_SCAN_PAGES = 3;
/** The most replies read from one root whose expanded replies were cut short. */
const CANDIDATE_REPLY_PAGES = 2;

const SCOPES = ['ChannelMessage.Read.All'] as const;

type ExpandedPost = GraphChatMessage & {
  readonly replies?: ReadonlyArray<{ readonly id?: string }> | null;
  readonly 'replies@odata.nextLink'?: string;
};

interface ChannelScan {
  /** Message ID to the root it belongs to; a root maps to itself. */
  readonly roots: Map<string, string>;
  /** Roots whose replies were cut short, so a reply may belong to them without being listed. */
  readonly partial: string[];
  readonly pages: AsyncGenerator<Page<ExpandedPost>>;
  exhausted: boolean;
}

export class ThreadRoots {
  private readonly scans = new Map<string, ChannelScan>();
  /** Serializes lookups in one channel, so two callers never read the same page twice. */
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly graph: GraphClient) {}

  /**
   * The root of `messageId` in the channel: `messageId` itself when it is a root post, another
   * ID when it is a reply, or `undefined` when it is not among the newest posts and their replies
   * (older than the scan reaches, deleted, or never there).
   */
  public async rootOf(teamId: string, channelId: string, messageId: string): Promise<string | undefined> {
    const result = this.queue.then(() => this.lookup(teamId, channelId, messageId));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async lookup(teamId: string, channelId: string, messageId: string): Promise<string | undefined> {
    const base = `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
    const scan = this.scanOf(base);
    const known = scan.roots.get(messageId);
    if (known !== undefined) return known;
    /* Pages arrive one at a time, each only if the one before did not hold the ID. */
    /* eslint-disable no-await-in-loop */
    while (!scan.exhausted) {
      let page: IteratorResult<Page<ExpandedPost>>;
      try {
        page = await scan.pages.next();
      } catch (error) {
        // A channel that cannot be listed resolves nothing; the caller's own request says why.
        if (error instanceof HttpError || error instanceof AuthError) {
          scan.exhausted = true;
          return undefined;
        }
        throw error;
      }
      if (page.done === true) {
        scan.exhausted = true;
        break;
      }
      for (const post of page.value.items) {
        if (post.id === undefined) continue;
        scan.roots.set(post.id, post.id);
        for (const reply of post.replies ?? []) if (reply.id !== undefined) scan.roots.set(reply.id, post.id);
        if (post['replies@odata.nextLink'] !== undefined) scan.partial.push(post.id);
      }
      const found = scan.roots.get(messageId);
      if (found !== undefined) return found;
    }
    // Message IDs are creation times in milliseconds, so only a root older than the reply can hold it.
    for (const rootId of scan.partial.filter((id) => Number(id) < Number(messageId))) {
      const replies = await this.graph.list<{ id?: string }>(`${base}/${encodeURIComponent(rootId)}/replies`, {
        scopes: SCOPES,
        query: { $top: ROOT_SCAN_PAGE_SIZE },
        limit: CANDIDATE_REPLY_PAGES * ROOT_SCAN_PAGE_SIZE,
        maxPages: CANDIDATE_REPLY_PAGES,
      });
      for (const reply of replies.items) if (reply.id !== undefined) scan.roots.set(reply.id, rootId);
      scan.partial.splice(scan.partial.indexOf(rootId), 1);
      const found = scan.roots.get(messageId);
      if (found !== undefined) return found;
    }
    /* eslint-enable no-await-in-loop */
    return undefined;
  }

  private scanOf(base: string): ChannelScan {
    const known = this.scans.get(base);
    if (known !== undefined) return known;
    const scan: ChannelScan = {
      roots: new Map(),
      partial: [],
      pages: this.graph.pages<ExpandedPost>(base, {
        scopes: SCOPES,
        query: { $top: ROOT_SCAN_PAGE_SIZE, $expand: 'replies' },
        maxPages: ROOT_SCAN_PAGES,
      }),
      exhausted: false,
    };
    this.scans.set(base, scan);
    return scan;
  }
}
