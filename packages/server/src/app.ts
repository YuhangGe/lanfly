import type { AddressInfo } from 'node:net';

import {
  DEFAULT_PORT,
  LOCAL_UPLOAD_PREFIX,
  type AppState,
  type ChatMessage,
  type FileMeta,
  type PeerInfo,
  type PeerMessagePayload,
  type SendFileResult,
  type TransferOfferPayload,
  type TransferView,
} from '@lanfly/common';
import http from 'node:http';

import type { ServerConfig } from './config';

import { ErrorCodes, errorCode, throwActionError } from './core/errors';
import { createHttpHandler } from './core/router';
import { randomToken } from './core/security';
import { MulticastDiscovery } from './discovery/multicast';
import { InputService } from './input/service';
import { logger } from './logger';
import { BrowserNetwork } from './services/browser-network';
import {
  cleanupStaleTempFiles,
  ensureDir,
  openDirectory,
  sanitizeFileName,
} from './services/downloads';
import { EventHub } from './services/events';
import { Identity } from './services/identity';
import { MessageStore } from './services/messages';
import { PeerStore } from './services/peers';
import { parsePeerAddress, RemoteClient, type PeerTarget } from './services/remote';
import { TransferStore } from './services/transfers';

export class Application {
  readonly identity: Identity;
  readonly events = new EventHub();
  readonly peers: PeerStore;
  readonly messages: MessageStore;
  readonly transfers: TransferStore;
  readonly remote: RemoteClient;
  readonly config: ServerConfig;
  readonly input: InputService;
  readonly network: BrowserNetwork;

  #server: http.Server | undefined;
  #discovery: MulticastDiscovery | undefined;
  #pruneTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #heartbeatRunning = false;

  constructor(config: ServerConfig) {
    this.config = config;
    this.identity = new Identity(config);
    this.peers = new PeerStore(this.identity.id, this.events);
    this.messages = new MessageStore(this.events);
    this.transfers = new TransferStore(this.events);
    this.remote = new RemoteClient(this.identity, this.identity.room);
    this.input = new InputService(this.identity.name, this.events, { roomId: config.roomId });
    this.network = new BrowserNetwork(this);
    this.events.peersProvider = () => this.network.peers();
    this.events.onPeersChanged = () => this.network.publishBrowserPeers();
  }

  async start(): Promise<number> {
    await this.input.initialize();
    try {
      await ensureDir(this.identity.downloadsDir);
    } catch (error) {
      logger.error(`无法创建下载目录 ${this.identity.downloadsDir}: ${String(error)}`);
      throwActionError(ErrorCodes.DOWNLOAD_DIR_ERROR);
    }
    const server = http.createServer(createHttpHandler(this));
    server.on('upgrade', (request, socket, head) => this.input.upgrade(request, socket, head));
    server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    this.#server = server;
    const port = await listenWithFallback(server, this.config.port, 20);
    this.identity.port = port;
    try {
      await this.network.start();
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.input.listen(port);
    this.input.resume();

    if (!this.config.noDiscovery) {
      this.#discovery = new MulticastDiscovery(
        this.identity,
        this.identity.room,
        (kind, info, host) => this.#handleAnnouncement(kind, info, host),
      );
      this.#discovery.start();
    }

    // 下载目录可能很大，放到服务可用之后异步清理，避免拖慢启动。
    void cleanupStaleTempFiles(this.identity.downloadsDir).catch((error) => {
      logger.debug(`清理临时文件失败：${String(error)}`);
    });

    this.#pruneTimer = setInterval(() => this.peers.prune(), 2_000);
    this.#pruneTimer.unref();
    this.#heartbeatTimer = setInterval(() => void this.#heartbeat(), 5_000);
    this.#heartbeatTimer.unref();

    logger.info(`lanfly 已启动：${this.identity.name}，${this.identity.roomId}，端口 ${port}`);
    return port;
  }

  async stop(): Promise<void> {
    await this.input.stop();
    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#discovery?.stop();
    for (const transfer of this.transfers.active()) {
      try {
        transfer.cancel?.();
      } catch {
        // ignore
      }
      this.transfers.cancel(transfer.id);
    }
    this.events.stop();
    // Close browser SSE connections before waiting for the HTTP server.
    for (const browser of this.network.browsers.values()) browser.events.stop();
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(() => {
          server.closeAllConnections();
          resolve();
        }, 800).unref();
      });
    }
    await this.network.stop();
  }

  getState(): AppState {
    return {
      self: this.identity.self,
      peers: this.network.peers(),
      messages: this.messages.list(),
      transfers: this.transfers.list(),
    };
  }

  async sendMessage(input: { peerId: string; text: string }): Promise<ChatMessage> {
    if (this.network.peers().some((p) => p.id === input.peerId && p.kind === 'browser'))
      return this.network.sendText(this.identity.id, input.peerId, input.text);
    const peer = this.#requirePeer(input.peerId);
    const message = this.messages.addOutgoingText(peer.id, input.text);
    return this.#deliverText(peer, message);
  }

  async retryMessage(input: { messageId: string }): Promise<ChatMessage> {
    const message = this.messages.get(input.messageId);
    if (!message) throwActionError(ErrorCodes.MESSAGE_NOT_FOUND);
    if (message.direction !== 'out' || message.kind !== 'text' || message.status !== 'failed') {
      throwActionError(ErrorCodes.MESSAGE_NOT_RETRYABLE);
    }
    if (this.network.peers().some((p) => p.id === message.peerId && p.kind === 'browser'))
      return this.network.retry(this.identity.id, message.id);
    const peer = this.#requirePeer(message.peerId);
    this.messages.setStatus(message.id, 'sending');
    return this.#deliverText(peer, this.messages.get(message.id)!);
  }

  async #deliverText(peer: PeerInfo, message: ChatMessage): Promise<ChatMessage> {
    try {
      await this.remote.sendMessage(
        { host: this.#hostOf(peer.id), port: peer.port },
        {
          id: message.id,
          text: message.text ?? '',
          sentAt: message.createdAt,
          from: this.identity.info,
        },
      );
      this.peers.touch(peer.id);
      return this.messages.setStatus(message.id, 'sent')!;
    } catch (error) {
      const code = errorCode(error, ErrorCodes.PEER_UNREACHABLE);
      this.messages.setStatus(message.id, 'failed', code);
      this.peers.markOffline(peer.id);
      throw error;
    }
  }

  async connectPeer(input: { address: string }): Promise<PeerInfo> {
    const target = parsePeerAddress(input.address, DEFAULT_PORT);
    let info: PeerInfo;
    try {
      info = await this.remote.info(target);
    } catch (error) {
      if (errorCode(error) === ErrorCodes.PEER_UNAUTHORIZED) {
        throwActionError(ErrorCodes.ROOM_MISMATCH);
      }
      throw error;
    }
    if (info.id === this.identity.id) throwActionError(ErrorCodes.SELF_CONNECT);
    this.#ensureCompatible(info);

    try {
      await this.remote.hello({ host: target.host, port: info.port });
    } catch (error) {
      this.peers.remove(info.id);
      throw error;
    }

    this.peers.addManual(info, target.host);
    this.peers.touch(info.id);
    return info;
  }

  forgetPeer(input: { peerId: string }): void {
    this.peers.remove(input.peerId);
  }

  async sendFile(input: { peerId: string; file: FileMeta }): Promise<SendFileResult> {
    if (this.network.peers().some((p) => p.id === input.peerId && p.kind === 'browser'))
      return this.network.sendFile(this.identity.id, input.peerId, input.file);
    const peer = this.#requirePeer(input.peerId);
    const transfer = this.transfers.createOutgoing(peer.id, input.file);
    this.messages.addOutgoingFile(peer.id, input.file, transfer.id);

    const payload: TransferOfferPayload = {
      transferId: transfer.id,
      file: input.file,
      from: this.identity.info,
    };
    try {
      const token = await this.remote.offerTransfer(
        { host: this.#hostOf(peer.id), port: peer.port },
        payload,
      );
      transfer.remoteToken = token;
      this.transfers.update(transfer.id, { status: 'ready' });
      this.peers.touch(peer.id);
    } catch (error) {
      const code = errorCode(error, ErrorCodes.PEER_UNREACHABLE);
      this.transfers.fail(transfer.id, code);
      this.messages.setFileStatusByTransfer(transfer.id, 'failed', code);
      this.peers.markOffline(peer.id);
      throw error;
    }

    return {
      transferId: transfer.id,
      uploadUrl: `${LOCAL_UPLOAD_PREFIX}${encodeURIComponent(transfer.id)}`,
    };
  }

  cancelTransfer(input: { transferId: string }): TransferView | undefined {
    if (this.network.outgoing.has(input.transferId)) {
      this.network.cancel(this.identity.id, input.transferId);
      return this.transfers.list().find((t) => t.id === input.transferId);
    }
    const transfer = this.transfers.get(input.transferId);
    if (!transfer) throwActionError(ErrorCodes.TRANSFER_NOT_FOUND);
    if (
      transfer.status === 'completed' ||
      transfer.status === 'failed' ||
      transfer.status === 'canceled'
    ) {
      return this.transfers.list().find((item) => item.id === transfer.id);
    }
    try {
      transfer.cancel?.();
    } catch {
      // ignore
    }
    this.transfers.cancel(transfer.id);
    if (transfer.direction === 'out') {
      this.messages.setFileStatusByTransfer(transfer.id, 'failed', 'TRANSFER_CANCELED');
    }
    return this.transfers.list().find((item) => item.id === transfer.id);
  }

  openDownloads(): { path: string } {
    openDirectory(this.identity.downloadsDir);
    return { path: this.identity.downloadsDir };
  }

  handlePeerHello(info: PeerInfo, host: string): PeerInfo {
    this.#ensureCompatible(info);
    if (info.id !== this.identity.id) this.peers.addManual(info, host);
    return this.identity.info;
  }

  handlePeerMessage(payload: PeerMessagePayload, host: string): void {
    this.#ensureCompatible(payload.from);
    this.peers.addFromAnnouncement(payload.from, host, true);
    this.messages.addIncomingText(payload.from.id, payload);
  }

  handlePeerOffer(payload: TransferOfferPayload, host: string): { token: string } {
    this.#ensureCompatible(payload.from);
    this.peers.addFromAnnouncement(payload.from, host, true);
    if (this.transfers.get(payload.transferId)) {
      throwActionError(ErrorCodes.TRANSFER_DUPLICATE);
    }
    const file: FileMeta = {
      ...payload.file,
      name: sanitizeFileName(payload.file.name),
    };
    const token = randomToken();
    this.transfers.createIncoming(payload.from.id, payload.transferId, file, token);
    this.messages.addIncomingFile(payload.from.id, file, payload.transferId);
    return { token };
  }

  peerTarget(peerId: string): PeerTarget {
    const peer = this.#requirePeer(peerId);
    return { host: peer.host, port: peer.port };
  }

  #requirePeer(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) throwActionError(ErrorCodes.PEER_NOT_FOUND);
    return peer;
  }

  #hostOf(peerId: string): string {
    return this.#requirePeer(peerId).host;
  }

  #ensureCompatible(info: PeerInfo): void {
    if (info.roomId !== this.identity.roomId) throwActionError(ErrorCodes.ROOM_MISMATCH);
  }

  #handleAnnouncement(kind: 'announce' | 'bye', info: PeerInfo, host: string): void {
    if (kind === 'bye') {
      // 对方正常退出时也保留为离线，正在查看的会话不会立刻消失；
      // 自动发现的设备会在 PeerStore.prune 中延迟移除。
      this.peers.markOffline(info.id);
      return;
    }
    this.peers.addFromAnnouncement(info, host);
  }

  async #heartbeat(): Promise<void> {
    if (this.#heartbeatRunning) return;
    this.#heartbeatRunning = true;
    try {
      const manualPeers = this.peers
        .list()
        .filter((peer) => peer.manual && Date.now() - peer.lastSeen > 3_000);
      await Promise.allSettled(
        manualPeers.map(async (peer) => {
          try {
            const info = await this.remote.info({ host: peer.host, port: peer.port }, 4_000);
            if (info.id !== peer.id || !peer.online) {
              // 对方重启或刚刚恢复时，重新握手，让双方列表都恢复。
              await this.remote.hello({ host: peer.host, port: info.port }).catch(() => undefined);
              if (info.id !== peer.id) this.peers.remove(peer.id);
              this.peers.addManual(info, peer.host);
            } else {
              this.peers.addFromAnnouncement(info, peer.host, true);
              this.peers.touch(info.id);
            }
          } catch {
            this.peers.markOffline(peer.id);
          }
        }),
      );
    } finally {
      this.#heartbeatRunning = false;
    }
  }
}

async function listenWithFallback(
  server: http.Server,
  requestedPort: number,
  attempts: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let port = requestedPort;
    let remaining = requestedPort === 0 ? 1 : attempts;

    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    const onListening = () => {
      cleanup();
      resolve((server.address() as AddressInfo).port);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && remaining > 1) {
        remaining -= 1;
        port += 1;
        logger.warn(`端口 ${port - 1} 已被占用，改用 ${port}`);
        server.listen(port, '0.0.0.0');
        return;
      }
      cleanup();
      reject(error);
    };

    server.on('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}
