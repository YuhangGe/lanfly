import type { FileMeta } from '@lanfly/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { HttpError, sendError } from '../core/http';

/** One download response rendezvous with one upload; no file buffering or filesystem access. */
export class DownloadRelay {
  readonly done: Promise<void>;
  started = false;
  #settled = false;
  #resolve!: () => void;
  #reject!: (error: Error) => void;
  #timer: NodeJS.Timeout;
  #upload?: IncomingMessage;
  constructor(
    readonly file: FileMeta,
    readonly response: ServerResponse,
    waitMs: number,
    readonly onFailure: (code: string) => void,
  ) {
    this.done = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    void this.done.catch(() => {});
    this.#timer = setTimeout(() => this.fail('FILE_SOURCE_UNAVAILABLE'), waitMs);
    this.#timer.unref();
    response.once('close', () => {
      if (!response.writableFinished) this.fail('TRANSFER_CANCELED');
    });
    response.once('error', () => this.fail('TRANSFER_UPLOAD_FAILED'));
  }
  fail(code: string): void {
    if (this.#settled) return;
    this.#settled = true;
    clearTimeout(this.#timer);
    this.#upload?.destroy();
    if (!this.response.destroyed && !this.response.writableEnded) {
      if (this.response.headersSent) this.response.destroy();
      else sendError(this.response, code === 'FILE_SOURCE_UNAVAILABLE' ? 504 : 502, code);
    }
    this.onFailure(code);
    this.#reject(new Error(code));
  }
  async upload(request: IncomingMessage, progress: (bytes: number) => void): Promise<void> {
    if (this.#settled || this.started) throw new HttpError(409, 'TRANSFER_STATE');
    const declared = request.headers['content-length'];
    if (declared !== undefined && Number(declared) !== this.file.size) {
      this.fail('FILE_SIZE_MISMATCH');
      throw new HttpError(400, 'FILE_SIZE_MISMATCH');
    }
    this.started = true;
    this.#upload = request;
    clearTimeout(this.#timer);
    request.setTimeout(60_000, () => this.fail('TRANSFER_UPLOAD_FAILED'));
    this.response.setTimeout(60_000, () => this.fail('TRANSFER_UPLOAD_FAILED'));
    this.response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': this.file.size,
      'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(this.file.name).replace(/'/g, '%27')}`,
      'cache-control': 'no-store',
    });
    let bytes = 0;
    const expected = this.file.size;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > expected) return callback(new Error('FILE_SIZE_MISMATCH'));
        progress(bytes);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(request, meter, this.response);
      if (bytes !== expected) throw new Error('FILE_SIZE_MISMATCH');
      if (!this.#settled) {
        this.#settled = true;
        this.#resolve();
      }
    } catch (error) {
      this.fail('TRANSFER_UPLOAD_FAILED');
      throw error;
    }
  }
}
