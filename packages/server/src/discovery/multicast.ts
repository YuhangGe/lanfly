import {
  ANNOUNCE_INTERVAL_MS,
  DISCOVERY_GROUP,
  DISCOVERY_PORT,
  type PeerInfo,
} from '@lanfly/common';
import dgram, { type RemoteInfo } from 'node:dgram';

import type { Identity } from '../services/identity';

import {
  decodeAnnouncement,
  encodeAnnouncement,
  type AnnouncementKind,
  type Room,
} from '../core/security';
import { logger } from '../logger';

export type AnnouncementHandler = (kind: AnnouncementKind, info: PeerInfo, host: string) => void;

export class MulticastDiscovery {
  #socket: dgram.Socket | undefined;
  #timer: NodeJS.Timeout | undefined;
  #warned = false;

  constructor(
    private readonly identity: Identity,
    private readonly room: Room | undefined,
    private readonly onAnnouncement: AnnouncementHandler,
  ) {}

  start(): void {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.#socket = socket;

    socket.on('error', (error) => {
      if (!this.#warned) {
        this.#warned = true;
        logger.warn(`自动发现不可用（${error.message}），可在界面中手动添加设备 IP。`);
      }
    });

    socket.on('message', (packet, info) => {
      this.#handlePacket(packet, info);
    });

    socket.on('listening', () => {
      try {
        socket.addMembership(DISCOVERY_GROUP);
        socket.setMulticastTTL(1);
        socket.setMulticastLoopback(true);
      } catch (error) {
        logger.warn(`加入组播组失败：${String(error)}`);
      }
      this.#send('announce');
      this.#timer = setInterval(() => this.#send('announce'), ANNOUNCE_INTERVAL_MS);
      this.#timer.unref();
    });

    try {
      socket.bind({ port: DISCOVERY_PORT, exclusive: false });
    } catch (error) {
      logger.warn(`无法监听发现端口：${String(error)}`);
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    const socket = this.#socket;
    if (!socket) return;
    try {
      this.#send('bye');
    } catch {
      // socket 可能已经关闭。
    }
    this.#socket = undefined;
    setTimeout(() => {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }, 30).unref();
  }

  #handlePacket(packet: Buffer, info: RemoteInfo): void {
    const announcement = decodeAnnouncement(packet, this.room);
    if (!announcement) return;
    if (announcement.info.id === this.identity.id) return;
    this.onAnnouncement(announcement.kind, announcement.info, info.address);
  }

  #send(kind: AnnouncementKind): void {
    const socket = this.#socket;
    if (!socket) return;
    const packet = encodeAnnouncement(
      { kind, info: this.identity.info, ts: Date.now() },
      this.room,
    );
    socket.send(packet, 0, packet.length, DISCOVERY_PORT, DISCOVERY_GROUP, (error) => {
      if (error) logger.debug(`发送组播公告失败：${String(error)}`);
    });
  }
}
