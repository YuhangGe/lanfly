import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  fileMetaSchema,
  peerInfoSchema,
  sendMessageInput,
  type AppState,
  type FileMeta,
  type PeerInfo,
  type PeerView,
  type SendFileResult,
} from '@lanfly/common';
import { createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

import type { Application } from '../app';

import { throwActionError } from '../core/errors';
import { HttpError, sendJson } from '../core/http';
import { randomToken, safeTokenEquals, sha256 } from '../core/security';
import { logger } from '../logger';
import { finalizeFile, sanitizeFileName, temporaryPath } from './downloads';
import { EventHub } from './events';
import { MessageStore } from './messages';
import { TransferStore, type TransferRecord } from './transfers';

const ONLINE_GRACE = 15_000;
export const BROWSER_FILE_TTL = 30 * 60_000;
const browserSchema = peerInfoSchema.extend({
  kind: z.literal('browser'),
  gatewayId: z.string().max(64),
  online: z.boolean(),
});
const rosterSchema = z.object({ from: peerInfoSchema, browsers: z.array(browserSchema).max(256) });
const deliverySchema = z.object({
  from: peerInfoSchema,
  browsers: z.array(browserSchema).max(256),
  sender: peerInfoSchema.extend({
    kind: z.literal('browser').optional(),
    gatewayId: z.string().max(64).optional(),
  }),
  to: z.string().min(1).max(64),
  id: z.string().uuid(),
  text: sendMessageInput.shape.text.optional(),
  file: fileMetaSchema.optional(),
});
type Delivery = z.infer<typeof deliverySchema>;
type BrowserAnnouncement = z.infer<typeof browserSchema>;
type Inbox = { events: EventHub; messages: MessageStore; transfers: TransferStore };
type Browser = Inbox & { info: PeerInfo; lastSeen: number; connections: number };
type IncomingFile = {
  destination: string;
  sender: string;
  gateway: string;
  token: string;
  receiving: boolean;
  expiresAt?: number;
  path?: string;
};
type OutgoingFile = { owner: string; gateway: string; token: string };

/** Browser leaves only travel across a direct native peer connection; remote rosters are never re-advertised. */
export class BrowserNetwork {
  readonly browsers = new Map<string, Browser>();
  readonly remoteBrowsers = new Map<string, { at: number; peers: BrowserAnnouncement[] }>();
  readonly incoming = new Map<string, IncomingFile>();
  readonly outgoing = new Map<string, OutgoingFile>();
  cacheDir = '';
  #key = '';
  #abort = new AbortController();
  #timer?: NodeJS.Timeout;
  #syncing = false;
  #stopped = false;
  #pending = new Set<Promise<unknown>>();
  #lastPeers = '';

  constructor(readonly app: Application) {}

  async start(): Promise<void> {
    const storage = this.app.input.store.storage;
    if (!storage.loaded) await storage.load();
    const saved = z
      .object({ key: z.string().min(32) })
      .optional()
      .parse(storage.get('browser'));
    this.#key = saved?.key ?? randomToken();
    if (!saved) await storage.set('browser', { key: this.#key });
    const cacheId = sha256(storage.file).toString('hex').slice(0, 24);
    const root = path.join(os.tmpdir(), 'lanfly-browser', cacheId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    this.cacheDir = path.join(root, String(this.app.identity.port));
    // Keep caches belonging to other live instances, clear abandoned caches even if the port changed.
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, entry.name);
      let alive = false;
      try {
        const owner = z
          .object({ pid: z.number().int().positive() })
          .parse(JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')));
        try {
          process.kill(owner.pid, 0);
          alive = true;
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code === 'EPERM';
        }
      } catch {
        /* Missing owner metadata is an abandoned cache. */
      }
      if (!alive || directory === this.cacheDir)
        await rm(directory, { recursive: true, force: true });
    }
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.cacheDir, 'owner.json'), JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
    this.#timer = setInterval(() => {
      this.publishPeers();
      this.#track(this.sync());
      this.#track(this.expireFiles());
    }, 2_000);
    this.#timer.unref();
  }

  #track(task: Promise<unknown>): void {
    this.#pending.add(task);
    void task
      .catch((error) => logger.debug(`浏览器设备：${String(error)}`))
      .finally(() => this.#pending.delete(task));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort();
    clearInterval(this.#timer);
    for (const browser of this.browsers.values()) {
      for (const transfer of browser.transfers.active()) transfer.cancel?.();
      browser.events.stop();
    }
    await Promise.allSettled(this.#pending);
    if (this.cacheDir) await rm(this.cacheDir, { recursive: true, force: true });
  }

  get cookieName(): string {
    return `lanfly_browser_${this.app.identity.port}`;
  }

  #signature(token: string): string {
    return createHmac('sha256', this.#key)
      .update(`${token}:${this.app.identity.room?.tag.toString('hex') ?? 'public'}`)
      .digest('base64url');
  }

  join(
    token: string,
    name: string,
    password?: string,
    cookie?: string,
  ): { id: string; cookie: string } {
    const existing = cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${this.cookieName}=`))
      ?.slice(this.cookieName.length + 1);
    const remembered =
      !!existing && safeTokenEquals(existing, `${token}.${this.#signature(token)}`);
    if (
      this.app.config.secret &&
      !remembered &&
      password?.normalize('NFKC') !== this.app.config.secret.normalize('NFKC')
    )
      throw new HttpError(401, 'ROOM_PASSWORD_REQUIRED');
    const id = `web-${sha256(token).toString('hex').slice(0, 40)}`;
    let browser = this.browsers.get(id);
    if (!browser) {
      if (this.browsers.size >= 256) throw new HttpError(503, 'BROWSER_LIMIT');
      const events = new EventHub();
      browser = {
        events,
        messages: new MessageStore(events),
        transfers: new TransferStore(events),
        info: this.#info(id, name),
        lastSeen: Date.now(),
        connections: 0,
      };
      this.browsers.set(id, browser);
    }
    browser.info.name = name;
    browser.lastSeen = Date.now();
    this.publishPeers();
    this.#track(this.sync());
    return {
      id,
      cookie: `${this.cookieName}=${token}.${this.#signature(token)}; HttpOnly; SameSite=Strict; Path=/api/v1/browser/; Max-Age=31536000`,
    };
  }

  authenticate(request: IncomingMessage): string {
    const cookie = request.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${this.cookieName}=`))
      ?.slice(this.cookieName.length + 1);
    const [token, signature] = cookie?.split('.') ?? [];
    if (!token || !signature || !safeTokenEquals(signature, this.#signature(token)))
      throw new HttpError(401, 'BROWSER_SESSION_REQUIRED');
    const id = `web-${sha256(token).toString('hex').slice(0, 40)}`;
    const browser = this.browsers.get(id);
    if (!browser) throw new HttpError(401, 'BROWSER_SESSION_REQUIRED');
    browser.lastSeen = Date.now();
    return id;
  }

  attach(id: string, response: ServerResponse): void {
    const browser = this.browsers.get(id)!;
    browser.connections++;
    browser.events.add(response);
    this.publishPeers();
    response.once('close', () => {
      browser.connections = Math.max(0, browser.connections - 1);
      browser.lastSeen = Date.now() - ONLINE_GRACE;
      this.publishPeers();
    });
  }

  rename(id: string, name: string): void {
    this.browsers.get(id)!.info.name = name;
    this.publishPeers();
    this.#track(this.sync());
  }

  #info(id: string, name: string): PeerInfo {
    return {
      ...this.app.identity.info,
      id,
      name,
      kind: 'browser',
      gatewayId: this.app.identity.id,
    };
  }

  #online(browser: Browser): boolean {
    return browser.connections > 0 || Date.now() - browser.lastSeen < ONLINE_GRACE;
  }

  localRoster(): BrowserAnnouncement[] {
    return [...this.browsers.values()].map((b) => ({
      ...b.info,
      kind: 'browser',
      gatewayId: this.app.identity.id,
      online: this.#online(b),
    }));
  }

  peers(): PeerView[] {
    const native = this.app.peers.list();
    const local = [...this.browsers.values()].map((b) => ({
      ...b.info,
      host: this.app.identity.host,
      online: this.#online(b),
      lastSeen: b.lastSeen,
      manual: false,
    }));
    const remote = [...this.remoteBrowsers.entries()].flatMap(([gateway, roster]) => {
      const parent = this.app.peers.get(gateway);
      if (!parent) return [];
      return roster.peers.map((info) => ({
        ...info,
        host: parent.host,
        port: parent.port,
        lastSeen: roster.at,
        online: parent.online && info.online && Date.now() - roster.at < ONLINE_GRACE,
        manual: false,
      }));
    });
    return [...native, ...local, ...remote].sort(
      (a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'zh-CN'),
    );
  }

  browserPeers(id: string): PeerView[] {
    return [
      {
        ...this.app.identity.info,
        host: this.app.identity.host,
        online: true,
        lastSeen: Date.now(),
        manual: false,
      },
      ...this.peers(),
    ].filter((p) => p.id !== id);
  }

  publishPeers(): void {
    if (this.#stopped) return;
    const peers = this.peers();
    const stable = JSON.stringify(peers.map(({ lastSeen: _lastSeen, ...p }) => p));
    if (stable === this.#lastPeers) return;
    this.#lastPeers = stable;
    this.app.events.broadcast('peers', peers);
  }

  publishBrowserPeers(): void {
    for (const [id, b] of this.browsers) b.events.broadcast('peers', this.browserPeers(id));
  }

  state(id: string): AppState {
    const b = this.browsers.get(id)!;
    return {
      self: { ...b.info, host: this.app.identity.host, url: '', downloadsDir: '' },
      peers: this.browserPeers(id),
      messages: b.messages.list(),
      transfers: b.transfers.list(),
    };
  }

  #inbox(id: string): Inbox {
    if (id === this.app.identity.id) return this.app;
    const b = this.browsers.get(id);
    if (!b) throw new HttpError(404, 'DEVICE_NOT_FOUND');
    return b;
  }

  #self(id: string): PeerInfo {
    return id === this.app.identity.id ? this.app.identity.info : this.browsers.get(id)!.info;
  }

  #gateway(id: string): string {
    if (id === this.app.identity.id || this.browsers.has(id)) return this.app.identity.id;
    const peer = this.peers().find((p) => p.id === id && p.online);
    if (!peer) throw new HttpError(404, 'PEER_UNREACHABLE');
    return peer.gatewayId ?? peer.id;
  }

  async sync(): Promise<void> {
    if (this.#syncing || this.#stopped) return;
    this.#syncing = true;
    try {
      await Promise.allSettled(
        this.app.peers
          .list()
          .filter((p) => p.online)
          .map(async (peer) => {
            const value = await this.app.remote.browserRequest(
              peer,
              'roster',
              {
                from: this.app.identity.info,
                browsers: this.localRoster(),
              },
              this.#abort.signal,
            );
            if (!this.#stopped) this.acceptRoster(value, peer.id);
          }),
      );
      this.publishPeers();
    } finally {
      this.#syncing = false;
    }
  }

  acceptRoster(value: unknown, senderId: string): void {
    const payload = rosterSchema.parse(value);
    if (payload.from.id !== senderId || !this.app.peers.get(senderId))
      throw new HttpError(403, 'DIRECT_PEER_REQUIRED');
    const seen = new Set<string>();
    for (const b of payload.browsers) {
      if (
        !b.id.startsWith('web-') ||
        b.gatewayId !== senderId ||
        seen.has(b.id) ||
        b.secret !== this.app.identity.secret ||
        this.browsers.has(b.id) ||
        this.app.peers.get(b.id)
      )
        throw new HttpError(400, 'INVALID_BROWSER_ROSTER');
      seen.add(b.id);
    }
    this.remoteBrowsers.set(senderId, { at: Date.now(), peers: payload.browsers });
    this.publishPeers();
  }

  async sendText(owner: string, peerId: string, text: string) {
    const inbox = this.#inbox(owner);
    const message = inbox.messages.addOutgoingText(peerId, text);
    return this.#deliverText(owner, peerId, message.id, text, message.createdAt);
  }

  async retry(owner: string, messageId: string) {
    const message = this.#inbox(owner).messages.get(messageId);
    if (
      !message ||
      message.direction !== 'out' ||
      message.kind !== 'text' ||
      message.status !== 'failed'
    )
      throw new HttpError(400, 'MESSAGE_NOT_RETRYABLE');
    this.#inbox(owner).messages.setStatus(messageId, 'sending');
    return this.#deliverText(owner, message.peerId, message.id, message.text!, message.createdAt);
  }

  async #deliverText(owner: string, to: string, id: string, text: string, sentAt: number) {
    const inbox = this.#inbox(owner);
    try {
      await this.#deliver({
        from: this.app.identity.info,
        sender: this.#self(owner),
        to,
        id,
        text,
        sentAt,
      });
      return inbox.messages.setStatus(id, 'sent')!;
    } catch (error) {
      inbox.messages.setStatus(id, 'failed', 'PEER_UNREACHABLE');
      logger.debug(`发送浏览器消息失败：${String(error)}`);
      throwActionError('PEER_UNREACHABLE');
    }
  }

  async #deliver(payload: Omit<Delivery, 'browsers'> & { sentAt?: number }): Promise<unknown> {
    const gateway = this.#gateway(payload.to);
    const delivery = { ...payload, browsers: this.localRoster() };
    if (gateway === this.app.identity.id) return this.receive(delivery, this.app.identity.id);
    return this.app.remote.browserRequest(
      this.app.peerTarget(gateway),
      'deliver',
      delivery,
      this.#abort.signal,
    );
  }

  receive(value: unknown, gateway: string): { ok: true } | { token: string } {
    const payload = deliverySchema.parse(value);
    if (payload.from.id !== gateway) throw new HttpError(403, 'INVALID_SENDER');
    if (gateway !== this.app.identity.id) {
      if (!this.app.peers.get(gateway)) throw new HttpError(403, 'DIRECT_PEER_REQUIRED');
      this.acceptRoster({ from: payload.from, browsers: payload.browsers }, gateway);
      if (
        payload.sender.id !== gateway &&
        !this.remoteBrowsers.get(gateway)?.peers.some((p) => p.id === payload.sender.id)
      )
        throw new HttpError(403, 'INVALID_SENDER');
    }
    if (payload.sender.id === payload.to) throw new HttpError(400, 'SELF_CONNECT');
    const recipient = this.#inbox(payload.to);
    if (payload.to !== this.app.identity.id && !this.#online(this.browsers.get(payload.to)!))
      throw new HttpError(409, 'PEER_UNREACHABLE');
    if (payload.text) {
      recipient.messages.addIncomingText(payload.sender.id, {
        id: payload.id,
        text: payload.text,
        sentAt: Date.now(),
        from: payload.sender,
      });
      return { ok: true };
    }
    if (!payload.file || this.incoming.has(payload.id) || recipient.transfers.get(payload.id))
      throw new HttpError(409, 'TRANSFER_STATE');
    const file = { ...payload.file, name: sanitizeFileName(payload.file.name) };
    const token = randomToken();
    recipient.transfers.createIncoming(payload.sender.id, payload.id, file, token);
    recipient.messages.addIncomingFile(payload.sender.id, file, payload.id);
    this.incoming.set(payload.id, {
      destination: payload.to,
      sender: payload.sender.id,
      gateway,
      token,
      receiving: false,
    });
    return { token };
  }

  async sendFile(owner: string, peerId: string, file: FileMeta): Promise<SendFileResult> {
    const inbox = this.#inbox(owner);
    const transfer = inbox.transfers.createOutgoing(peerId, file);
    inbox.messages.addOutgoingFile(peerId, file, transfer.id);
    try {
      const gateway = this.#gateway(peerId);
      const result = z.object({ token: z.string() }).parse(
        await this.#deliver({
          from: this.app.identity.info,
          sender: this.#self(owner),
          to: peerId,
          id: transfer.id,
          file,
        }),
      );
      this.outgoing.set(transfer.id, { owner, gateway, token: result.token });
      inbox.transfers.update(transfer.id, { status: 'ready' });
      return {
        transferId: transfer.id,
        uploadUrl: `${owner === this.app.identity.id ? '/api/v1/local/upload/' : '/api/v1/browser/upload/'}${transfer.id}`,
      };
    } catch (error) {
      inbox.transfers.fail(transfer.id, 'PEER_UNREACHABLE');
      inbox.messages.setFileStatusByTransfer(transfer.id, 'failed', 'PEER_UNREACHABLE');
      logger.debug(`发送浏览器文件失败：${String(error)}`);
      throwActionError('PEER_UNREACHABLE');
    }
  }

  async upload(
    owner: string,
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const route = this.outgoing.get(id);
    const inbox = this.#inbox(owner);
    const transfer = inbox.transfers.get(id);
    if (!route || route.owner !== owner || !transfer || transfer.status !== 'ready')
      throw new HttpError(409, 'TRANSFER_STATE');
    inbox.transfers.update(id, { status: 'sending' });
    try {
      const declared = request.headers['content-length'];
      if (declared !== undefined && Number(declared) !== transfer.file.size)
        throw new HttpError(400, 'FILE_SIZE_MISMATCH');
      if (route.gateway === this.app.identity.id) {
        await this.receiveUpload(
          id,
          route.token,
          request,
          response,
          (bytes) => inbox.transfers.progress(id, bytes),
          transfer,
        );
      } else {
        const { request: remote, done } = this.app.remote.openUpload(
          this.app.peerTarget(route.gateway),
          id,
          route.token,
          transfer.file.size,
          `/api/v1/peer/browser-upload/${id}`,
        );
        // Observe rejection immediately, including while the streaming pipeline is active.
        void done.catch(() => {});
        inbox.transfers.setCancel(id, () => {
          remote.destroy();
          request.destroy();
        });
        let bytes = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > transfer.file.size) return callback(new Error('FILE_SIZE_MISMATCH'));
            inbox.transfers.progress(id, bytes);
            callback(null, chunk);
          },
        });
        await pipeline(request, meter, remote);
        if (bytes !== transfer.file.size) {
          remote.destroy();
          throw new Error('FILE_SIZE_MISMATCH');
        }
        const result = await done;
        if (result.status !== 200 || bytes !== transfer.file.size)
          throw new Error('TRANSFER_UPLOAD_FAILED');
        const receipt = z
          .object({ expiresAt: z.number().optional() })
          .parse(JSON.parse(result.body));
        if (receipt.expiresAt) inbox.transfers.update(id, { expiresAt: receipt.expiresAt });
        sendJson(response, 200, { ok: true });
      }
      inbox.transfers.complete(id);
      inbox.messages.setFileStatusByTransfer(id, 'sent');
    } catch (error) {
      inbox.transfers.fail(id, 'TRANSFER_UPLOAD_FAILED');
      inbox.messages.setFileStatusByTransfer(id, 'failed', 'TRANSFER_UPLOAD_FAILED');
      throw error;
    } finally {
      inbox.transfers.clearCancel(id);
      if (inbox.transfers.get(id)?.status !== 'completed') this.outgoing.delete(id);
    }
  }

  async receiveUpload(
    id: string,
    token: string,
    request: IncomingMessage,
    response: ServerResponse,
    progress?: (bytes: number) => void,
    source?: TransferRecord,
  ): Promise<void> {
    const incoming = this.incoming.get(id);
    if (!incoming || !safeTokenEquals(token, incoming.token))
      throw new HttpError(403, 'TRANSFER_TOKEN_INVALID');
    const inbox = this.#inbox(incoming.destination);
    const transfer = inbox.transfers.get(id)!;
    if (incoming.receiving || transfer.status !== 'receiving')
      throw new HttpError(409, 'TRANSFER_STATE');
    const declared = request.headers['content-length'];
    if (declared !== undefined && Number(declared) !== transfer.file.size)
      throw new HttpError(400, 'FILE_SIZE_MISMATCH');
    incoming.receiving = true;
    const browser = incoming.destination !== this.app.identity.id;
    const directory = browser ? this.cacheDir : this.app.identity.downloadsDir;
    const temporary = temporaryPath(directory, id);
    const stream = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    const cancel = () => {
      request.destroy();
      stream.destroy();
    };
    inbox.transfers.setCancel(id, cancel);
    if (source) this.#inbox(this.outgoing.get(id)!.owner).transfers.setCancel(id, cancel);
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > transfer.file.size) return callback(new Error('FILE_SIZE_MISMATCH'));
        inbox.transfers.progress(id, bytes);
        progress?.(bytes);
        callback(null, chunk);
      },
    });
    const job = (async () => {
      try {
        await pipeline(request, meter, stream);
        if (bytes !== transfer.file.size) throw new Error('FILE_SIZE_MISMATCH');
        incoming.path = browser
          ? path.join(directory, id)
          : await finalizeFile(temporary, directory, transfer.file.name);
        if (browser) {
          await rename(temporary, incoming.path);
          incoming.expiresAt = Date.now() + BROWSER_FILE_TTL;
          inbox.transfers.update(id, {
            downloadUrl: `/api/v1/browser/download/${id}`,
            expiresAt: incoming.expiresAt,
          });
          if (source)
            this.#inbox(this.outgoing.get(id)!.owner).transfers.update(id, {
              expiresAt: incoming.expiresAt,
            });
        }
        inbox.transfers.complete(id, browser ? undefined : path.basename(incoming.path));
        sendJson(response, 200, { ok: true, expiresAt: incoming.expiresAt });
      } catch (error) {
        inbox.transfers.fail(id, 'TRANSFER_UPLOAD_FAILED');
        await rm(temporary, { force: true });
        throw error;
      } finally {
        inbox.transfers.clearCancel(id);
      }
    })();
    this.#pending.add(job);
    try {
      await job;
    } finally {
      this.#pending.delete(job);
    }
  }

  async download(owner: string, id: string, response: ServerResponse): Promise<void> {
    const incoming = this.incoming.get(id);
    if (!incoming || incoming.destination !== owner || !incoming.path || !incoming.expiresAt)
      throw new HttpError(404, 'FILE_NOT_FOUND');
    if (incoming.expiresAt <= Date.now()) {
      await this.expireFiles();
      throw new HttpError(410, 'FILE_EXPIRED');
    }
    const inbox = this.#inbox(owner);
    const transfer = inbox.transfers.get(id)!;
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': transfer.file.size,
      'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(transfer.file.name).replace(/'/g, '%27')}`,
      'cache-control': 'no-store',
    });
    await pipeline(createReadStream(incoming.path), response);
    const downloadedAt = Date.now();
    inbox.transfers.update(id, { downloadedAt });
    this.#track(this.#notifyReceipt(id, incoming, { downloadedAt }));
  }

  async expireFiles(now = Date.now()): Promise<void> {
    for (const [id, incoming] of this.incoming) {
      if (!incoming.expiresAt || incoming.expiresAt > now || !incoming.path) continue;
      const expiredPath = incoming.path;
      delete incoming.path;
      await rm(expiredPath, { force: true });
      this.#inbox(incoming.destination).transfers.update(id, {
        downloadUrl: undefined,
        expired: true,
      });
      await this.#notifyReceipt(id, incoming, { expired: true }).catch(() => {});
    }
  }

  async #notifyReceipt(
    id: string,
    incoming: IncomingFile,
    patch: { downloadedAt?: number; expired?: boolean },
  ): Promise<void> {
    const receipt = { id, ...patch };
    if (incoming.gateway === this.app.identity.id) this.receiveReceipt(receipt, incoming.gateway);
    else
      await this.app.remote.browserRequest(
        this.app.peerTarget(incoming.gateway),
        'receipt',
        receipt,
      );
  }

  receiveReceipt(value: unknown, gateway: string): void {
    const receipt = z
      .object({
        id: z.string().uuid(),
        downloadedAt: z.number().int().positive().optional(),
        expired: z.literal(true).optional(),
      })
      .parse(value);
    const route = this.outgoing.get(receipt.id);
    if (!route || route.gateway !== gateway) throw new HttpError(403, 'INVALID_RECEIPT');
    this.#inbox(route.owner).transfers.update(receipt.id, {
      ...(receipt.downloadedAt ? { downloadedAt: receipt.downloadedAt } : {}),
      ...(receipt.expired ? { expired: true } : {}),
    });
  }

  cancel(owner: string, id: string): void {
    const inbox = this.#inbox(owner);
    if (!inbox.transfers.get(id)) throw new HttpError(404, 'TRANSFER_NOT_FOUND');
    inbox.transfers.get(id)?.cancel?.();
    inbox.transfers.cancel(id);
    inbox.messages.setFileStatusByTransfer(id, 'failed', 'TRANSFER_CANCELED');
  }
}
