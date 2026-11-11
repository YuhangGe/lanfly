import type { Duplex } from 'node:stream';

import { EventEmitter } from 'node:events';
import { z } from 'zod';

const helloSchema = z.object({
  v: z.literal(2),
  roomId: z.string().min(1).max(64),
  id: z.string().uuid(),
  role: z.enum(['server', 'client']),
  name: z.string().min(1).max(64),
});
type Hello = z.infer<typeof helloSchema>;
const frameSchema = z.object({ seq: z.number().int().nonnegative().safe(), payload: z.unknown() });
const MAX_FRAME = 64 * 1024;
/** Plain JSON with bounded length framing. Room ID and opposite roles are checked before input is accepted. */
export class InputChannel extends EventEmitter {
  peer?: Hello;
  closed = false;
  #hello: Hello;
  #buffer: Buffer = Buffer.alloc(0);
  #started = false;
  #sent = 0;
  #received = 0;
  constructor(
    readonly socket: Duplex,
    input: Omit<Hello, 'v'>,
  ) {
    super();
    this.#hello = { v: 2, ...input };
  }
  start(head?: Buffer): void {
    if (this.#started) return;
    this.#started = true;
    this.socket.on('data', (data: Buffer) => this.#read(data));
    this.socket.on('error', () => this.close());
    this.socket.on('end', () => this.close());
    this.socket.on('close', () => this.close());
    this.#write(this.#hello);
    if (head?.length) this.#read(head);
  }
  send(payload: unknown): void {
    if (this.peer && !this.closed) this.#write({ seq: this.#sent++, payload });
  }
  #write(value: unknown): void {
    const body = Buffer.from(JSON.stringify(value));
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
    let offset = 0;
    try {
      while (offset < data.length && !this.closed) {
        const take = Math.min(MAX_FRAME + 4 - this.#buffer.length, data.length - offset);
        if (take <= 0) throw new Error('FRAME_TOO_LARGE');
        this.#buffer = Buffer.concat([this.#buffer, data.subarray(offset, offset + take)]);
        offset += take;
        while (this.#buffer.length >= 4 && !this.closed) {
          const length = this.#buffer.readUInt32BE();
          if (length < 1 || length > MAX_FRAME) throw new Error('INVALID_FRAME');
          if (this.#buffer.length < length + 4) break;
          const value: unknown = JSON.parse(this.#buffer.subarray(4, length + 4).toString('utf8'));
          this.#buffer = this.#buffer.subarray(length + 4);
          if (!this.peer) {
            const hello = helloSchema.parse(value);
            if (
              hello.roomId !== this.#hello.roomId ||
              hello.role === this.#hello.role ||
              hello.id === this.#hello.id
            )
              throw new Error('ROOM_OR_ROLE_MISMATCH');
            this.peer = hello;
            this.emit('hello', hello);
          } else {
            const frame = frameSchema.parse(value);
            if (frame.seq !== this.#received++) throw new Error('INVALID_SEQUENCE');
            this.emit('message', frame.payload);
          }
        }
      }
    } catch {
      this.close();
    }
  }
  close(graceful = false): void {
    if (this.closed) return;
    this.closed = true;
    if (graceful) this.socket.end();
    else this.socket.destroy();
    this.emit('closed');
  }
}
