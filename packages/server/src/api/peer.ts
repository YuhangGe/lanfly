import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  helloRequestSchema,
  JSON_BODY_LIMIT,
  PEER_HELLO_PATH,
  PEER_INFO_PATH,
  PEER_MESSAGES_PATH,
  PEER_TRANSFERS_PATH,
  peerMessageSchema,
  transferOfferSchema,
} from '@lanfly/common';
import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Application } from '../app';

import { ErrorCodes, isActionFailure } from '../core/errors';
import { clientAddress, HttpError, readBody, sendError, sendJson } from '../core/http';
import { safeTokenEquals, matchesRoom } from '../core/security';
import { logger } from '../logger';
import { finalizeFile, temporaryPath } from '../services/downloads';

export async function handlePeerRequest(
  app: Application,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  search: string,
): Promise<void> {
  const host = clientAddress(request) || '0.0.0.0';
  const fullPath = `${pathname}${search}`;
  if (!matchesRoom(app.identity.room, request.headers)) {
    sendError(response, 401, 'ROOM_MISMATCH');
    return;
  }

  if (pathname.startsWith('/api/v1/peer/browser-upload/') && request.method === 'PUT') {
    try {
      await app.network.receiveUpload(
        pathname.slice('/api/v1/peer/browser-upload/'.length),
        String(request.headers['x-lanfly-transfer-token'] ?? ''),
        request,
        response,
      );
    } catch (error) {
      if (!response.headersSent)
        sendError(
          response,
          error instanceof HttpError ? error.status : 500,
          error instanceof Error ? error.message : 'TRANSFER_UPLOAD_FAILED',
        );
    }
    return;
  }
  if (pathname.startsWith('/api/v1/peer/browser/') && request.method === 'POST') {
    const body = await readJsonAuthorized(app, request, response, fullPath);
    if (!body) return;
    const id = String(request.headers['x-lanfly-id'] ?? '');
    const peer = app.peers.get(id);
    const sameHost =
      peer &&
      (peer.host === host ||
        (await lookup(peer.host, { all: true }).catch(() => [])).some(
          (address) => address.address === host,
        ));
    if (!peer || !sameHost) {
      sendError(response, 403, 'DIRECT_PEER_REQUIRED');
      return;
    }
    try {
      if (pathname.endsWith('/roster')) {
        app.network.acceptRoster(body, id);
        sendJson(response, 200, { from: app.identity.info, browsers: app.network.localRoster() });
      } else if (pathname.endsWith('/request-file')) {
        await app.network.requestFile(body, id);
        sendJson(response, 200, { ok: true });
      } else if (pathname.endsWith('/cancel-file')) {
        app.network.cancelFile(body, id);
        sendJson(response, 200, { ok: true });
      } else if (pathname.endsWith('/cancel-offer')) {
        app.network.cancelOffer(body, id);
        sendJson(response, 200, { ok: true });
      } else if (pathname.endsWith('/receipt')) {
        app.network.receiveReceipt(body, id);
        sendJson(response, 200, { ok: true });
      } else if (pathname.endsWith('/deliver')) {
        sendJson(response, 200, app.network.receive(body, id));
      } else sendError(response, 404, 'NOT_FOUND');
    } catch (error) {
      sendError(
        response,
        error instanceof HttpError ? error.status : 400,
        error instanceof Error ? error.message : 'BAD_REQUEST',
      );
    }
    return;
  }

  if (pathname === PEER_INFO_PATH) {
    if (request.method !== 'GET') {
      sendError(response, 405, 'METHOD_NOT_ALLOWED');
      return;
    }
    if (!authorize(app, request, fullPath, Buffer.alloc(0))) {
      sendError(response, 401, 'UNAUTHORIZED');
      return;
    }
    sendJson(response, 200, app.identity.info);
    return;
  }

  if (pathname === PEER_HELLO_PATH) {
    if (request.method !== 'POST') {
      sendError(response, 405, 'METHOD_NOT_ALLOWED');
      return;
    }
    const body = await readJsonAuthorized(app, request, response, fullPath);
    if (!body) return;
    const parsed = helloRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST');
      return;
    }
    try {
      app.handlePeerHello(parsed.data.from, host);
      sendJson(response, 200, { info: app.identity.info });
    } catch (error) {
      sendPeerError(response, error);
    }
    return;
  }

  if (pathname === PEER_MESSAGES_PATH) {
    if (request.method !== 'POST') {
      sendError(response, 405, 'METHOD_NOT_ALLOWED');
      return;
    }
    const body = await readJsonAuthorized(app, request, response, fullPath);
    if (!body) return;
    const parsed = peerMessageSchema.safeParse(body);
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST');
      return;
    }
    try {
      app.handlePeerMessage(parsed.data, host);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendPeerError(response, error);
    }
    return;
  }

  if (pathname === PEER_TRANSFERS_PATH) {
    if (request.method !== 'POST') {
      sendError(response, 405, 'METHOD_NOT_ALLOWED');
      return;
    }
    const body = await readJsonAuthorized(app, request, response, fullPath);
    if (!body) return;
    const parsed = transferOfferSchema.safeParse(body);
    if (!parsed.success) {
      sendError(response, 400, 'BAD_REQUEST');
      return;
    }
    try {
      const result = app.handlePeerOffer(parsed.data, host);
      sendJson(response, 200, result);
    } catch (error) {
      sendPeerError(response, error);
    }
    return;
  }

  if (pathname.startsWith(`${PEER_TRANSFERS_PATH}/`) && request.method === 'PUT') {
    const rawId = pathname.slice(PEER_TRANSFERS_PATH.length + 1);
    if (!rawId || rawId.includes('/')) {
      sendError(response, 404, 'NOT_FOUND');
      return;
    }
    let transferId: string;
    try {
      transferId = decodeURIComponent(rawId);
    } catch {
      sendError(response, 400, 'BAD_REQUEST');
      return;
    }
    await handleIncomingUpload(app, request, response, transferId);
    return;
  }

  sendError(response, 404, 'NOT_FOUND');
}

async function readJsonAuthorized(
  app: Application,
  request: IncomingMessage,
  response: ServerResponse,
  fullPath: string,
): Promise<unknown> {
  let body: Buffer;
  try {
    body = await readBody(request, JSON_BODY_LIMIT);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    sendError(response, status, 'BAD_REQUEST');
    return undefined;
  }
  if (!authorize(app, request, fullPath, body)) {
    sendError(response, 401, 'UNAUTHORIZED');
    return undefined;
  }
  if (!body.length) {
    sendError(response, 400, 'BAD_REQUEST');
    return undefined;
  }
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendError(response, 400, 'BAD_REQUEST');
    return undefined;
  }
}

function authorize(
  app: Application,
  request: IncomingMessage,
  _fullPath: string,
  _body: Buffer,
): boolean {
  return matchesRoom(app.identity.room, request.headers);
}

async function handleIncomingUpload(
  app: Application,
  request: IncomingMessage,
  response: ServerResponse,
  transferId: string,
): Promise<void> {
  const transfer = app.transfers.get(transferId);
  if (!transfer || transfer.direction !== 'in') {
    sendError(response, 404, ErrorCodes.TRANSFER_NOT_FOUND);
    return;
  }
  const tokenHeader = request.headers['x-lanfly-transfer-token'];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  if (!token || !transfer.token || !safeTokenEquals(token, transfer.token)) {
    sendError(response, 403, ErrorCodes.TRANSFER_TOKEN_INVALID);
    return;
  }
  if (transfer.status !== 'receiving' || transfer.uploading) {
    sendError(response, 409, ErrorCodes.TRANSFER_STATE);
    return;
  }
  const declared = Number(request.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared !== transfer.file.size) {
    sendError(response, 400, ErrorCodes.TRANSFER_STATE);
    return;
  }

  transfer.uploading = true;
  const directory = app.identity.downloadsDir;
  const tempPath = temporaryPath(directory, transfer.id);
  await unlink(tempPath).catch(() => undefined);
  const writeStream = createWriteStream(tempPath, { flags: 'wx' });

  let canceled = false;
  let received = 0;
  app.transfers.setCancel(transferId, () => {
    canceled = true;
    request.destroy();
    writeStream.destroy();
    void unlink(tempPath).catch(() => undefined);
  });

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      app.transfers.progress(transferId, received);
      callback(null, chunk);
    },
  });

  request.on('aborted', () => {
    canceled = true;
    writeStream.destroy();
  });

  try {
    await pipeline(request, meter, writeStream);
    if (received !== transfer.file.size) {
      throw new Error(`size mismatch: ${received} != ${transfer.file.size}`);
    }
    const finalPath = await finalizeFile(tempPath, directory, transfer.file.name);
    const savedName = path.basename(finalPath);
    app.transfers.complete(transferId, savedName);
    delete transfer.token;
    delete transfer.uploading;
    sendJson(response, 200, { ok: true, name: savedName });
  } catch (error) {
    delete transfer.uploading;
    if (canceled || app.transfers.get(transferId)?.status === 'canceled') {
      app.transfers.cancel(transferId);
    } else {
      app.transfers.fail(transferId, ErrorCodes.DISK_ERROR);
      logger.warn(`接收文件 ${transfer.file.name} 失败：${String(error)}`);
    }
    await unlink(tempPath).catch(() => undefined);
    if (!response.writableEnded && !canceled) {
      sendError(response, 500, ErrorCodes.DISK_ERROR);
    }
  } finally {
    app.transfers.clearCancel(transferId);
  }
}

function sendPeerError(response: ServerResponse, error: unknown): void {
  if (isActionFailure(error)) {
    const status = error.code === ErrorCodes.TRANSFER_DUPLICATE ? 409 : 400;
    sendError(response, status, error.code);
    return;
  }
  logger.error(error);
  sendError(response, 500, ErrorCodes.INTERNAL_ERROR);
}
