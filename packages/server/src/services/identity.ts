import type { PeerInfo, SelfInfo } from '@lanfly/common';

import { randomUUID } from 'node:crypto';
import os from 'node:os';

import type { ServerConfig } from '../config';

import { createRoom, type Room } from '../core/security';
import { VERSION } from '../version';

function primaryIPv4(): string {
  const candidates: { name: string; address: string }[] = [];
  let fallback = '127.0.0.1';
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (address.address.startsWith('169.254.')) {
        fallback = address.address;
        continue;
      }
      candidates.push({ name, address: address.address });
    }
  }
  const preferred = /^(en|eth|wlan|wi-?fi|ethernet)/i;
  const virtual = /^(utun|tun|tap|vpn|docker|vmnet|bridge|awdl|llw)/i;
  candidates.sort((left, right) => {
    const leftScore = preferred.test(left.name) ? 0 : virtual.test(left.name) ? 2 : 1;
    const rightScore = preferred.test(right.name) ? 0 : virtual.test(right.name) ? 2 : 1;
    return leftScore - rightScore;
  });
  return candidates[0]?.address ?? fallback;
}

export class Identity {
  readonly id = randomUUID();
  readonly name: string;
  readonly version = VERSION;
  readonly downloadsDir: string;
  readonly room: Room;
  readonly host = primaryIPv4();
  port: number;

  constructor(config: ServerConfig) {
    this.name = config.name;
    this.port = config.port;
    this.downloadsDir = config.outDir;
    this.room = createRoom(config.roomId);
  }

  get roomId(): string {
    return this.room.id;
  }

  get info(): PeerInfo {
    return {
      id: this.id,
      name: this.name,
      port: this.port,
      version: this.version,
      roomId: this.roomId,
    };
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get self(): SelfInfo {
    return {
      ...this.info,
      host: this.host,
      url: this.url,
      downloadsDir: this.downloadsDir,
    };
  }
}
