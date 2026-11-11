import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { NativeInput } from '../src/input/native';

import { InputService } from '../src/input/service';
import { InputStore } from '../src/input/store';
import { EventHub } from '../src/services/events';

class FakeNative implements NativeInput {
  screens = 1;
  accessibility = true;
  inputMonitoring = true;
  startError: string | undefined;
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
    if (this.startError) throw new Error(this.startError);
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

async function device(
  name: string,
  role: 'server' | 'client' = 'server',
  existing?: { directory: string; port: number; permissions?: boolean; roomId?: string },
) {
  const directory = existing?.directory ?? (await mkdtemp(path.join(os.tmpdir(), 'lanfly-input-')));
  if (!existing) cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const events = new EventHub();
  cleanup.push(() => events.stop());
  const native = new FakeNative();
  if (existing?.permissions === false) native.accessibility = false;
  const store = new InputStore(directory);
  const service = new InputService(name, events, {
    roomId: existing?.roomId ?? '123456',
    store,
    native,
    supported: true,
  });
  await service.initialize();
  if (!existing) await service.configure({ role, edge: 'right' });
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => service.upgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(existing?.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= service
      .stop()
      .then(() => new Promise<void>((resolve) => server.close(() => resolve()))));
  cleanup.push(close);
  service.listen(address.port);
  service.resume();
  return { service, native, store, close, target: { host: '127.0.0.1', port: address.port } };
}

async function waitFor(condition: () => boolean) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 5000) throw new Error('input state timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function link(
  a: Awaited<ReturnType<typeof device>>,
  b: Awaited<ReturnType<typeof device>>,
  role: 'server' | 'client' = 'server',
) {
  await a.service.connect(b.target, { role, edge: 'right' });
  await waitFor(
    () => a.service.status().phase === 'connected' && b.service.status().phase === 'connected',
  );
}

describe('room-scoped one-to-one input service', () => {
  it('a server initiates and the idle peer automatically becomes the controlled client', async () => {
    const a = await device('A');
    const b = await device('B');
    await link(a, b);
    expect(a.service.status().settings.role).toBe('server');
    expect(b.service.status().settings.role).toBe('client');
    expect(a.native.started).toEqual([['server', 'right']]);
    expect(b.native.started).toEqual([['client', 'left']]);
    expect(a.store.data?.target?.roomId).toBe('123456');
    expect(b.store.data?.target?.port).toBe(a.target.port);
    a.native.queue.push(
      { kind: 'enter', x: 1, y: 0.5 },
      { kind: 'input-source' },
      { kind: 'event', t: 10, key: 0, flags: 0 },
    );
    await waitFor(() => b.native.inputs.some((e) => e.kind === 'input-source'));
    expect(a.service.status().controlling).toBe(true);
    expect(b.native.inputs.some((e) => e.kind === 'event')).toBe(true);
    b.native.queue.push({ kind: 'leave' });
    await waitFor(() => !a.service.status().controlling);
    expect(a.native.resets).toBeGreaterThan(0);
  });
  it('a client initiates and the peer automatically becomes the controlling server', async () => {
    const a = await device('A');
    const b = await device('B', 'client');
    await link(a, b, 'client');
    expect(a.service.status().settings.role).toBe('client');
    expect(b.service.status().settings.role).toBe('server');
    expect(a.native.started).toEqual([['client', 'left']]);
    expect(b.native.started).toEqual([['server', 'right']]);
    b.native.queue.push(
      { kind: 'enter', x: 1, y: 0.5 },
      { kind: 'event', t: 10, key: 1, flags: 0 },
    );
    await waitFor(() => a.native.inputs.some((e) => e.kind === 'event'));
  });
  it('can reverse both roles from either local UI on an existing connection', async () => {
    const a = await device('A');
    const b = await device('B');
    await link(a, b);
    await link(a, b, 'client');
    expect(a.service.status().settings.role).toBe('client');
    expect(b.service.status().settings.role).toBe('server');
    await link(a, b, 'server');
    expect(a.service.status().settings.role).toBe('server');
    expect(b.service.status().settings.role).toBe('client');
  });

  it('resolves simultaneous connection attempts to one controlling host', async () => {
    const a = await device('A');
    const b = await device('B');
    await Promise.all([a.service.connect(b.target), b.service.connect(a.target)]);
    await waitFor(
      () => a.service.status().phase === 'connected' && b.service.status().phase === 'connected',
    );
    expect(a.service.status().settings.role).not.toBe(b.service.status().settings.role);
    expect(a.native.started).toHaveLength(1);
    expect(b.native.started).toHaveLength(1);
  });

  it('rejects another room without changing the target role or starting native input', async () => {
    const a = await device('A');
    const b = await device('B');
    const c = await device('C', 'server', {
      directory: path.dirname(a.store.file),
      port: 0,
      roomId: 'other',
    });
    await c.service.connect(b.target);
    await waitFor(() => c.service.status().error === 'INPUT_CONNECT_FAILED');
    expect(b.service.status().enabled).toBe(false);
    expect(b.service.status().settings.role).toBe('server');
    expect(b.native.started).toHaveLength(0);
    expect(b.store.data?.target).toBeUndefined();
  });
  it('keeps an existing connection when a third device attempts to take over', async () => {
    const a = await device('A');
    const b = await device('B');
    const c = await device('C');
    await link(a, b);
    await c.service.connect(b.target);
    await waitFor(() => c.service.status().error === 'INPUT_CONNECT_FAILED');
    expect(b.store.data?.target?.id).toBe(a.store.data!.id);
    expect(b.service.status().phase).toBe('connected');
    expect(b.native.started).toHaveLength(1);
  });
  it('requires both devices system permissions and can retry after refreshing', async () => {
    const a = await device('A');
    const b = await device('B');
    b.native.accessibility = false;
    await a.service.connect(b.target);
    await waitFor(() => a.service.status().error === 'INPUT_CONNECT_FAILED');
    expect(b.native.started).toHaveLength(0);
    expect(b.service.status().enabled).toBe(false);
    b.native.accessibility = true;
    b.service.refresh();
    await waitFor(() => b.service.status().phase === 'connected');
    expect(a.service.status().phase).toBe('connected');
  });
  it('restores saved roles and connections after either startup order in the same room', async () => {
    const a = await device('A');
    const b = await device('B');
    await link(a, b);
    await b.close();
    await a.close();
    const b2 = await device('B', 'client', {
      directory: path.dirname(b.store.file),
      port: b.target.port,
    });
    const a2 = await device('A', 'server', {
      directory: path.dirname(a.store.file),
      port: a.target.port,
    });
    await waitFor(
      () => a2.service.status().phase === 'connected' && b2.service.status().phase === 'connected',
    );
    expect(a2.store.data?.target?.id).toBe(b2.store.data!.id);
  });
  it('does not restore a connection saved in a different room', async () => {
    const a = await device('A');
    const b = await device('B');
    await link(a, b);
    await a.close();
    const a2 = await device('A', 'server', {
      directory: path.dirname(a.store.file),
      port: a.target.port,
      roomId: 'new',
    });
    expect(a2.service.status().enabled).toBe(false);
    expect(a2.native.started).toHaveLength(0);
  });
  it('manual stop and emergency stop stop both sides and keep automatic restoration off', async () => {
    const a = await device('A');
    const b = await device('B');
    await link(a, b);
    await a.service.disable();
    await waitFor(() => !b.service.status().enabled);
    expect(a.store.data?.autoStart).toBe(false);
    expect(b.store.data?.autoStart).toBe(false);
    await link(a, b);
    b.native.queue.push({ kind: 'emergency' });
    await waitFor(() => !a.service.status().enabled && !b.service.status().enabled);
    expect(a.store.data?.autoStart).toBe(false);
    expect(b.store.data?.autoStart).toBe(false);
  });
  it('revoked permissions and display changes restore local input', async () => {
    const a = await device('A');
    const b = await device('B');
    await link(a, b);
    a.native.screens = 2;
    await waitFor(() => !a.service.status().enabled);
    expect(a.service.status().error).toBe('INPUT_SINGLE_SCREEN');
    expect(a.native.stopped).toBeGreaterThan(0);
  });
  it('fails closed when cursor capture cannot start and when the native watchdog reports failure', async () => {
    const a = await device('A');
    const b = await device('B');
    a.native.startError = 'INPUT_CURSOR_CAPTURE';
    await a.service.connect(b.target);
    await waitFor(() => a.service.status().error === 'INPUT_CURSOR_CAPTURE');
    expect(a.service.status().enabled).toBe(false);
    a.native.startError = undefined;
    await waitFor(() => b.service.status().phase !== 'connected');
    await link(a, b);
    a.native.queue.push({ kind: 'fault', reason: 'cursor' });
    await waitFor(() => !a.service.status().enabled);
    expect(a.service.status().controlling).toBe(false);
  });
  it('refreshes a blocked saved connection after permission is granted without restart', async () => {
    const a = await device('A');
    const b = await device('B');
    await link(a, b);
    await a.close();
    const a2 = await device('A', 'server', {
      directory: path.dirname(a.store.file),
      port: a.target.port,
      permissions: false,
    });
    expect(a2.service.status().error).toBe('INPUT_PERMISSION');
    expect(a2.native.started).toHaveLength(0);
    a2.native.accessibility = true;
    a2.service.refresh();
    await waitFor(() => a2.service.status().phase === 'connected');
  });
  it('rejects unsupported systems and corrupt configuration without starting input', async () => {
    const events = new EventHub();
    cleanup.push(() => events.stop());
    const unsupported = new InputService('Linux', events, { roomId: '123456', supported: false });
    await expect(unsupported.enable()).rejects.toHaveProperty('code', 'INPUT_UNSUPPORTED');
    await unsupported.stop();
    const a = await device('A');
    await writeFile(a.store.file, '{broken');
    const broken = new InputService('Broken', events, {
      roomId: '123456',
      store: new InputStore(path.dirname(a.store.file)),
      native: new FakeNative(),
      supported: true,
    });
    await broken.initialize();
    expect(broken.status().error).toBe('INPUT_CONFIG_ERROR');
    await expect(broken.enable()).rejects.toHaveProperty('code', 'INPUT_CONFIG_ERROR');
  });
});
