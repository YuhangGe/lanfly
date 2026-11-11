import type { ServerResponse } from 'node:http';

import { SSE_HEARTBEAT_MS } from '@lanfly/common';

type SseClient = {
  response: ServerResponse;
  closed: boolean;
};

export class EventHub {
  peersProvider?: () => unknown;
  onPeersChanged?: () => void;
  #clients = new Set<SseClient>();
  #nextId = 1;
  #heartbeat: NodeJS.Timeout;

  constructor() {
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients) {
        if (!client.closed) client.response.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, SSE_HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  get connections(): number {
    return this.#clients.size;
  }

  add(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 3000\n\n');
    const client: SseClient = { response, closed: false };
    this.#clients.add(client);
    const remove = () => {
      if (client.closed) return;
      client.closed = true;
      this.#clients.delete(client);
    };
    response.on('close', remove);
    response.on('error', remove);
  }

  broadcast(event: string, data: unknown): void {
    if (event === 'peers') {
      data = this.peersProvider?.() ?? data;
      this.onPeersChanged?.();
    }
    const payload = JSON.stringify(data);
    const id = this.#nextId++;
    const frame = `id: ${id}\nevent: ${event}\ndata: ${payload}\n\n`;
    for (const client of this.#clients) {
      if (client.closed) continue;
      try {
        client.response.write(frame);
      } catch {
        client.closed = true;
        this.#clients.delete(client);
      }
    }
  }

  stop(): void {
    clearInterval(this.#heartbeat);
    for (const client of this.#clients) {
      client.closed = true;
      client.response.end();
    }
    this.#clients.clear();
  }
}
