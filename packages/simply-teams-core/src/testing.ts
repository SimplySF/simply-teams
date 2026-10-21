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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

export type RouteHandler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

export interface TestServer {
  baseUrl: string;
  requests: RecordedRequest[];
  route: (pathname: string, handler: RouteHandler) => void;
  close: () => Promise<void>;
}

export function respondJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}

/** Tiny local HTTP server: register handlers per pathname, and every request gets recorded. */
export async function startTestServer(): Promise<TestServer> {
  const routes = new Map<string, RouteHandler>();
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push({ method: request.method ?? '', url: request.url ?? '', body });
      const handler = routes.get(url.pathname);
      if (handler) {
        handler(request, response, body);
      } else {
        respondJson(response, 404, { error: `no route for ${url.pathname}` });
      }
    });
  });

  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate a port'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    baseUrl,
    requests,
    route: (pathname, handler): void => {
      routes.set(pathname, handler);
    },
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
