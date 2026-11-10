import type { Duplex } from 'node:stream';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';

const helloSchema = z.object({
  v: z.literal(1),
  role: z.enum(['server', 'client']),
  key: z.string().min(1).max(128),
  ephemeral: z.string().min(1).max(128),
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(64),
});
type Hello = z.infer<typeof helloSchema>;
const MAX_FRAME = 64 * 1024;
const commitSchema = z.object({ v: z.literal(1), commit: z.string().regex(/^[a-f0-9]{64}$/) });

function nonce(sequence: number): Buffer {
  const value = Buffer.alloc(12);
  value.writeBigUInt64BE(BigInt(sequence), 4);
  return value;
}

/** Length-framed AES-GCM stream. Directional keys and implicit counters reject replay/reordering.
 * Static + ephemeral X25519 authenticates pinned peers and supplies forward secrecy.
 * First pairing authenticates the transcript by comparing an 8-digit code in both local UIs.
 * Both sides commit to their hello before revealing it, preventing adaptive code selection.
 */
export class InputChannel extends EventEmitter {
  peer: Hello | undefined;
  code = '';
  #hello: Hello;
  #helloWire: Buffer;
  #peerCommit: string | undefined;
  #ephemeral: KeyObject;
  #privateKey: KeyObject;
  #buffer: Buffer = Buffer.alloc(0);
  #sendKey: Buffer | undefined;
  #receiveKey: Buffer | undefined;
  #sent = 0;
  #received = 0;
  #started = false;
  closed = false;

  constructor(
    readonly socket: Duplex,
    input: { role: 'server' | 'client'; name: string; key: KeyObject; publicKey: string },
  ) {
    super();
    const pair = generateKeyPairSync('x25519');
    this.#ephemeral = pair.privateKey;
    this.#privateKey = input.key;
    this.#hello = {
      v: 1,
      role: input.role,
      name: input.name,
      key: input.publicKey,
      ephemeral: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      nonce: randomBytes(32).toString('hex'),
    };
    this.#helloWire = Buffer.from(JSON.stringify(this.#hello));
  }

  start(head?: Buffer): void {
    if (this.#started) return;
    this.#started = true;
    this.socket.on('data', (data: Buffer) => this.#read(data));
    this.socket.on('error', () => this.close());
    this.socket.on('end', () => this.close());
    this.socket.on('close', () => this.close());
    this.#write(
      Buffer.from(
        JSON.stringify({
          v: 1,
          commit: createHash('sha256').update(this.#helloWire).digest('hex'),
        }),
      ),
    );
    if (head?.length) this.#read(head);
  }

  send(value: unknown): void {
    if (!this.#sendKey || this.closed) return;
    try {
      const cipher = createCipheriv('aes-256-gcm', this.#sendKey, nonce(this.#sent++));
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(value)),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      this.#write(encrypted);
    } catch {
      this.close();
    }
  }

  #write(body: Buffer): void {
    if (this.closed) return;
    if (body.length > MAX_FRAME || this.socket.writableLength > 256 * 1024) {
      this.close();
      return;
    }
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([prefix, body]));
  }

  #read(data: Buffer): void {
    if (this.closed) return;
    // Process incrementally, including coalesced TCP reads, with a strict frame bound.
    let offset = 0;
    try {
      while (offset < data.length && !this.closed) {
        const take = Math.min(MAX_FRAME + 4 - this.#buffer.length, data.length - offset);
        if (take <= 0) throw new Error('frame too large');
        this.#buffer = Buffer.concat([this.#buffer, data.subarray(offset, offset + take)]);
        offset += take;
        while (this.#buffer.length >= 4 && !this.closed) {
          const length = this.#buffer.readUInt32BE();
          if (length < 1 || length > MAX_FRAME) throw new Error('bad frame');
          if (this.#buffer.length < length + 4) break;
          const body = this.#buffer.subarray(4, length + 4);
          this.#buffer = this.#buffer.subarray(length + 4);
          if (!this.#peerCommit) {
            if (body.length > 256) throw new Error('bad commitment');
            this.#peerCommit = commitSchema.parse(JSON.parse(body.toString('utf8'))).commit;
            this.#write(this.#helloWire);
          } else if (!this.peer) this.#handshake(body);
          else {
            if (body.length < 17) throw new Error('bad ciphertext');
            const decipher = createDecipheriv(
              'aes-256-gcm',
              this.#receiveKey!,
              nonce(this.#received++),
            );
            decipher.setAuthTag(body.subarray(-16));
            const plaintext = Buffer.concat([
              decipher.update(body.subarray(0, -16)),
              decipher.final(),
            ]);
            this.emit('message', JSON.parse(plaintext.toString('utf8')));
          }
        }
      }
    } catch {
      this.close();
    }
  }

  #handshake(body: Buffer): void {
    if (body.length > 2048) throw new Error('bad hello');
    if (createHash('sha256').update(body).digest('hex') !== this.#peerCommit)
      throw new Error('hello commitment mismatch');
    const remote = helloSchema.parse(JSON.parse(body.toString('utf8')));
    if (remote.role === this.#hello.role || remote.key === this.#hello.key)
      throw new Error('bad role');
    const key = (value: string) => {
      const result = createPublicKey({
        key: Buffer.from(value, 'base64'),
        format: 'der',
        type: 'spki',
      });
      if (
        result.asymmetricKeyType !== 'x25519' ||
        result.export({ type: 'spki', format: 'der' }).toString('base64') !== value
      )
        throw new Error('bad key');
      return result;
    };
    const server = this.#hello.role === 'server' ? this.#hello : remote;
    const client = this.#hello.role === 'client' ? this.#hello : remote;
    // Canonical field order must not depend on JSON property insertion order.
    const canonical = (h: Hello) => [h.v, h.role, h.key, h.ephemeral, h.nonce, h.name];
    const transcript = createHash('sha256')
      .update(JSON.stringify([canonical(server), canonical(client)]))
      .digest();
    const secret = Buffer.concat([
      diffieHellman({ privateKey: this.#privateKey, publicKey: key(remote.key) }),
      diffieHellman({ privateKey: this.#ephemeral, publicKey: key(remote.ephemeral) }),
    ]);
    const derive = (label: string, size: number) =>
      Buffer.from(hkdfSync('sha256', secret, transcript, `lanfly-input-v1:${label}`, size));
    this.#sendKey = derive(this.#hello.role, 32);
    this.#receiveKey = derive(remote.role, 32);
    this.code = String(derive('verify', 4).readUInt32BE() % 100_000_000).padStart(8, '0');
    this.peer = remote;
    this.emit('hello', remote);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#sendKey?.fill(0);
    this.#receiveKey?.fill(0);
    this.socket.destroy();
    this.emit('closed');
  }
}
