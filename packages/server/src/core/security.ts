import type { IncomingHttpHeaders } from 'node:http';

import {
  ANNOUNCE_MAX_AGE_MS,
  PROTOCOL_VERSION,
  type PeerInfo,
  peerInfoSchema,
} from '@lanfly/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const MAGIC = Buffer.from('LANFLY3\0');
export interface Room {
  id: string;
}
export interface Announcement {
  kind: 'announce' | 'bye';
  info: PeerInfo;
  ts: number;
}
export type AnnouncementKind = Announcement['kind'];
export function createRoom(id: string): Room {
  return { id };
}
export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}
/** Room IDs isolate LAN groups. Announcements and payloads intentionally remain plaintext. */
export function encodeAnnouncement(announcement: Announcement, room: Room): Buffer {
  return Buffer.concat([
    MAGIC,
    Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, roomId: room.id, ...announcement })),
  ]);
}
export function decodeAnnouncement(packet: Buffer, room: Room): Announcement | null {
  if (packet.length < 9 || packet.length > 4096 || !packet.subarray(0, 8).equals(MAGIC))
    return null;
  try {
    const value = JSON.parse(packet.subarray(8).toString('utf8')) as Record<string, unknown>;
    if (
      value.v !== PROTOCOL_VERSION ||
      value.roomId !== room.id ||
      (value.kind !== 'announce' && value.kind !== 'bye') ||
      typeof value.ts !== 'number' ||
      Math.abs(Date.now() - value.ts) > ANNOUNCE_MAX_AGE_MS
    )
      return null;
    const info = peerInfoSchema.safeParse(value.info);
    if (!info.success || info.data.roomId !== room.id) return null;
    return { kind: value.kind, info: info.data, ts: value.ts };
  } catch {
    return null;
  }
}
export function roomHeaders(room: Room): Record<string, string> {
  return { 'x-lanfly-room': room.id };
}
export function matchesRoom(room: Room, headers: IncomingHttpHeaders): boolean {
  return headers['x-lanfly-room'] === room.id;
}
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
export function safeTokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
