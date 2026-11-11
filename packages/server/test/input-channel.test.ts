import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';

import { InputChannel } from '../src/input/channel';

class Wire extends Duplex {
  peer!: Wire;
  intercept: ((data: Buffer) => Buffer) | undefined;
  frames: Buffer[] = [];
  override _read() {}
  override _write(data: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.frames.push(Buffer.from(data));
    const copy = this.intercept ? this.intercept(Buffer.from(data)) : Buffer.from(data);
    // Fragment the length prefix and ciphertext to exercise real stream framing.
    queueMicrotask(() => {
      if (this.peer.destroyed) return;
      this.peer.push(copy.subarray(0, 2));
      this.peer.push(copy.subarray(2));
    });
    done();
  }
}

function identity(role: 'server' | 'client', roomId = '123456') {
  return { role, name: role, roomId, id: randomUUID() };
}
async function pair() {
  const a = new Wire();
  const b = new Wire();
  a.peer = b;
  b.peer = a;
  const server = new InputChannel(a, identity('server'));
  const client = new InputChannel(b, identity('client'));
  const ready = Promise.all([
    new Promise<void>((r) => server.once('hello', r)),
    new Promise<void>((r) => client.once('hello', r)),
  ]);
  server.start();
  client.start();
  await ready;
  return { server, client, a, b };
}
describe('plaintext room input channel', () => {
  it('exchanges readable JSON frames in both directions without pairing or encryption', async () => {
    const { server, client, a } = await pair();
    try {
      const event = { type: 'events', events: [{ kind: 'input-source' }] };
      const incoming = new Promise((r) => client.once('message', r));
      server.send(event);
      expect(await incoming).toEqual(event);
      expect(a.frames.at(-1)!.toString()).toContain('input-source');
      expect(a.frames[0].toString()).toContain('123456');
      const reverse = new Promise((r) => server.once('message', r));
      client.send({ type: 'leave' });
      expect(await reverse).toEqual({ type: 'leave' });
    } finally {
      server.close();
      client.close();
    }
  });
  it('rejects different rooms or the same input role before messages', async () => {
    for (const wrong of [identity('client', 'other'), identity('server')]) {
      const a = new Wire();
      const b = new Wire();
      a.peer = b;
      b.peer = a;
      const server = new InputChannel(a, identity('server'));
      const client = new InputChannel(b, wrong);
      const closed = new Promise<void>((r) => server.once('closed', r));
      server.start();
      client.start();
      await closed;
      expect(server.peer).toBeUndefined();
      client.close();
    }
  });
  it('rejects duplicate frames and malformed oversized input', async () => {
    const { server, client, a, b } = await pair();
    const incoming = new Promise((r) => client.once('message', r));
    server.send({ type: 'ready' });
    await incoming;
    const closed = new Promise<void>((r) => client.once('closed', r));
    b.push(a.frames.at(-1)!);
    await closed;
    server.close();
    const c = new Wire();
    const d = new Wire();
    c.peer = d;
    d.peer = c;
    const channel = new InputChannel(c, identity('server'));
    channel.start();
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(65537);
    const rejected = new Promise<void>((r) => channel.once('closed', r));
    c.push(bad);
    await rejected;
    expect(channel.peer).toBeUndefined();
    d.destroy();
  });
});
