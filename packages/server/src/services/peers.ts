import { PEER_FORGET_MS, PEER_TTL_MS, type PeerInfo, type PeerView } from '@lanfly/common';

import type { EventHub } from './events';

function sortPeers(peers: PeerView[]): PeerView[] {
  return peers.sort((left, right) => {
    if (left.online !== right.online) return left.online ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh-CN');
  });
}

export class PeerStore {
  #peers = new Map<string, PeerView>();

  constructor(
    private readonly selfId: string,
    private readonly events: EventHub,
  ) {}

  list(): PeerView[] {
    return sortPeers([...this.#peers.values()].map((peer) => ({ ...peer })));
  }

  get(id: string): PeerView | undefined {
    return this.#peers.get(id);
  }

  addFromAnnouncement(info: PeerInfo, host: string, manualWhenNew = false): PeerView | null {
    if (info.id === this.selfId) return null;
    return this.#upsert(info, host, manualWhenNew, false);
  }

  addManual(info: PeerInfo, host: string): PeerView {
    return this.#upsert(info, host, true, true)!;
  }

  #upsert(
    info: PeerInfo,
    host: string,
    manualWhenNew: boolean,
    upgradeManual: boolean,
  ): PeerView | null {
    const now = Date.now();
    const existing = this.#peers.get(info.id);
    if (!existing) {
      // 同一 host:port 上出现新 ID，说明对方重启过；移除旧条目，避免列表重复。
      for (const [otherId, other] of this.#peers) {
        if (otherId !== info.id && other.host === host && other.port === info.port) {
          this.#peers.delete(otherId);
        }
      }
      const peer: PeerView = {
        ...info,
        host,
        lastSeen: now,
        online: true,
        manual: manualWhenNew,
      };
      this.#peers.set(info.id, peer);
      this.#emit();
      return { ...peer };
    }

    const changed =
      !existing.online ||
      existing.name !== info.name ||
      existing.port !== info.port ||
      existing.host !== host ||
      existing.version !== info.version ||
      existing.secret !== info.secret ||
      (upgradeManual && !existing.manual);

    existing.name = info.name;
    existing.port = info.port;
    existing.version = info.version;
    existing.secret = info.secret;
    existing.host = host;
    existing.lastSeen = now;
    existing.online = true;
    if (upgradeManual) existing.manual = true;
    if (changed) this.#emit();
    return { ...existing };
  }

  touch(id: string): void {
    const peer = this.#peers.get(id);
    if (!peer) return;
    const wasOffline = !peer.online;
    peer.lastSeen = Date.now();
    peer.online = true;
    if (wasOffline) this.#emit();
  }

  markOffline(id: string): void {
    const peer = this.#peers.get(id);
    if (!peer || !peer.online) return;
    peer.online = false;
    this.#emit();
  }

  remove(id: string): void {
    if (this.#peers.delete(id)) this.#emit();
  }

  /**
   * 超时设备先标记离线，让正在查看的会话和历史仍然保留；
   * 自动发现的设备过一段时间后再从列表移除，手动设备一直保留。
   */
  prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.#peers) {
      const idle = now - peer.lastSeen;
      if (idle <= PEER_TTL_MS) continue;
      if (peer.online) {
        peer.online = false;
        changed = true;
      }
      if (!peer.manual && idle > PEER_FORGET_MS) {
        this.#peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.#emit();
  }

  #emit(): void {
    this.events.broadcast('peers', this.list());
  }
}
