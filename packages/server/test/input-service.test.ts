import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { NativeInput } from '../src/input/native';

import { InputChannel } from '../src/input/channel';
import { InputService, INPUT_PATH } from '../src/input/service';
import { InputStore } from '../src/input/store';
import { EventHub } from '../src/services/events';

class FakeNative implements NativeInput {
  screens = 1;
  accessibility = true;
  inputMonitoring = true;
  started: string[][] = [];
  stopped = 0;
  resets = 0;
  queue: unknown[] = [];
  inputs: { kind: string }[] = [];
  status() {
    return JSON.stringify({
      screens: this.screens,
      accessibility: this.accessibility,
      inputMonitoring: this.inputMonitoring,
    });
  }
  requestPermissions() {}
  start(role: string, edge: string) {
    this.started.push([role, edge]);
  }
  stop() {
    this.stopped++;
    this.queue = [];
  }
  reset() {
    this.resets++;
    this.queue = [];
  }
  poll() {
    const out = JSON.stringify(this.queue);
    this.queue = [];
    return out;
  }
  inject(value: string) {
    this.inputs.push(JSON.parse(value) as { kind: string });
  }
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function device(name: string, role: 'server' | 'client' = 'server') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lanfly-input-'));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const events = new EventHub();
  cleanup.push(() => events.stop());
  const native = new FakeNative();
  const store = new InputStore(directory);
  const service = new InputService(name, events, { store, native, supported: true });
  await service.initialize();
  await service.configure({ role, edge: 'right' });
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => service.upgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        service.stop();
        server.close(() => resolve());
      }),
  );
  return { service, native, store, target: { host: '127.0.0.1', port: address.port } };
}

async function waitFor(condition: () => boolean) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 5000) throw new Error('input state timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function pair(a: Awaited<ReturnType<typeof device>>, b: Awaited<ReturnType<typeof device>>) {
  a.service.enable();
  b.service.enable();
  await b.service.connect(a.target);
  await waitFor(() => Boolean(a.service.status().pairingCode && b.service.status().pairingCode));
  const code = a.service.status().pairingCode!;
  expect(b.service.status().pairingCode).toBe(code);
  a.service.confirm(code);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(a.native.started).toHaveLength(0);
  expect(b.native.started).toHaveLength(0);
  b.service.confirm(code);
  await waitFor(
    () => a.service.status().phase === 'connected' && b.service.status().phase === 'connected',
  );
}

describe('one-to-one input service', () => {
  it('requires both approvals, streams events, returns locally, and restores on disconnect', async () => {
    const a = await device('Source');
    const b = await device('Receiver', 'client');
    await pair(a, b);
    expect(a.native.started).toEqual([['server', 'right']]);
    expect(b.native.started).toEqual([['client', 'left']]);
    a.native.queue.push({ kind: 'enter', x: 1, y: 0.4 }, { kind: 'event', t: 10, key: 12 });
    await waitFor(() => b.native.inputs.some((input) => input.kind === 'event'));
    expect(a.service.status().controlling).toBe(true);
    b.native.queue.push({ kind: 'leave' });
    await waitFor(() => !a.service.status().controlling);
    expect(a.native.resets).toBe(1);
    const stopped = a.native.stopped;
    b.service.disable();
    await waitFor(() => a.service.status().phase === 'waiting');
    expect(a.native.stopped).toBeGreaterThan(stopped);
    const saved = new InputStore(path.dirname(a.store.file));
    await saved.load();
    expect(saved.publicKey).toBe(a.store.publicKey);
    expect(saved.data?.paired?.key).toBe(b.store.publicKey);
    expect((await stat(a.store.file)).mode & 0o777).toBe(0o600);
  });

  it('reconnects a pinned peer without asking for pairing again', async () => {
    const a = await device('Source');
    const b = await device('Receiver', 'client');
    await pair(a, b);
    b.service.disable();
    await waitFor(() => a.service.status().phase === 'waiting');
    b.service.enable();
    await waitFor(
      () => a.service.status().phase === 'connected' && b.service.status().phase === 'connected',
    );
    expect(a.native.started).toHaveLength(2);
  });

  it('rejects a second client and leaves the existing session intact', async () => {
    const a = await device('Source');
    const b = await device('Receiver', 'client');
    await pair(a, b);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: a.target.host,
          port: a.target.port,
          path: INPUT_PATH,
          headers: { connection: 'Upgrade', upgrade: 'lanfly-input-v1' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(a.service.status().phase).toBe('connected');
  });

  it('rejects keyboard events received before local pairing approval', async () => {
    const a = await device('Source');
    const b = await device('Unapproved', 'client');
    a.service.enable();
    await new Promise<void>((resolve, reject) => {
      const request = http.request({
        hostname: a.target.host,
        port: a.target.port,
        path: INPUT_PATH,
        headers: { connection: 'Upgrade', upgrade: 'lanfly-input-v1' },
      });
      request.on('error', reject);
      request.on('upgrade', (_response, socket, head) => {
        const channel = new InputChannel(socket, {
          role: 'client',
          name: 'Unapproved',
          key: b.store.key!,
          publicKey: b.store.publicKey,
        });
        channel.on('hello', () =>
          channel.send({ type: 'events', events: [{ kind: 'event', t: 10, key: 1 }] }),
        );
        channel.once('closed', resolve);
        channel.start(head);
      });
      request.end();
    });
    expect(a.native.started).toHaveLength(0);
    expect(a.native.inputs).toHaveLength(0);
    expect(a.store.data?.paired).toBeUndefined();
  });

  it('rejects a different identity after pairing without replacing the trusted key', async () => {
    const a = await device('Source');
    const b = await device('Receiver', 'client');
    await pair(a, b);
    b.service.disable();
    await waitFor(() => a.service.status().phase === 'waiting');
    const c = await device('Impostor', 'client');
    c.service.enable();
    await c.service.connect(a.target);
    await waitFor(() => a.service.status().error === 'INPUT_PEER_CHANGED');
    expect(a.store.data?.paired?.key).toBe(b.store.publicKey);
    expect(c.native.started).toHaveLength(0);
  });

  it('stops on display changes and emergency, and does not re-enable after emergency', async () => {
    const a = await device('Source');
    const b = await device('Receiver', 'client');
    await pair(a, b);
    a.native.queue.push({ kind: 'emergency' });
    await waitFor(() => !a.service.status().enabled);
    await waitFor(() => b.service.status().phase === 'waiting');
    expect(a.service.status().phase).toBe('disabled');
    b.native.screens = 2;
    await waitFor(() => !b.service.status().enabled);
    expect(b.service.status().error).toBe('INPUT_SINGLE_SCREEN');
  });

  it('fails closed for missing permissions, multiple screens, unsupported systems, and corrupt storage', async () => {
    const a = await device('Source');
    a.native.accessibility = false;
    expect(() => a.service.enable()).toThrow();
    expect(a.native.started).toHaveLength(0);
    a.native.accessibility = true;
    a.native.screens = 2;
    expect(() => a.service.enable()).toThrow();
    const events = new EventHub();
    cleanup.push(() => events.stop());
    const unsupported = new InputService('Linux', events, { supported: false });
    expect(unsupported.status().supported).toBe(false);
    expect(() => unsupported.enable()).toThrow();
    unsupported.stop();
    const content = JSON.parse(await readFile(a.store.file, 'utf8')) as { settings: unknown };
    expect(content.settings).toEqual({ role: 'server', edge: 'right' });
    await writeFile(a.store.file, '{broken config');
    const broken = new InputService('Broken', events, {
      store: new InputStore(path.dirname(a.store.file)),
      native: new FakeNative(),
      supported: true,
    });
    await broken.initialize();
    expect(broken.status().error).toBe('INPUT_CONFIG_ERROR');
    expect(() => broken.enable()).toThrow();
  });
});
