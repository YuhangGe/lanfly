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
import { createHmac, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

import type { Application } from '../app';

import { throwActionError } from '../core/errors';
import { clientAddress, HttpError, sendJson } from '../core/http';
import { randomToken, safeTokenEquals, sha256 } from '../core/security';
import { logger } from '../logger';
import { DownloadRelay } from './download-relay';
import { finalizeFile, sanitizeFileName, temporaryPath } from './downloads';
import { EventHub } from './events';
import { MessageStore } from './messages';
import { TransferStore } from './transfers';

const ONLINE_GRACE = 15_000;
export const BROWSER_OFFER_TTL = 30 * 60_000;
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
type Browser = Inbox & { info: PeerInfo; host: string; lastSeen: number; connections: number };
type IncomingFile = {
  destination: string;
  sender: string;
  gateway: string;
  token: string;
  receiving: boolean;
  expiresAt?: number;
  active?: { id: string; relay: DownloadRelay };
  canceled?: boolean;
};
type OutgoingFile = {
  owner: string;
  gateway: string;
  token: string;
  deferred: boolean;
  expiresAt?: number;
  sessionId?: string;
  canceled?: boolean;
  completion?: Promise<void>;
};

/** Browser leaves only travel across a direct native peer connection; remote rosters are never re-advertised. */
export class BrowserNetwork {
  onFastClient?: () => void;
  readonly browsers = new Map<string, Browser>();
  readonly remoteBrowsers = new Map<string, { at: number; peers: BrowserAnnouncement[] }>();
  readonly incoming = new Map<string, IncomingFile>();
  readonly outgoing = new Map<string, OutgoingFile>();
  downloadWaitTimeoutMs = 30_000;
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
    this.#timer = setInterval(() => {
      this.publishPeers();
      this.#track(this.sync());
      this.#track(this.expireOffers());
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
    for (const incoming of this.incoming.values()) incoming.active?.relay.fail('TRANSFER_CANCELED');
    for (const [id, route] of this.outgoing) this.#inbox(route.owner).transfers.get(id)?.cancel?.();
    for (const browser of this.browsers.values()) {
      for (const transfer of browser.transfers.active()) transfer.cancel?.();
      browser.events.stop();
    }
    await Promise.allSettled(this.#pending);
  }

  get cookieName(): string {
    return `lanfly_browser_${this.app.identity.port}`;
  }

  #signature(token: string): string {
    return createHmac('sha256', this.#key).update(token).digest('base64url');
  }

  join(token: string, name: string, host: string): { id: string; cookie: string } {
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
        host,
        lastSeen: Date.now(),
        connections: 0,
      };
      this.browsers.set(id, browser);
    }
    browser.info.name = name;
    browser.host = host;
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
    browser.host = clientAddress(request);
    browser.lastSeen = Date.now();
    return id;
  }

  attach(id: string, response: ServerResponse, fast = false): void {
    const browser = this.browsers.get(id)!;
    browser.connections++;
    browser.events.add(response, fast);
    if (fast) this.onFastClient?.();
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
      host: b.host,
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

  /** Notify every directly connected browser device to reload its UI. */
  reloadBrowsers(): number {
    let pages = 0;
    const payload = { at: Date.now() };
    for (const browser of this.browsers.values()) {
      pages += browser.events.connections;
      browser.events.broadcast('reload', payload);
    }
    return pages;
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
    if (
      payload.from.id !== senderId ||
      payload.from.roomId !== this.app.identity.roomId ||
      !this.app.peers.get(senderId)
    )
      throw new HttpError(403, 'DIRECT_PEER_REQUIRED');
    const seen = new Set<string>();
    for (const b of payload.browsers) {
      if (
        !b.id.startsWith('web-') ||
        b.gatewayId !== senderId ||
        seen.has(b.id) ||
        b.roomId !== this.app.identity.roomId ||
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
    if (
      payload.from.id !== gateway ||
      payload.from.roomId !== this.app.identity.roomId ||
      payload.sender.roomId !== this.app.identity.roomId
    )
      throw new HttpError(403, 'INVALID_SENDER');
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
    const expiresAt =
      payload.to !== this.app.identity.id ? Date.now() + BROWSER_OFFER_TTL : undefined;
    if (expiresAt)
      recipient.transfers.update(payload.id, {
        status: 'ready',
        deferred: true,
        expiresAt,
        downloadUrl: `/api/v1/browser/download/${payload.id}`,
      });
    this.incoming.set(payload.id, {
      destination: payload.to,
      sender: payload.sender.id,
      gateway,
      token,
      receiving: false,
      expiresAt,
    });
    return { token };
  }

  async sendFile(owner: string, peerId: string, file: FileMeta): Promise<SendFileResult> {
    const inbox = this.#inbox(owner);
    const transfer = inbox.transfers.createOutgoing(peerId, file);
    inbox.messages.addOutgoingFile(peerId, file, transfer.id);
    try {
      const gateway = this.#gateway(peerId);
      const deferred = this.peers().some((p) => p.id === peerId && p.kind === 'browser');
      const route: OutgoingFile = {
        owner,
        gateway,
        token: '',
        deferred,
        expiresAt: deferred ? Date.now() + BROWSER_OFFER_TTL : undefined,
      };
      // Register before delivering the offer: the recipient may click immediately.
      this.outgoing.set(transfer.id, route);
      const result = z.object({ token: z.string() }).parse(
        await this.#deliver({
          from: this.app.identity.info,
          sender: this.#self(owner),
          to: peerId,
          id: transfer.id,
          file,
        }),
      );
      route.token = result.token;
      inbox.transfers.update(transfer.id, {
        status: route.sessionId ? 'sending' : 'ready',
        deferred,
        expiresAt: route.expiresAt,
      });
      return {
        transferId: transfer.id,
        uploadUrl: this.#uploadUrl(owner, transfer.id),
        deferred,
        expiresAt: route.expiresAt,
      };
    } catch (error) {
      this.outgoing.delete(transfer.id);
      inbox.transfers.fail(transfer.id, 'PEER_UNREACHABLE');
      inbox.messages.setFileStatusByTransfer(transfer.id, 'failed', 'PEER_UNREACHABLE');
      logger.debug(`发送文件邀请失败：${String(error)}`);
      throwActionError('PEER_UNREACHABLE');
    }
  }

  #uploadUrl(owner: string, id: string, sessionId?: string): string {
    return `${owner === this.app.identity.id ? '/api/v1/local/upload/' : '/api/v1/browser/upload/'}${id}${sessionId ? `?session=${sessionId}` : ''}`;
  }

  async requestFile(value: unknown, gateway: string): Promise<void> {
    const { id, sessionId } = z
      .object({ id: z.string().uuid(), sessionId: z.string().uuid() })
      .parse(value);
    const route = this.outgoing.get(id);
    if (
      !route ||
      route.gateway !== gateway ||
      !route.deferred ||
      route.canceled ||
      route.expiresAt! <= Date.now()
    )
      throw new HttpError(410, 'FILE_EXPIRED');
    if (route.completion) await route.completion;
    if (route.canceled || route.expiresAt! <= Date.now()) throw new HttpError(410, 'FILE_EXPIRED');
    if (route.sessionId) throw new HttpError(409, 'TRANSFER_STATE');
    const inbox = this.#inbox(route.owner);
    if (!inbox.events.connections) throw new HttpError(409, 'FILE_SOURCE_UNAVAILABLE');
    route.sessionId = sessionId;
    inbox.transfers.update(id, { status: 'sending', error: undefined });
    inbox.transfers.progress(id, 0, true);
    inbox.messages.setFileStatusByTransfer(id, 'sending');
    inbox.events.broadcast('file-upload-request', {
      transferId: id,
      sessionId,
      uploadUrl: this.#uploadUrl(route.owner, id, sessionId),
    });
  }

  cancelFile(value: unknown, gateway: string): void {
    const { id, sessionId } = z
      .object({ id: z.string().uuid(), sessionId: z.string().uuid() })
      .parse(value);
    const route = this.outgoing.get(id);
    if (!route || route.gateway !== gateway || route.sessionId !== sessionId) return;
    route.sessionId = undefined;
    const inbox = this.#inbox(route.owner);
    inbox.transfers.get(id)?.cancel?.();
    if (!route.canceled) inbox.transfers.fail(id, 'TRANSFER_CANCELED');
    inbox.messages.setFileStatusByTransfer(id, 'failed', 'TRANSFER_CANCELED');
    inbox.events.broadcast('file-upload-cancel', { transferId: id, sessionId });
  }

  async #requestSource(id: string, incoming: IncomingFile, sessionId: string): Promise<void> {
    if (incoming.gateway === this.app.identity.id)
      await this.requestFile({ id, sessionId }, incoming.gateway);
    else
      await this.app.remote.browserRequest(
        this.app.peerTarget(incoming.gateway),
        'request-file',
        { id, sessionId },
        this.#abort.signal,
      );
  }

  async #cancelSource(id: string, incoming: IncomingFile, sessionId: string): Promise<void> {
    if (incoming.gateway === this.app.identity.id)
      this.cancelFile({ id, sessionId }, incoming.gateway);
    else
      await this.app.remote.browserRequest(
        this.app.peerTarget(incoming.gateway),
        'cancel-file',
        { id, sessionId },
        this.#abort.signal,
      );
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
    const sessionId =
      new URL(request.url ?? '/', 'http://localhost').searchParams.get('session') ?? undefined;
    if (
      !route ||
      route.owner !== owner ||
      !transfer ||
      route.canceled ||
      (route.deferred ? !sessionId || route.sessionId !== sessionId : transfer.status !== 'ready')
    )
      throw new HttpError(409, 'TRANSFER_STATE');
    if (route.deferred && transfer.uploading) throw new HttpError(409, 'TRANSFER_STATE');
    transfer.uploading = true;
    let resolveCompletion!: () => void;
    route.completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    inbox.transfers.update(id, { status: 'sending', error: undefined });
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
          () => inbox.transfers.setCancel(id, () => request.destroy()),
        );
      } else {
        const { request: remote, done } = this.app.remote.openUpload(
          this.app.peerTarget(route.gateway),
          id,
          route.token,
          transfer.file.size,
          `/api/v1/peer/browser-upload/${id}${sessionId ? `?session=${sessionId}` : ''}`,
        );
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
        if (result.status !== 200) throw new Error('TRANSFER_UPLOAD_FAILED');
        const receipt = z
          .object({ downloadedAt: z.number().optional() })
          .parse(JSON.parse(result.body));
        if (receipt.downloadedAt)
          inbox.transfers.update(id, { downloadedAt: receipt.downloadedAt });
        sendJson(response, 200, { ok: true });
      }
      inbox.transfers.complete(id);
      inbox.messages.setFileStatusByTransfer(id, 'sent');
    } catch (error) {
      if (inbox.transfers.get(id)?.status !== 'canceled') {
        inbox.transfers.fail(id, 'TRANSFER_UPLOAD_FAILED');
        inbox.messages.setFileStatusByTransfer(id, 'failed', 'TRANSFER_UPLOAD_FAILED');
      }
      const active = this.incoming.get(id)?.active;
      if (
        route.deferred &&
        route.gateway === this.app.identity.id &&
        active &&
        active.id === sessionId
      )
        active.relay.fail('TRANSFER_UPLOAD_FAILED');
      throw error;
    } finally {
      delete transfer.uploading;
      inbox.transfers.clearCancel(id);
      if (route.sessionId === sessionId) route.sessionId = undefined;
      if (!route.deferred) this.outgoing.delete(id);
      route.completion = undefined;
      resolveCompletion();
    }
  }

  async receiveUpload(
    id: string,
    token: string,
    request: IncomingMessage,
    response: ServerResponse,
    progress?: (bytes: number) => void,
    onStart?: () => void,
  ): Promise<void> {
    const incoming = this.incoming.get(id);
    if (!incoming || !safeTokenEquals(token, incoming.token))
      throw new HttpError(403, 'TRANSFER_TOKEN_INVALID');
    const inbox = this.#inbox(incoming.destination);
    const transfer = inbox.transfers.get(id)!;
    if (incoming.canceled || incoming.receiving) throw new HttpError(409, 'TRANSFER_STATE');
    if (incoming.destination !== this.app.identity.id) {
      const sessionId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('session');
      const active = incoming.active;
      if (!active || active.id !== sessionId) throw new HttpError(409, 'TRANSFER_STATE');
      incoming.receiving = true;
      onStart?.();
      try {
        await active.relay.upload(request, (bytes) => {
          inbox.transfers.progress(id, bytes);
          progress?.(bytes);
        });
        const downloadedAt = Date.now();
        inbox.transfers.complete(id);
        inbox.transfers.update(id, { downloadedAt });
        this.#track(this.#notifyReceipt(id, incoming, { downloadedAt }));
        sendJson(response, 200, { ok: true, downloadedAt });
      } finally {
        incoming.receiving = false;
      }
      return;
    }
    // PC is the final recipient: stream directly into its download directory.
    if (transfer.status !== 'receiving') throw new HttpError(409, 'TRANSFER_STATE');
    const declared = request.headers['content-length'];
    if (declared !== undefined && Number(declared) !== transfer.file.size)
      throw new HttpError(400, 'FILE_SIZE_MISMATCH');
    incoming.receiving = true;
    const temporary = temporaryPath(this.app.identity.downloadsDir, id);
    const stream = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    inbox.transfers.setCancel(id, () => {
      request.destroy();
      stream.destroy();
    });
    onStart?.();
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
        const finalPath = await finalizeFile(
          temporary,
          this.app.identity.downloadsDir,
          transfer.file.name,
        );
        inbox.transfers.complete(id, path.basename(finalPath));
        sendJson(response, 200, { ok: true });
      } catch (error) {
        inbox.transfers.fail(id, 'TRANSFER_UPLOAD_FAILED');
        await rm(temporary, { force: true });
        throw error;
      } finally {
        inbox.transfers.clearCancel(id);
        this.incoming.delete(id);
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
    if (!incoming || incoming.destination !== owner || !incoming.expiresAt || incoming.canceled)
      throw new HttpError(404, 'FILE_NOT_FOUND');
    if (incoming.expiresAt <= Date.now()) throw new HttpError(410, 'FILE_EXPIRED');
    if (incoming.active) throw new HttpError(409, 'TRANSFER_STATE');
    const inbox = this.#inbox(owner);
    const transfer = inbox.transfers.get(id)!;
    const sessionId = randomUUID();
    const relay = new DownloadRelay(transfer.file, response, this.downloadWaitTimeoutMs, (code) => {
      inbox.transfers.fail(id, code);
      this.#track(this.#cancelSource(id, incoming, sessionId));
    });
    incoming.active = { id: sessionId, relay };
    inbox.transfers.update(id, { status: 'receiving', error: undefined });
    inbox.transfers.progress(id, 0, true);
    this.#pending.add(relay.done);
    try {
      try {
        await this.#requestSource(id, incoming, sessionId);
      } catch {
        relay.fail('FILE_SOURCE_UNAVAILABLE');
      }
      await relay.done;
    } finally {
      this.#pending.delete(relay.done);
      if (incoming.active?.id === sessionId) incoming.active = undefined;
    }
  }

  async expireOffers(now = Date.now()): Promise<void> {
    for (const [id, incoming] of this.incoming) {
      if (!incoming.expiresAt || incoming.expiresAt > now || incoming.active || incoming.canceled)
        continue;
      this.#inbox(incoming.destination).transfers.update(id, {
        downloadUrl: undefined,
        expired: true,
      });
      incoming.canceled = true;
      await this.#notifyReceipt(id, incoming, { expired: true }).catch(() => {});
    }
    for (const [id, route] of this.outgoing) {
      if (!route.expiresAt || route.expiresAt > now || route.sessionId || route.canceled) continue;
      route.canceled = true;
      const inbox = this.#inbox(route.owner);
      inbox.transfers.update(id, { expired: true });
      inbox.events.broadcast('file-offer-ended', { transferId: id });
    }
  }

  async #notifyReceipt(
    id: string,
    incoming: IncomingFile,
    patch: { downloadedAt?: number; expired?: boolean; canceled?: boolean },
  ): Promise<void> {
    if (incoming.gateway === this.app.identity.id)
      this.receiveReceipt({ id, ...patch }, incoming.gateway);
    else
      await this.app.remote.browserRequest(
        this.app.peerTarget(incoming.gateway),
        'receipt',
        { id, ...patch },
        this.#abort.signal,
      );
  }

  receiveReceipt(value: unknown, gateway: string): void {
    const receipt = z
      .object({
        id: z.string().uuid(),
        downloadedAt: z.number().int().positive().optional(),
        expired: z.literal(true).optional(),
        canceled: z.literal(true).optional(),
      })
      .parse(value);
    const route = this.outgoing.get(receipt.id);
    if (!route || route.gateway !== gateway) throw new HttpError(403, 'INVALID_RECEIPT');
    const inbox = this.#inbox(route.owner);
    inbox.transfers.update(receipt.id, {
      ...(receipt.downloadedAt ? { downloadedAt: receipt.downloadedAt } : {}),
      ...(receipt.expired ? { expired: true } : {}),
      ...(receipt.canceled ? { status: 'canceled' } : {}),
    });
    if (receipt.canceled)
      inbox.messages.setFileStatusByTransfer(receipt.id, 'failed', 'TRANSFER_CANCELED');
    if (receipt.expired || receipt.canceled) {
      route.canceled = true;
      inbox.events.broadcast('file-offer-ended', { transferId: receipt.id });
    }
  }

  cancelOffer(value: unknown, gateway: string): void {
    const { id } = z.object({ id: z.string().uuid() }).parse(value);
    const incoming = this.incoming.get(id);
    if (!incoming || incoming.gateway !== gateway) throw new HttpError(403, 'TRANSFER_NOT_FOUND');
    this.#cancelIncoming(id, incoming);
  }

  #cancelIncoming(id: string, incoming: IncomingFile): void {
    incoming.canceled = true;
    incoming.active?.relay.fail('TRANSFER_CANCELED');
    this.#inbox(incoming.destination).transfers.update(id, {
      status: 'canceled',
      downloadUrl: undefined,
    });
  }

  cancel(owner: string, id: string): void {
    const inbox = this.#inbox(owner);
    if (!inbox.transfers.get(id)) throw new HttpError(404, 'TRANSFER_NOT_FOUND');
    const route = this.outgoing.get(id);
    if (route?.owner === owner && route.deferred) {
      route.canceled = true;
      if (route.sessionId) this.cancelFile({ id, sessionId: route.sessionId }, route.gateway);
      inbox.events.broadcast('file-offer-ended', { transferId: id });
      if (route.gateway === this.app.identity.id) this.cancelOffer({ id }, route.gateway);
      else
        this.#track(
          this.app.remote.browserRequest(
            this.app.peerTarget(route.gateway),
            'cancel-offer',
            { id },
            this.#abort.signal,
          ),
        );
    }
    const incoming = this.incoming.get(id);
    if (incoming?.destination === owner && incoming.expiresAt) {
      this.#cancelIncoming(id, incoming);
      this.#track(this.#notifyReceipt(id, incoming, { canceled: true }));
    }
    inbox.transfers.get(id)?.cancel?.();
    inbox.transfers.update(id, { status: 'canceled' });
    inbox.messages.setFileStatusByTransfer(id, 'failed', 'TRANSFER_CANCELED');
  }
}
