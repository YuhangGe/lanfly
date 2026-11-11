import type { AppState, FileUploadRequest, SendFileResult } from '@lanfly/common';

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'superjson';

import { Application } from '../src/app';
import { createServerConfig } from '../src/config';
import { randomToken } from '../src/core/security';
import { BROWSER_OFFER_TTL } from '../src/services/browser-network';

type Device = { app: Application; id: string; cookie?: string; name: string };
const apps: Application[] = [];
const roots: string[] = [];
const streams: AbortController[] = [];
const streamErrors: unknown[] = [];
const previousConfig = process.env.LANFLY_CONFIG_DIR;
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.abort();
  await Promise.all(apps.splice(0).map((app) => app.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  expect(streamErrors.splice(0)).toEqual([]);
  if (previousConfig === undefined) delete process.env.LANFLY_CONFIG_DIR;
  else process.env.LANFLY_CONFIG_DIR = previousConfig;
});

async function host(name: string, roomId = '123456'): Promise<Device> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lanfly-browser-test-'));
  roots.push(root);
  process.env.LANFLY_CONFIG_DIR = path.join(root, 'config');
  const app = new Application(
    createServerConfig({
      name,
      roomId,
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
    body: JSON.stringify({ token, name }),
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

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for file transfer');
}
async function listen(device: Device, onRequest?: (request: FileUploadRequest) => Promise<void>) {
  const controller = new AbortController();
  streams.push(controller);
  const response = await fetch(
    `${base(device.app)}${device.cookie ? '/api/v1/browser/events' : '/events'}`,
    { headers: device.cookie ? { cookie: device.cookie } : {}, signal: controller.signal },
  );
  expect(response.status).toBe(200);
  const events: FileUploadRequest[] = [];
  const tasks: Promise<void>[] = [];
  void (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for await (const bytes of response.body!) {
        buffer += decoder.decode(bytes, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!frame.includes('event: file-upload-request')) continue;
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          const request = JSON.parse(line!.slice(6)) as FileUploadRequest;
          events.push(request);
          if (onRequest) {
            const task = onRequest(request);
            tasks.push(task);
            void task.catch((e) => streamErrors.push(e));
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) streamErrors.push(error);
    }
  })();
  return { controller, events, tasks };
}

describe('browser devices and one-hop routing', () => {
  it('records the browser source address and exposes it as the device IP', async () => {
    const a = await host('Host');
    const browser = await join(a.app, 'Android 浏览器');
    const peer = a.app.network.peers().find((item) => item.id === browser.id);
    expect(peer?.host).toBe('127.0.0.1');
    expect(peer?.port).toBe(a.app.identity.port);
  });

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
    const again = await join(a.app, 'a1 renamed', a1.cookie!.split('=')[1].split('.')[0]);
    expect(again.id).toBe(a1.id);
    expect(a.app.network.browsers.size).toBe(2);
  });

  it('streams files in all directions; browser recipients request fresh uploads without relay files', async () => {
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
    const held = new Map<string, { result: SendFileResult; content: string }>();
    const senders = await Promise.all(
      devices.map((device) =>
        listen(device, async (request) => {
          const file = held.get(request.transferId)!;
          await upload(device, { ...file.result, uploadUrl: request.uploadUrl }, file.content);
        }),
      ),
    );
    for (const source of devices)
      for (const target of devices.filter((d) => d !== source)) {
        const content = `${source.name}->${target.name}`;
        const sent = await rpc<SendFileResult>(source, 'sendFile', {
          peerId: target.id,
          file: {
            name: `${source.name}-${target.name}.txt`,
            size: Buffer.byteLength(content),
            mime: 'text/plain',
          },
        });
        held.set(sent.transferId, { result: sent, content });
        if (target.cookie) {
          expect(sent.deferred).toBe(true);
          const received = (await state(target)).transfers.find((t) => t.id === sent.transferId)!;
          expect(received.status).toBe('ready');
          expect(received.bytes).toBe(0);
          expect(received.expiresAt! - Date.now()).toBeGreaterThan(BROWSER_OFFER_TTL - 5000);
          for (let i = 0; i < 2; i++) {
            const download = await fetch(`${base(target.app)}${received.downloadUrl}`, {
              headers: { cookie: target.cookie },
            });
            expect(download.status).toBe(200);
            expect(await download.text()).toBe(content);
            await waitFor(
              async () =>
                (await state(source)).transfers.find((t) => t.id === sent.transferId)?.status ===
                'completed',
            );
          }
          expect(
            senders[devices.indexOf(source)].events.filter((e) => e.transferId === sent.transferId),
          ).toHaveLength(2);
          expect(
            (await state(target)).transfers.find((t) => t.id === received.id)?.downloadedAt,
          ).toBeGreaterThan(0);
          const sibling = devices.find((d) => d.app === target.app && d.cookie && d !== target)!;
          expect(
            (
              await fetch(`${base(target.app)}${received.downloadUrl}`, {
                headers: { cookie: sibling.cookie! },
              })
            ).status,
          ).toBe(404);
        } else {
          expect(sent.deferred).not.toBe(true);
          await upload(source, sent, content);
          const received = (await state(target)).transfers.find((t) => t.id === sent.transferId)!;
          expect(received.status).toBe('completed');
          expect(
            await readFile(
              path.join(target.app.identity.downloadsDir, received.savedName!),
              'utf8',
            ),
          ).toBe(content);
        }
      }
    await Promise.all(senders.flatMap((s) => s.tasks));
    await Promise.all(
      apps.map((app) => app.network.expireOffers(Date.now() + BROWSER_OFFER_TTL + 1)),
    );
    const target = devices[4];
    const transfer = (await state(target)).transfers.find((t) => t.direction === 'in')!;
    expect(transfer.expired).toBe(true);
    expect(transfer.downloadUrl).toBeUndefined();
    expect(
      (
        await fetch(`${base(target.app)}/api/v1/browser/download/${transfer.id}`, {
          headers: { cookie: target.cookie! },
        })
      ).status,
    ).toBe(404);
  });

  it('forwards the first bytes before the sender finishes, including A-to-B browser routing', async () => {
    const a = await host('A');
    const b = await host('B');
    await connect(a, b);
    const source = await join(a.app, 'Android');
    const target = await join(b.app, 'iOS');
    await sync();
    const sender = await listen(source);
    const sent = await rpc<SendFileResult>(source, 'sendFile', {
      peerId: target.id,
      file: { name: 'stream.bin', size: 128 * 1024, mime: 'application/octet-stream' },
    });
    expect(sent.deferred).toBe(true);
    expect(sender.events).toHaveLength(0);
    expect(await readdir(a.app.identity.downloadsDir)).toEqual([]);
    expect(await readdir(b.app.identity.downloadsDir)).toEqual([]);
    const controller = new AbortController();
    const downloading = fetch(`${base(target.app)}/api/v1/browser/download/${sent.transferId}`, {
      headers: { cookie: target.cookie! },
      signal: controller.signal,
    });
    await waitFor(() => sender.events.length === 1);
    const instruction = sender.events[0];
    let finishUpload!: (status: number) => void;
    const finished = new Promise<number>((resolve) => {
      finishUpload = resolve;
    });
    const request = httpRequest(
      `${base(source.app)}${instruction.uploadUrl}`,
      {
        method: 'POST',
        headers: { origin: base(source.app), cookie: source.cookie!, 'content-length': 128 * 1024 },
      },
      (response) => {
        response.resume();
        response.on('end', () => finishUpload(response.statusCode!));
      },
    );
    request.on('error', () => finishUpload(0));
    request.write(Buffer.alloc(64 * 1024, 65));
    const response = await downloading;
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.value!.length).toBeGreaterThan(0);
    expect(first.value![0]).toBe(65);
    expect(request.writableEnded).toBe(false);
    request.end(Buffer.alloc(64 * 1024, 66));
    let bytes = first.value!.length;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
    }
    expect(bytes).toBe(128 * 1024);
    expect(await finished).toBe(200);
    expect(await readdir(a.app.identity.downloadsDir)).toEqual([]);
    expect(await readdir(b.app.identity.downloadsDir)).toEqual([]);
  });

  it('aborts the upstream upload when a cross-host download is canceled mid-stream', async () => {
    const a = await host('A');
    const b = await host('B');
    await connect(a, b);
    const source = await join(a.app, 'Android');
    const target = await join(b.app, 'iOS');
    await sync();
    const sender = await listen(source);
    const sent = await rpc<SendFileResult>(source, 'sendFile', {
      peerId: target.id,
      file: { name: 'abort.bin', size: 1024 * 1024, mime: 'application/octet-stream' },
    });
    const controller = new AbortController();
    const downloading = fetch(`${base(b.app)}/api/v1/browser/download/${sent.transferId}`, {
      headers: { cookie: target.cookie! },
      signal: controller.signal,
    });
    await waitFor(() => sender.events.length === 1);
    let ended = false;
    const request = httpRequest(
      `${base(a.app)}${sender.events[0].uploadUrl}`,
      {
        method: 'POST',
        headers: { origin: base(a.app), cookie: source.cookie!, 'content-length': 1024 * 1024 },
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          ended = true;
        });
      },
    );
    request.on('error', () => {
      ended = true;
    });
    request.write(Buffer.alloc(64 * 1024, 65));
    const response = await downloading;
    const reader = response.body!.getReader();
    expect((await reader.read()).value!.length).toBeGreaterThan(0);
    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(() => ended);
    await waitFor(
      () =>
        !a.app.network.outgoing.get(sent.transferId)?.completion &&
        !b.app.network.incoming.get(sent.transferId)?.active,
    );
    expect((await state(source)).transfers.find((t) => t.id === sent.transferId)?.status).toBe(
      'failed',
    );
    expect((await state(target)).transfers.find((t) => t.id === sent.transferId)?.status).toBe(
      'failed',
    );
    expect(await readdir(a.app.identity.downloadsDir)).toEqual([]);
    expect(await readdir(b.app.identity.downloadsDir)).toEqual([]);
    request.destroy();
  });

  it('handles offline or unresponsive senders without leaving a waiting download', async () => {
    const a = await host('A');
    const source = await join(a.app, 'Android');
    const target = await join(a.app, 'iOS');
    a.app.network.downloadWaitTimeoutMs = 30;
    const sent = await rpc<SendFileResult>(source, 'sendFile', {
      peerId: target.id,
      file: { name: 'missing.txt', size: 1, mime: 'text/plain' },
    });
    const offline = await fetch(`${base(a.app)}/api/v1/browser/download/${sent.transferId}`, {
      headers: { cookie: target.cookie! },
    });
    expect(offline.status).toBe(504);
    expect((await state(target)).transfers.find((t) => t.id === sent.transferId)?.error).toBe(
      'FILE_SOURCE_UNAVAILABLE',
    );
    const sender = await listen(source);
    const unresponsive = await fetch(`${base(a.app)}/api/v1/browser/download/${sent.transferId}`, {
      headers: { cookie: target.cookie! },
    });
    expect(unresponsive.status).toBe(504);
    expect(sender.events).toHaveLength(1);
    await waitFor(() => !a.app.network.outgoing.get(sent.transferId)?.sessionId);
    expect(a.app.network.incoming.get(sent.transferId)?.active).toBeUndefined();
    expect(await readdir(a.app.identity.downloadsDir)).toEqual([]);
  });

  it('cancels a pending download and supports a new download session; offers can be revoked', async () => {
    const a = await host('A');
    const b = await host('B');
    await connect(a, b);
    const source = await join(a.app, 'Android');
    const target = await join(b.app, 'iOS');
    await sync();
    const sender = await listen(source);
    const sent = await rpc<SendFileResult>(source, 'sendFile', {
      peerId: target.id,
      file: { name: 'cancel.txt', size: 3, mime: 'text/plain' },
    });
    const controller = new AbortController();
    const download = fetch(`${base(b.app)}/api/v1/browser/download/${sent.transferId}`, {
      headers: { cookie: target.cookie! },
      signal: controller.signal,
    });
    void download.catch(() => {});
    await waitFor(() => sender.events.length === 1);
    controller.abort();
    await expect(download).rejects.toThrow();
    await waitFor(
      () =>
        !a.app.network.outgoing.get(sent.transferId)?.sessionId &&
        !b.app.network.incoming.get(sent.transferId)?.active,
    );
    const next = fetch(`${base(b.app)}/api/v1/browser/download/${sent.transferId}`, {
      headers: { cookie: target.cookie! },
    });
    await waitFor(() => sender.events.length === 2);
    expect(sender.events[0].sessionId).not.toBe(sender.events[1].sessionId);
    const stale = await fetch(`${base(a.app)}${sender.events[0].uploadUrl}`, {
      method: 'POST',
      headers: { origin: base(a.app), cookie: source.cookie! },
      body: 'old',
    });
    expect(stale.status).toBe(409);
    const uploading = upload(source, { ...sent, uploadUrl: sender.events[1].uploadUrl }, 'new');
    expect(await (await next).text()).toBe('new');
    await uploading;
    await rpc(source, 'cancelTransfer', { transferId: sent.transferId });
    await waitFor(
      async () =>
        (await state(target)).transfers.find((t) => t.id === sent.transferId)?.status ===
        'canceled',
    );
    expect(
      (
        await fetch(`${base(b.app)}/api/v1/browser/download/${sent.transferId}`, {
          headers: { cookie: target.cookie! },
        })
      ).status,
    ).toBe(404);
  });

  it('browser joins without a Room ID, rejects cross-origin and host administration, and reconnects after restart', async () => {
    const a = await host('private', 'secret');
    expect((await join(a.app, 'phone')).id).toStartWith('web-');
    const token = randomToken();
    const phone = await join(a.app, 'iOS', token);
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
      body: JSON.stringify({ token, name: 'evil', roomId: 'not-required' }),
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
    await a.app.stop();
    apps.splice(apps.indexOf(a.app), 1);
    process.env.LANFLY_CONFIG_DIR = path.dirname(a.app.input.store.file);
    const restarted = new Application({ ...a.app.config, port: a.app.identity.port });
    apps.push(restarted);
    await restarted.start();
    const restored = await join(restarted, 'iOS', token, phone.cookie);
    expect(restored.id).toBe(phone.id);
  });

  it('routes immediately after joining and requires the room on native peer requests', async () => {
    const a = await host('A', 'shared');
    const b = await host('B', 'shared');
    await a.app.connectPeer({ address: `http://localhost:${b.app.identity.port}` });
    const phone = await join(a.app, 'phone');
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
      peerId: a.id,
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
    expect(await readdir(a.app.identity.downloadsDir)).toEqual([]);
    const anonymous = await fetch(`${base(a.app)}/api/v1/browser/rpc/appState`, {
      method: 'POST',
      headers: { origin: base(a.app) },
    });
    expect(anonymous.status).toBe(401);
  });

  it('stops promptly even when a peer roster request is stuck', async () => {
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
