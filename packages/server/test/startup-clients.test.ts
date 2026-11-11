import type { ServerResponse } from 'node:http';

import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Application } from '../src/app';
import { createServerConfig } from '../src/config';
import { EventHub } from '../src/services/events';

function fakeResponse() {
  const frames: string[] = [];
  const response = {
    writeHead() {},
    write(frame: string) {
      frames.push(frame);
      return true;
    },
    on() {},
    end() {},
  } as unknown as ServerResponse;
  return { response, frames };
}

async function newApp() {
  const directory = await mkdtemp(path.join(tmpdir(), 'lanfly-startup-'));
  const app = new Application(
    createServerConfig({
      name: 'StartupTest',
      roomId: '123456',
      port: 0,
      outDir: directory,
      noDiscovery: true,
      verbose: false,
    }),
  );
  return { app, directory };
}

describe('startup page refresh', () => {
  it('detects a reconnected local page and broadcasts reload', async () => {
    const { app, directory } = await newApp();
    try {
      const page = fakeResponse();
      app.events.add(page.response);
      const result = await app.waitForStartupClients(120);
      expect(result.local).toBe(true);
      expect(result.localPages).toBe(1);
      expect(page.frames.some((frame) => frame.includes('event: reload'))).toBe(true);
    } finally {
      app.events.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('broadcasts reload to directly connected browser devices too', async () => {
    const { app, directory } = await newApp();
    try {
      const events = new EventHub();
      const page = fakeResponse();
      events.add(page.response);
      (app.network.browsers as unknown as Map<string, { events: EventHub; host: string }>).set(
        'browser-1',
        { events, host: app.identity.host },
      );
      const result = await app.waitForStartupClients(50);
      expect(result.browserPages).toBe(1);
      expect(page.frames.some((frame) => frame.includes('event: reload'))).toBe(true);
      events.stop();
    } finally {
      app.events.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not refresh a browser page opened from another native peer host', async () => {
    const { app, directory } = await newApp();
    try {
      app.peers.addManual(
        { id: 'peer-1', name: 'Peer', port: 18088, version: '0.3.0', roomId: '123456' },
        '192.168.1.50',
      );
      const events = new EventHub();
      const page = fakeResponse();
      events.add(page.response);
      (app.network.browsers as unknown as Map<string, { events: EventHub; host: string }>).set(
        'peer-page',
        { events, host: '192.168.1.50' },
      );
      expect(app.network.reloadBrowsers()).toBe(0);
      expect(page.frames.some((frame) => frame.includes('event: reload'))).toBe(false);
      events.stop();
    } finally {
      app.events.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports no local page and does not broadcast when nobody is connected', async () => {
    const { app, directory } = await newApp();
    try {
      const result = await app.waitForStartupClients(50);
      expect(result.local).toBe(false);
      expect(result.localPages).toBe(0);
      expect(result.browserPages).toBe(0);
    } finally {
      app.events.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
