import {
  DESKTOP_TOKEN_HEADER,
  PEER_DESKTOP_ACCEPT_PATH,
  PEER_DESKTOP_ERROR_PATH,
  PEER_DESKTOP_ICE_PATH,
  PEER_DESKTOP_OFFER_PATH,
  PEER_DESKTOP_REJECT_PATH,
  PEER_DESKTOP_REQUEST_PATH,
  PEER_DESKTOP_STATE_PATH,
  PEER_DESKTOP_STOP_PATH,
  PEER_HELLO_PATH,
  PEER_INFO_PATH,
  PEER_MESSAGES_PATH,
  PEER_TRANSFERS_PATH,
  peerInfoSchema,
  peerTransferPath,
  REQUEST_TIMEOUT_MS,
  type PeerInfo,
  type TransferOfferPayload,
} from '@lanfly/common';
import http, { type ClientRequest } from 'node:http';

import type { Identity } from './identity';

import { ErrorCodes, throwActionError } from '../core/errors';
import { roomHeaders, type Room } from '../core/security';
import { logger } from '../logger';

export interface PeerTarget {
  host: string;
  port: number;
}

export interface UploadResponse {
  status: number;
  body: string;
}

export interface PendingUpload {
  request: ClientRequest;
  done: Promise<UploadResponse>;
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function responseError(status: number): never {
  if (status === 401 || status === 403) throwActionError(ErrorCodes.PEER_UNAUTHORIZED);
  throwActionError(ErrorCodes.PEER_HTTP_ERROR);
}

export class RemoteClient {
  constructor(
    private readonly identity: Identity,
    private readonly room: Room,
  ) {}

  async info(target: PeerTarget, timeoutMs = 5_000): Promise<PeerInfo> {
    const data = await this.#requestJson(target, 'GET', PEER_INFO_PATH, undefined, timeoutMs);
    return parsePeerInfo(data);
  }

  async hello(target: PeerTarget): Promise<PeerInfo> {
    const data = await this.#requestJson(target, 'POST', PEER_HELLO_PATH, {
      from: this.identity.info,
    });
    if (typeof data !== 'object' || data === null || !('info' in data)) {
      throwActionError(ErrorCodes.PEER_PROTOCOL);
    }
    return parsePeerInfo((data as { info: unknown }).info);
  }

  async sendMessage(target: PeerTarget, payload: Record<string, unknown>): Promise<void> {
    await this.#requestJson(target, 'POST', PEER_MESSAGES_PATH, payload);
  }

  async desktopRequest(target: PeerTarget, payload: unknown): Promise<void> {
    await this.#requestJson(target, 'POST', PEER_DESKTOP_REQUEST_PATH, payload);
  }

  async desktopAccept(target: PeerTarget, payload: unknown): Promise<void> {
    await this.#requestJson(target, 'POST', PEER_DESKTOP_ACCEPT_PATH, payload);
  }

  async desktopReject(target: PeerTarget, payload: unknown): Promise<void> {
    await this.#requestJson(target, 'POST', PEER_DESKTOP_REJECT_PATH, payload);
  }

  async desktopOffer(
    target: PeerTarget,
    payload: unknown,
    token: string,
  ): Promise<{ sdp: string; width: number; height: number }> {
    const data = await this.#requestJson(
      target,
      'POST',
      PEER_DESKTOP_OFFER_PATH,
      payload,
      REQUEST_TIMEOUT_MS,
      undefined,
      token,
    );
    if (
      typeof data !== 'object' ||
      data === null ||
      typeof (data as { sdp?: unknown }).sdp !== 'string'
    ) {
      throwActionError(ErrorCodes.PEER_PROTOCOL);
    }
    const value = data as { sdp: string; width?: unknown; height?: unknown };
    return {
      sdp: value.sdp,
      width: typeof value.width === 'number' ? value.width : 0,
      height: typeof value.height === 'number' ? value.height : 0,
    };
  }

  async desktopIce(target: PeerTarget, payload: unknown, token: string): Promise<void> {
    await this.#requestJson(
      target,
      'POST',
      PEER_DESKTOP_ICE_PATH,
      payload,
      REQUEST_TIMEOUT_MS,
      undefined,
      token,
    );
  }

  async desktopStop(target: PeerTarget, payload: unknown, token: string): Promise<void> {
    await this.#requestJson(
      target,
      'POST',
      PEER_DESKTOP_STOP_PATH,
      payload,
      REQUEST_TIMEOUT_MS,
      undefined,
      token,
    );
  }

  async desktopState(target: PeerTarget, payload: unknown, token: string): Promise<void> {
    await this.#requestJson(
      target,
      'POST',
      PEER_DESKTOP_STATE_PATH,
      payload,
      REQUEST_TIMEOUT_MS,
      undefined,
      token,
    );
  }

  async desktopError(target: PeerTarget, payload: unknown, token: string): Promise<void> {
    await this.#requestJson(
      target,
      'POST',
      PEER_DESKTOP_ERROR_PATH,
      payload,
      REQUEST_TIMEOUT_MS,
      undefined,
      token,
    );
  }

  async offerTransfer(target: PeerTarget, payload: TransferOfferPayload): Promise<string> {
    const data = await this.#requestJson(target, 'POST', PEER_TRANSFERS_PATH, payload);
    if (
      typeof data !== 'object' ||
      data === null ||
      !('token' in data) ||
      typeof (data as { token: unknown }).token !== 'string'
    ) {
      throwActionError(ErrorCodes.PEER_PROTOCOL);
    }
    return (data as { token: string }).token;
  }

  browserRequest(
    target: PeerTarget,
    path: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.#requestJson(
      target,
      'POST',
      `/api/v1/peer/browser/${path}`,
      payload,
      REQUEST_TIMEOUT_MS,
      signal,
    );
  }

  openUpload(
    target: PeerTarget,
    transferId: string,
    token: string,
    size: number,
    uploadPath?: string,
  ): PendingUpload {
    let resolveDone: (value: UploadResponse) => void;
    let rejectDone: (error: unknown) => void;
    const done = new Promise<UploadResponse>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const request = http.request(
      {
        hostname: target.host,
        port: target.port,
        path: uploadPath ?? peerTransferPath(transferId),
        method: 'PUT',
        agent: false,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(size),
          'x-lanfly-id': this.identity.id,
          ...roomHeaders(this.room),
          'x-lanfly-transfer-token': token,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length <= 64 * 1024) chunks.push(chunk);
        });
        response.on('error', rejectDone);
        response.on('aborted', () => rejectDone(new Error('peer upload aborted')));
        response.on('end', () => {
          resolveDone({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    request.setTimeout(60_000, () => {
      request.destroy(new Error('peer upload idle timeout'));
    });
    request.on('error', (error) => {
      logger.debug(`上传到 ${target.host}:${target.port} 失败: ${String(error)}`);
      rejectDone(error);
    });
    return { request, done };
  }

  async #requestJson(
    target: PeerTarget,
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
    token?: string,
  ): Promise<unknown> {
    const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
    const room = roomHeaders(this.room);
    const headers: Record<string, string> = {
      'x-lanfly-id': this.identity.id,
      ...room,
    };
    if (body.length) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.length);
    }
    if (token) headers[DESKTOP_TOKEN_HEADER] = token;

    const init: RequestInit = {
      method,
      headers,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    };
    if (body.length) init.body = body;

    let response: Response;
    try {
      response = await fetch(`http://${formatHost(target.host)}:${target.port}${path}`, init);
    } catch (error) {
      logger.debug(`请求 ${target.host}:${target.port}${path} 失败: ${String(error)}`);
      throwActionError(ErrorCodes.PEER_UNREACHABLE);
    }

    const text = await response.text();
    if (!response.ok) {
      logger.debug(
        `请求 ${target.host}:${target.port}${path} 返回 ${response.status}: ${text.slice(0, 200)}`,
      );
      responseError(response.status);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throwActionError(ErrorCodes.PEER_PROTOCOL);
    }
  }
}

function parsePeerInfo(value: unknown): PeerInfo {
  const parsed = peerInfoSchema.safeParse(value);
  if (!parsed.success) throwActionError(ErrorCodes.PEER_PROTOCOL);
  return parsed.data;
}

export function parsePeerAddress(
  input: string,
  defaultPort: number,
): { host: string; port: number } {
  const trimmed = input.trim();
  if (!trimmed) throwActionError(ErrorCodes.ADDRESS_INVALID);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throwActionError(ErrorCodes.ADDRESS_INVALID);
  }
  if (url.protocol !== 'http:') {
    throwActionError(ErrorCodes.ADDRESS_INVALID);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throwActionError(ErrorCodes.ADDRESS_INVALID);
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) throwActionError(ErrorCodes.ADDRESS_INVALID);
  const port = url.port ? Number(url.port) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throwActionError(ErrorCodes.ADDRESS_INVALID);
  }
  return { host, port };
}
