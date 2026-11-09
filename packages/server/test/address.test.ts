import { describe, expect, it } from 'bun:test';

import { ErrorCodes, isActionFailure } from '../src/core/errors';
import { parsePeerAddress } from '../src/services/remote';

function failureCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isActionFailure(error) ? error.code : 'unexpected';
  }
}

describe('设备地址解析', () => {
  it('接受 IP、主机名和可选端口', () => {
    expect(parsePeerAddress('192.168.1.20', 8087)).toEqual({
      host: '192.168.1.20',
      port: 8087,
    });
    expect(parsePeerAddress('192.168.1.20:9000', 8087)).toEqual({
      host: '192.168.1.20',
      port: 9000,
    });
    expect(parsePeerAddress('http://my-mac.local:8088/', 8087)).toEqual({
      host: 'my-mac.local',
      port: 8088,
    });
    expect(parsePeerAddress('  localhost  ', 8087)).toEqual({
      host: 'localhost',
      port: 8087,
    });
  });

  it('支持 IPv6 方括号地址', () => {
    expect(parsePeerAddress('[::1]:9000', 8087)).toEqual({ host: '::1', port: 9000 });
  });

  it('拒绝空地址、路径、非 http 协议和非法端口', () => {
    expect(failureCode(() => parsePeerAddress('', 8087))).toBe(ErrorCodes.ADDRESS_INVALID);
    expect(failureCode(() => parsePeerAddress('http://host/path', 8087))).toBe(
      ErrorCodes.ADDRESS_INVALID,
    );
    expect(failureCode(() => parsePeerAddress('https://host:9000', 8087))).toBe(
      ErrorCodes.ADDRESS_INVALID,
    );
    expect(failureCode(() => parsePeerAddress('host:not-a-port', 8087))).toBe(
      ErrorCodes.ADDRESS_INVALID,
    );
    expect(failureCode(() => parsePeerAddress('host:0', 8087))).toBe(ErrorCodes.ADDRESS_INVALID);
  });
});
