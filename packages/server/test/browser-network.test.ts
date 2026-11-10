import type { AppState, SendFileResult } from '@lanfly/common';

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'superjson';

import { Application } from '../src/app';
import { createServerConfig } from '../src/config';
import { randomToken } from '../src/core/security';
import { BROWSER_FILE_TTL } from '../src/services/browser-network';

type Device = { app: Application; id: string; cookie?: string; name: string };
const apps: Application[] = [];
const roots: string[] = [];
const previousConfig = process.env.LANFLY_CONFIG_DIR;
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (previousConfig === undefined) delete process.env.LANFLY_CONFIG_DIR;
  else process.env.LANFLY_CONFIG_DIR = previousConfig;
});

async function host(name: string, secret?: string): Promise<Device> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lanfly-browser-test-'));
  roots.push(root);
  process.env.LANFLY_CONFIG_DIR = path.join(root, 'config');
  const app = new Application(
    createServerConfig({
      name,
      secret,
      port: 0,
      noDiscovery: true,
      outDir: path.join(root, 'downloads'),
    }),
  );
  apps.push(app);
  await app.start();
  return { app, id: app.identity.id, name };
}
function base(app: Application) {
  return `http://127.0.0.1:${app.identity.port}`;
}
async function join(
  app: Application,
  name: string,
  password?: string,
  token = randomToken(),
  cookie?: string,
): Promise<Device> {
  const response = await fetch(`${base(app)}/api/v1/browser/join`, {
    method: 'POST',
    headers: {
      origin: base(app),
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ token, name, password }),
  });
  if (!response.ok) throw new Error(`join ${response.status}: ${await response.text()}`);
  const { id } = (await response.json()) as { id: string };
  return { app, id, name, cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
async function rpc<T>(device: Device, action: string, input?: unknown): Promise<T> {
  const url = `${base(device.app)}${device.cookie ? '/api/v1/browser/rpc/' : '/__rpc/'}${action}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      origin: base(device.app),
      'content-type': 'application/json',
      ...(device.cookie ? { cookie: device.cookie } : {}),
    },
    body: input === undefined ? undefined : stringify(input),
  });
  if (!response.ok) throw new Error(`${action} ${response.status}: ${await response.text()}`);
  const [error, data] = parse<[{ code: string } | null, T]>(await response.text());
  if (error) throw new Error(error.code);
  return data;
}
async function state(device: Device) {
  return rpc<AppState>(device, 'appState');
}
async function connect(a: Device, b: Device) {
  await a.app.connectPeer({ address: base(b.app) });
}
async function sync() {
  for (let i = 0; i < 2; i++) await Promise.all(apps.map((app) => app.network.sync()));
}
async function upload(device: Device, result: SendFileResult, bytes: string) {
  const response = await fetch(`${base(device.app)}${result.uploadUrl}`, {
    method: 'POST',
    headers: { origin: base(device.app), ...(device.cookie ? { cookie: device.cookie } : {}) },
    body: bytes,
  });
  expect(response.status).toBe(200);
}

describe('browser devices and one-hop routing', () => {
  it('all six devices communicate independently; B never introduces C to A', async () => {
    const a = await host('A');
    const b = await host('B');
    const c = await host('C');
    await connect(a, b);
    await connect(b, c);
    const a1 = await join(a.app, 'a1');
    const a2 = await join(a.app, 'a2');
    const b1 = await join(b.app, 'b1');
    const b2 = await join(b.app, 'b2');
    const c1 = await join(c.app, 'c1');
    await sync();
    const devices = [a, a1, a2, b, b1, b2];
    for (const device of devices) {
      const snapshot = await state(device);
      expect(snapshot.self.id).toBe(device.id);
      for (const other of devices.filter((d) => d !== device))
        expect(snapshot.peers.some((p) => p.id === other.id && p.online)).toBe(true);
    }
    for (const device of [a, a1, a2]) {
      expect((await state(device)).peers.some((p) => [c.id, c1.id].includes(p.id))).toBe(false);
    }
    for (const source of devices)
      for (const target of devices.filter((d) => d !== source)) {
        const text = `${source.name}->${target.name}`;
        await rpc(source, 'sendMessage', { peerId: target.id, text });
        const incoming = (await state(target)).messages.find(
          (m) => m.text === text && m.direction === 'in',
        );
        expect(incoming?.peerId).toBe(source.id);
        for (const other of devices.filter((d) => d !== source && d !== target))
          expect((await state(other)).messages.some((m) => m.text === text)).toBe(false);
      }
    // The gateway cannot be used as an arbitrary multi-hop router.
    const rejected = await fetch(`${base(a.app)}/api/v1/browser/rpc/sendMessage`, {
      method: 'POST',
      headers: { origin: base(a.app), cookie: a1.cookie! },
      body: stringify({ peerId: c.id, text: 'must fail' }),
    });
    expect(parse<[{ code: string }]>(await rejected.text())[0].code).toBe('PEER_UNREACHABLE');
    // Refreshing and multiple tabs retain one device identity.
    const again = await join(
      a.app,
      'a1 renamed',
      undefined,
      a1.cookie!.split('=')[1].split('.')[0],
    );
    expect(again.id).toBe(a1.id);
    expect(a.app.network.browsers.size).toBe(2);
  });

  it('files work in every direction, with isolated browser downloads and 30 minute expiry', async () => {
    const a = await host('A');
    const b = await host('B');
    await connect(a, b);
    const devices = [
      a,
      await join(a.app, 'a1'),
      await join(a.app, 'a2'),
      b,
      await join(b.app, 'b1'),
      await join(b.app, 'b2'),
    ];
    await sync();
    for (const source of devices)
      for (const target of devices.filter((d) => d !== source)) {
        const content = `${source.name}->${target.name}`;
        const file = {
          name: `${source.name}-${target.name}.txt`,
          size: Buffer.byteLength(content),
          mime: 'text/plain',
        };
        const sent = await rpc<SendFileResult>(source, 'sendFile', { peerId: target.id, file });
        await upload(source, sent, content);
        const received = (await state(target)).transfers.find((t) => t.id === sent.transferId)!;
        expect(received.status).toBe('completed');
        expect(received.peerId).toBe(source.id);
        if (target.cookie) {
          expect(received.downloadUrl).toBeTruthy();
          expect(received.expiresAt! - Date.now()).toBeGreaterThan(BROWSER_FILE_TTL - 5_000);
          for (let i = 0; i < 2; i++) {
            const download = await fetch(`${base(target.app)}${received.downloadUrl}`, {
              headers: { cookie: target.cookie },
            });
            expect(await download.text()).toBe(content);
          }
          const sibling = devices.find((d) => d.app === target.app && d.cookie && d !== target)!;
          const forbidden = await fetch(`${base(target.app)}${received.downloadUrl}`, {
            headers: { cookie: sibling.cookie! },
          });
          expect(forbidden.status).toBe(404);
          expect(
            (await state(target)).transfers.find((t) => t.id === received.id)?.downloadedAt,
          ).toBeGreaterThan(0);
          for (let i = 0; i < 50; i++) {
            if ((await state(source)).transfers.find((t) => t.id === received.id)?.downloadedAt)
              break;
            await Bun.sleep(10);
          }
          expect(
            (await state(source)).transfers.find((t) => t.id === received.id)?.downloadedAt,
          ).toBeGreaterThan(0);
        } else
          expect(
            await readFile(
              path.join(target.app.identity.downloadsDir, received.savedName!),
              'utf8',
            ),
          ).toBe(content);
      }
    await Promise.all(
      apps.map((app) => app.network.expireFiles(Date.now() + BROWSER_FILE_TTL + 1)),
    );
    for (const app of apps)
      expect((await readdir(app.network.cacheDir)).filter((name) => name !== 'owner.json')).toEqual(
        [],
      );
    const b1 = devices[4];
    const transfer = (await state(b1)).transfers.find((t) => t.direction === 'in')!;
    expect(transfer.expired).toBe(true);
    expect(transfer.downloadUrl).toBeUndefined();
    expect(
      (
        await fetch(`${base(b1.app)}/api/v1/browser/download/${transfer.id}`, {
          headers: { cookie: b1.cookie! },
        })
      ).status,
    ).toBe(404);
  });

  it('requires room password, rejects cross-origin and host administration, and reconnects after restart', async () => {
    const a = await host('private', 'secret');
    await expect(join(a.app, 'phone')).rejects.toThrow('401');
    const token = randomToken();
    const phone = await join(a.app, 'iOS', 'secret', token);
    for (const action of [
      'inputEnable',
      'inputRefresh',
      'openDownloads',
      'connectPeer',
      'forgetPeer',
    ]) {
      const response = await fetch(`${base(a.app)}/api/v1/browser/rpc/${action}`, {
        method: 'POST',
        headers: { origin: base(a.app), cookie: phone.cookie! },
      });
      expect(response.status).toBe(403);
    }
    const csrf = await fetch(`${base(a.app)}/api/v1/browser/join`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
      body: JSON.stringify({ token, name: 'evil', password: 'secret' }),
    });
    expect(csrf.status).toBe(403);
    const crossRoom = await host('other', 'different');
    expect(
      (
        await fetch(`${base(crossRoom.app)}/api/v1/browser/rpc/appState`, {
          method: 'POST',
          headers: { origin: base(crossRoom.app), cookie: phone.cookie! },
        })
      ).status,
    ).toBe(401);
    const originalCache = a.app.network.cacheDir;
    await writeFile(path.join(originalCache, 'orphan'), 'test');
    await a.app.stop();
    expect(await readdir(originalCache).catch(() => [])).toEqual([]);
    apps.splice(apps.indexOf(a.app), 1);
    // Simulate an unclean exit leaving a cache entry before the next startup.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(originalCache, { recursive: true });
    await writeFile(path.join(originalCache, 'orphan'), 'test');
    process.env.LANFLY_CONFIG_DIR = path.dirname(a.app.input.store.file);
    const restarted = new Application({ ...a.app.config, port: a.app.identity.port });
    apps.push(restarted);
    await restarted.start();
    expect(await readdir(restarted.network.cacheDir)).toEqual(['owner.json']);
    const restored = await join(restarted, 'iOS', undefined, token, phone.cookie);
    expect(restored.id).toBe(phone.id);
  });

  it('routes immediately after joining a password room and validates signed requests', async () => {
    const a = await host('A', 'shared');
    const b = await host('B', 'shared');
    await a.app.connectPeer({ address: `http://localhost:${b.app.identity.port}` });
    const phone = await join(a.app, 'phone', 'shared');
    // Delivery includes only the sender gateway's own leaves, so no roster polling race is required.
    await rpc(phone, 'sendMessage', { peerId: b.id, text: 'immediate' });
    expect((await state(b)).messages.find((m) => m.text === 'immediate')?.peerId).toBe(phone.id);
    await rpc(b, 'sendMessage', { peerId: phone.id, text: 'reply' });
    expect((await state(phone)).messages.some((m) => m.text === 'reply')).toBe(true);
    const content = 'private file';
    const sent = await rpc<SendFileResult>(phone, 'sendFile', {
      peerId: b.id,
      file: { name: 'private.txt', size: content.length, mime: 'text/plain' },
    });
    await upload(phone, sent, content);
    expect(await readFile(path.join(b.app.identity.downloadsDir, 'private.txt'), 'utf8')).toBe(
      content,
    );
    const unsigned = await fetch(`${base(b.app)}/api/v1/peer/browser/roster`, {
      method: 'POST',
      headers: { 'x-lanfly-id': a.id },
      body: JSON.stringify({ from: a.app.identity.info, browsers: a.app.network.localRoster() }),
    });
    expect(unsigned.status).toBe(401);
  });

  it('rejects uploads from another browser and wrong file sizes without caching incomplete data', async () => {
    const a = await host('A');
    const source = await join(a.app, 'sender');
    const target = await join(a.app, 'receiver');
    const sent = await rpc<SendFileResult>(source, 'sendFile', {
      peerId: target.id,
      file: { name: 'incomplete.txt', size: 10, mime: 'text/plain' },
    });
    const stolen = await fetch(`${base(a.app)}${sent.uploadUrl}`, {
      method: 'POST',
      headers: { origin: base(a.app), cookie: target.cookie! },
      body: '0123456789',
    });
    expect(stolen.status).toBe(409);
    const wrongSize = await fetch(`${base(a.app)}${sent.uploadUrl}`, {
      method: 'POST',
      headers: { origin: base(a.app), cookie: source.cookie! },
      body: 'short',
    });
    expect(wrongSize.status).toBe(400);
    expect((await state(source)).transfers.find((t) => t.id === sent.transferId)?.status).toBe(
      'failed',
    );
    expect((await readdir(a.app.network.cacheDir)).filter((name) => name !== 'owner.json')).toEqual(
      [],
    );
    const anonymous = await fetch(`${base(a.app)}/api/v1/browser/rpc/appState`, {
      method: 'POST',
      headers: { origin: base(a.app) },
    });
    expect(anonymous.status).toBe(401);
  });

  it('cleans the cache promptly even when a peer roster request is stuck', async () => {
    const a = await host('A');
    const hanging = createServer();
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    try {
      const address = hanging.address() as { port: number };
      a.app.peers.addManual(
        { ...a.app.identity.info, id: crypto.randomUUID(), name: 'stuck', port: address.port },
        '127.0.0.1',
      );
      const requested = new Promise<void>((resolve) => hanging.once('request', () => resolve()));
      const syncing = a.app.network.sync();
      await requested;
      const started = Date.now();
      await a.app.stop();
      await syncing;
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(await readdir(a.app.network.cacheDir).catch(() => [])).toEqual([]);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it('preserves corrupt configuration rather than overwriting it with browser keys', async () => {
    const a = await host('A');
    await a.app.stop();
    apps.splice(apps.indexOf(a.app), 1);
    const corrupt = '{corrupt';
    await writeFile(a.app.input.store.file, corrupt);
    process.env.LANFLY_CONFIG_DIR = path.dirname(a.app.input.store.file);
    const restarted = new Application(a.app.config);
    apps.push(restarted);
    await expect(restarted.start()).rejects.toThrow();
    expect(await readFile(a.app.input.store.file, 'utf8')).toBe(corrupt);
  });

  it('disconnects browser leaves and refuses forged rosters or third-hop destinations', async () => {
    const a = await host('A');
    const b = await host('B');
    await connect(a, b);
    const phone = await join(a.app, 'Android');
    await sync();
    const controller = new AbortController();
    const response = await fetch(`${base(a.app)}/api/v1/browser/events`, {
      headers: { cookie: phone.cookie! },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await response.body!.getReader().read();
    expect(a.app.network.localRoster().some((p) => p.id === phone.id)).toBe(true);
    controller.abort();
    await Bun.sleep(30);
    await sync();
    expect((await state(b)).peers.some((p) => p.id === phone.id && p.online)).toBe(false);
    expect(() =>
      b.app.network.acceptRoster(
        {
          from: a.app.identity.info,
          browsers: [
            {
              ...a.app.identity.info,
              id: 'web-fake',
              kind: 'browser',
              gatewayId: b.id,
              online: true,
            },
          ],
        },
        a.id,
      ),
    ).toThrow();
    expect(() =>
      b.app.network.receive(
        {
          from: a.app.identity.info,
          sender: { ...a.app.identity.info, id: 'web-unadvertised' },
          to: b.id,
          id: crypto.randomUUID(),
          text: 'spoof',
          browsers: [],
        },
        a.id,
      ),
    ).toThrow();
  });
});
