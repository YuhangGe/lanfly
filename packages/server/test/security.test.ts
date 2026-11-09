import type { IncomingHttpHeaders } from 'node:http';

import { ANNOUNCE_MAX_AGE_MS, PROTOCOL_VERSION, type PeerInfo } from '@lanfly/common';
import { describe, expect, it } from 'bun:test';

import {
  createRoom,
  createSignedHeaders,
  decodeAnnouncement,
  encodeAnnouncement,
  ReplayGuard,
  safeTokenEquals,
  verifySignedRequest,
} from '../src/core/security';

const info: PeerInfo = {
  id: 'peer-a',
  name: 'Test A',
  port: 8087,
  version: '0.1.0',
  secret: false,
};

function toHeaders(record: Record<string, string>): IncomingHttpHeaders {
  return { ...record };
}

describe('房间密钥与公告', () => {
  it('相同密码派生出相同房间标识，不同密码隔离', () => {
    const first = createRoom('correct horse battery staple')!;
    const second = createRoom('correct horse battery staple')!;
    const other = createRoom('another secret')!;
    expect(first.tag.equals(second.tag)).toBe(true);
    expect(first.tag.equals(other.tag)).toBe(false);
    expect(first.secret).toBe(true);
    expect(createRoom('')).toBeUndefined();
  });

  it('公开房间公告可以被公开设备解开', () => {
    const packet = encodeAnnouncement({ kind: 'announce', info, ts: Date.now() }, undefined);
    const decoded = decodeAnnouncement(packet, undefined);
    expect(decoded?.info).toEqual(info);
    expect(decoded?.kind).toBe('announce');
  });

  it('密码房间公告只对相同密码可见', () => {
    const room = createRoom('secret-one')!;
    const other = createRoom('secret-two')!;
    const packet = encodeAnnouncement(
      { kind: 'announce', info: { ...info, secret: true }, ts: Date.now() },
      room,
    );
    expect(decodeAnnouncement(packet, undefined)).toBeNull();
    expect(decodeAnnouncement(packet, other)).toBeNull();
    expect(decodeAnnouncement(packet, room)?.info.id).toBe(info.id);
  });

  it('被篡改或过期的公告会被丢弃', () => {
    const room = createRoom('secret-one')!;
    const packet = encodeAnnouncement(
      { kind: 'announce', info: { ...info, secret: true }, ts: Date.now() },
      room,
    );
    const tampered = Buffer.from(packet);
    tampered[tampered.length - 1] ^= 0xff;
    expect(decodeAnnouncement(tampered, room)).toBeNull();

    const expired = encodeAnnouncement(
      {
        kind: 'announce',
        info: { ...info, secret: true },
        ts: Date.now() - ANNOUNCE_MAX_AGE_MS - 1_000,
      },
      room,
    );
    expect(decodeAnnouncement(expired, room)).toBeNull();
  });

  it('协议版本不符的公告会被丢弃', () => {
    const packet = encodeAnnouncement({ kind: 'announce', info, ts: Date.now() }, undefined);
    const raw = JSON.parse(packet.subarray(8).toString('utf8')) as Record<string, unknown>;
    raw.v = PROTOCOL_VERSION + 99;
    const invalid = Buffer.concat([Buffer.from('LANFLY1\0'), Buffer.from(JSON.stringify(raw))]);
    expect(decodeAnnouncement(invalid, undefined)).toBeNull();
  });
});

describe('请求签名', () => {
  const room = createRoom('request-secret')!;
  const request = {
    method: 'POST',
    path: '/api/v1/peer/messages',
    body: Buffer.from('{"hello":"world"}'),
  };

  it('正确签名通过校验，重复 nonce 被拒绝', () => {
    const headers = createSignedHeaders(room, info.id, request);
    const guard = new ReplayGuard();
    expect(verifySignedRequest(room, toHeaders(headers), request, guard)?.id).toBe(info.id);
    expect(verifySignedRequest(room, toHeaders(headers), request, guard)).toBeNull();
  });

  it('请求体被修改后签名失效', () => {
    const headers = createSignedHeaders(room, info.id, request);
    const guard = new ReplayGuard();
    const changed = { ...request, body: Buffer.from('{"hello":"tampered"}') };
    expect(verifySignedRequest(room, toHeaders(headers), changed, guard)).toBeNull();
  });

  it('其它密码房间无法通过校验', () => {
    const headers = createSignedHeaders(room, info.id, request);
    const other = createRoom('other-secret')!;
    expect(verifySignedRequest(other, toHeaders(headers), request, new ReplayGuard())).toBeNull();
  });

  it('缺少签名头时校验失败', () => {
    expect(verifySignedRequest(room, {}, request, new ReplayGuard())).toBeNull();
  });
});

describe('令牌比较', () => {
  it('相同令牌为真，长度不同为假', () => {
    expect(safeTokenEquals('abc', 'abc')).toBe(true);
    expect(safeTokenEquals('abc', 'abcd')).toBe(false);
    expect(safeTokenEquals('abc', 'abd')).toBe(false);
  });
});
