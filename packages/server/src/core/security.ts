import type { IncomingHttpHeaders } from 'node:http';

import {
  ANNOUNCE_MAX_AGE_MS,
  PROTOCOL_VERSION,
  type PeerInfo,
  peerInfoSchema,
} from '@lanfly/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const PUBLIC_MAGIC = Buffer.from('LANFLY1\0');
const SECRET_MAGIC = Buffer.from('LANFLY2\0');
const ROOM_TAG_LENGTH = 16;
const NONCE_LENGTH = 12;
const MAX_PACKET_SIZE = 4 * 1024;

export interface Room {
  key: Buffer;
  tag: Buffer;
  secret: boolean;
}

export type AnnouncementKind = 'announce' | 'bye';

export interface Announcement {
  kind: AnnouncementKind;
  info: PeerInfo;
  ts: number;
}

/** 密码只在本机派生房间密钥，从不明文出现在网络中。 */
export function createRoom(secret: string | undefined): Room | undefined {
  if (!secret) return undefined;
  const normalized = secret.normalize('NFKC');
  const key = scryptSync(normalized, 'lanfly-room-v1', 32, {
    N: 1 << 14,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const tag = createHmac('sha256', key)
    .update('lanfly-room-tag-v1')
    .digest()
    .subarray(0, ROOM_TAG_LENGTH);
  return { key, tag, secret: true };
}

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

export function encodeAnnouncement(announcement: Announcement, room: Room | undefined): Buffer {
  const json = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, ...announcement }), 'utf8');
  if (!room) return Buffer.concat([PUBLIC_MAGIC, json]);

  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', room.key, nonce);
  cipher.setAAD(Buffer.concat([SECRET_MAGIC, room.tag]));
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([SECRET_MAGIC, room.tag, nonce, ciphertext]);
}

export function decodeAnnouncement(packet: Buffer, room: Room | undefined): Announcement | null {
  if (packet.length < 9 || packet.length > MAX_PACKET_SIZE) return null;
  const magic = packet.subarray(0, 8);

  let json: Buffer;
  if (!room) {
    if (!magic.equals(PUBLIC_MAGIC)) return null;
    json = packet.subarray(8);
  } else {
    if (!magic.equals(SECRET_MAGIC)) return null;
    if (packet.length < 8 + ROOM_TAG_LENGTH + NONCE_LENGTH + 16) return null;
    const tag = packet.subarray(8, 8 + ROOM_TAG_LENGTH);
    if (!timingSafeEqual(tag, room.tag)) return null;
    const nonce = packet.subarray(8 + ROOM_TAG_LENGTH, 8 + ROOM_TAG_LENGTH + NONCE_LENGTH);
    const ciphertext = packet.subarray(8 + ROOM_TAG_LENGTH + NONCE_LENGTH);
    try {
      const decipher = createDecipheriv('aes-256-gcm', room.key, nonce);
      decipher.setAAD(Buffer.concat([SECRET_MAGIC, room.tag]));
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      json = Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
        decipher.final(),
      ]);
    } catch {
      return null;
    }
  }

  let value: unknown;
  try {
    value = JSON.parse(json.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== PROTOCOL_VERSION) return null;
  if (record.kind !== 'announce' && record.kind !== 'bye') return null;
  if (typeof record.ts !== 'number' || Math.abs(Date.now() - record.ts) > ANNOUNCE_MAX_AGE_MS) {
    return null;
  }
  const parsed = peerInfoSchema.safeParse(record.info);
  if (!parsed.success) return null;
  return { kind: record.kind, info: parsed.data, ts: record.ts };
}

export interface SignedRequest {
  method: string;
  /** 包含查询串的 path，必须与接收端 request.url 完全一致。 */
  path: string;
  body: Buffer;
}

const AUTH_ID = 'x-lanfly-id';
const AUTH_TS = 'x-lanfly-ts';
const AUTH_NONCE = 'x-lanfly-nonce';
const AUTH_SIGNATURE = 'x-lanfly-signature';

/**
 * 签名串中的时间戳和 nonce 由调用方补充，保证发送端签名与接收端验证使用同一份值。
 */
function signaturePayloadWith(
  id: string,
  request: SignedRequest,
  timestamp: string,
  nonce: string,
): string {
  return [
    id,
    request.method.toUpperCase(),
    request.path,
    timestamp,
    nonce,
    sha256(request.body).toString('hex'),
  ].join('\n');
}

export function createSignedHeaders(
  room: Room | undefined,
  id: string,
  request: SignedRequest,
): Record<string, string> {
  if (!room) return {};
  const timestamp = String(Date.now());
  const nonce = randomBytes(12).toString('base64url');
  const signature = createHmac('sha256', room.key)
    .update(signaturePayloadWith(id, request, timestamp, nonce))
    .digest('base64url');
  return {
    [AUTH_ID]: id,
    [AUTH_TS]: timestamp,
    [AUTH_NONCE]: nonce,
    [AUTH_SIGNATURE]: signature,
  };
}

export class ReplayGuard {
  #seen = new Map<string, number>();

  check(key: string): boolean {
    const now = Date.now();
    if (this.#seen.size > 4096) {
      for (const [value, at] of this.#seen) if (now - at > 5 * 60_000) this.#seen.delete(value);
    }
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, now);
    return true;
  }
}

export function verifySignedRequest(
  room: Room,
  headers: IncomingHttpHeaders,
  request: SignedRequest,
  replayGuard: ReplayGuard,
): { id: string } | null {
  const id = headerValue(headers[AUTH_ID]);
  const timestamp = headerValue(headers[AUTH_TS]);
  const nonce = headerValue(headers[AUTH_NONCE]);
  const signature = headerValue(headers[AUTH_SIGNATURE]);
  if (!id || !timestamp || !nonce || !signature) return null;
  if (!/^\d+$/.test(timestamp)) return null;
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return null;
  if (nonce.length < 8 || nonce.length > 64) return null;
  if (!replayGuard.check(`${id}:${nonce}`)) return null;

  const expected = createHmac('sha256', room.key)
    .update(signaturePayloadWith(id, request, timestamp, nonce))
    .digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { id };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function safeTokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
