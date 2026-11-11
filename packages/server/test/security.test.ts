import { PROTOCOL_VERSION, type PeerInfo } from '@lanfly/common';
import { describe, expect, it } from 'bun:test';

import { createServerConfig } from '../src/config';
import {
  createRoom,
  encodeAnnouncement,
  decodeAnnouncement,
  matchesRoom,
  roomHeaders,
  safeTokenEquals,
} from '../src/core/security';
const info: PeerInfo = {
  id: 'device-a',
  name: 'Test',
  port: 8087,
  version: '0.2.0',
  roomId: '123456',
};
describe('plaintext room isolation', () => {
  it('generates a six digit room ID when absent, and preserves explicit IDs', () => {
    expect(createServerConfig({}).roomId).toMatch(/^\d{6}$/);
    expect(createServerConfig({ roomId: '000123' }).roomId).toBe('000123');
    expect(createServerConfig({ roomId: 'team-a' }).roomId).toBe('team-a');
    expect(() => createServerConfig({ roomId: '' })).toThrow('ROOM_ID_INVALID');
  });
  it('announcements are readable plaintext and only accepted in the same room', () => {
    const packet = encodeAnnouncement(
      { kind: 'announce', info, ts: Date.now() },
      createRoom('123456'),
    );
    expect(packet.toString()).toContain('"name":"Test"');
    expect(packet.toString()).toContain('123456');
    expect(decodeAnnouncement(packet, createRoom('123456'))?.info).toEqual(info);
    expect(decodeAnnouncement(packet, createRoom('654321'))).toBeNull();
  });
  it('rejects old, invalid and mismatched announcements', () => {
    const room = createRoom('123456');
    expect(
      decodeAnnouncement(encodeAnnouncement({ kind: 'bye', info, ts: 1 }, room), room),
    ).toBeNull();
    expect(decodeAnnouncement(Buffer.from('garbage'), room)).toBeNull();
    const bad = Buffer.from(
      `LANFLY3\0${JSON.stringify({ v: PROTOCOL_VERSION + 1, kind: 'announce', info, roomId: '123456', ts: Date.now() })}`,
    );
    expect(decodeAnnouncement(bad, room)).toBeNull();
    expect(
      decodeAnnouncement(
        encodeAnnouncement(
          { kind: 'announce', info: { ...info, roomId: 'other' }, ts: Date.now() },
          room,
        ),
        room,
      ),
    ).toBeNull();
  });
  it('requires the room header; there is no public or encrypted branch', () => {
    const room = createRoom('123456');
    expect(matchesRoom(room, roomHeaders(room))).toBe(true);
    expect(matchesRoom(room, {})).toBe(false);
    expect(matchesRoom(room, { 'x-lanfly-room': '654321' })).toBe(false);
  });
  it('compares upload and browser session tokens', () => {
    expect(safeTokenEquals('token', 'token')).toBe(true);
    expect(safeTokenEquals('token', 'bad')).toBe(false);
  });
});
