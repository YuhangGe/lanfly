import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
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
      this.peer.push(copy.subarray(0, 2));
      this.peer.push(copy.subarray(2));
    });
    done();
  }
}

function identity(role: 'server' | 'client') {
  const pair = generateKeyPairSync('x25519');
  return {
    role,
    name: role,
    key: pair.privateKey,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

async function pair() {
  const a = new Wire();
  const b = new Wire();
  a.peer = b;
  b.peer = a;
  const server = new InputChannel(a, identity('server'));
  const client = new InputChannel(b, identity('client'));
  const ready = Promise.all([
    new Promise<void>((resolve) => server.once('hello', resolve)),
    new Promise<void>((resolve) => client.once('hello', resolve)),
  ]);
  server.start();
  client.start();
  await ready;
  return { server, client, a, b };
}

describe('encrypted input channel', () => {
  it('derives the same verification code and exchanges encrypted frames in both directions', async () => {
    const { server, client, a } = await pair();
    try {
      expect(server.code).toMatch(/^\d{8}$/);
      expect(client.code).toBe(server.code);
      const event = { type: 'events', events: [{ kind: 'event', t: 10, key: 42 }] };
      const incoming = new Promise((resolve) => client.once('message', resolve));
      server.send(event);
      expect(await incoming).toEqual(event);
      expect(a.frames.at(-1)!.includes(Buffer.from('events'))).toBe(false);
      const reverse = new Promise((resolve) => server.once('message', resolve));
      client.send({ type: 'leave' });
      expect(await reverse).toEqual({ type: 'leave' });
    } finally {
      server.close();
      client.close();
    }
  });

  it('closes on tampered ciphertext without delivering an input event', async () => {
    const { server, client, a } = await pair();
    let delivered = false;
    client.on('message', () => {
      delivered = true;
    });
    a.intercept = (data) => {
      data[data.length - 1] ^= 1;
      return data;
    };
    const closed = new Promise<void>((resolve) => client.once('closed', resolve));
    server.send({ type: 'confirm' });
    await closed;
    expect(delivered).toBe(false);
    server.close();
  });

  it('rejects replayed authenticated frames', async () => {
    const { server, client, a, b } = await pair();
    const received = new Promise((resolve) => client.once('message', resolve));
    server.send({ type: 'confirm' });
    await received;
    const closed = new Promise<void>((resolve) => client.once('closed', resolve));
    b.push(a.frames.at(-1)!);
    await closed;
    server.close();
  });

  it('rejects oversized frames before parsing a hello', async () => {
    const a = new Wire();
    const b = new Wire();
    a.peer = b;
    b.peer = a;
    const channel = new InputChannel(a, identity('server'));
    channel.start();
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(65537);
    const closed = new Promise<void>((resolve) => channel.once('closed', resolve));
    a.push(bad);
    await closed;
    expect(channel.peer).toBeUndefined();
    b.destroy();
  });

  it('rejects changing a hello after committing to its verification transcript', async () => {
    const a = new Wire();
    const b = new Wire();
    a.peer = b;
    b.peer = a;
    a.intercept = (data) => {
      const body = JSON.parse(data.subarray(4).toString()) as { nonce?: string };
      if (!body.nonce) return data;
      body.nonce = (body.nonce[0] === '0' ? '1' : '0') + body.nonce.slice(1);
      const wire = Buffer.from(JSON.stringify(body));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(wire.length);
      return Buffer.concat([prefix, wire]);
    };
    const server = new InputChannel(a, identity('server'));
    const client = new InputChannel(b, identity('client'));
    const closed = new Promise<void>((resolve) => client.once('closed', resolve));
    server.start();
    client.start();
    await closed;
    expect(client.peer).toBeUndefined();
    server.close();
  });
});
