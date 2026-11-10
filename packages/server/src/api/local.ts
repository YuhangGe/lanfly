import type { IncomingMessage, ServerResponse } from 'node:http';

import { JSON_BODY_LIMIT, LOCAL_RPC_PREFIX, LOCAL_UPLOAD_PREFIX, SSE_PATH } from '@lanfly/common';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse, stringify } from 'superjson';

import type { Application } from '../app';

import { actions, type ActionName } from '../actions';
import { ErrorCodes, isActionFailure } from '../core/errors';
import { HttpError, isTrustedLocalRequest, readBody, sendError, sendJson } from '../core/http';
import { logger } from '../logger';

export async function handleLocalRequest(
  app: Application,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  if (!isTrustedLocalRequest(request)) {
    sendError(response, 403, 'FORBIDDEN');
    return;
  }

  if (pathname === SSE_PATH) {
    if (request.method !== 'GET') {
      sendError(response, 405, 'METHOD_NOT_ALLOWED');
      return;
    }
    app.events.add(response);
    return;
  }

  if (pathname.startsWith(LOCAL_UPLOAD_PREFIX)) {
    await handleLocalUpload(app, request, response, pathname.slice(LOCAL_UPLOAD_PREFIX.length));
    return;
  }

  if (pathname.startsWith(LOCAL_RPC_PREFIX)) {
    await handleRpc(app, request, response, pathname.slice(LOCAL_RPC_PREFIX.length));
    return;
  }

  sendError(response, 404, 'NOT_FOUND');
}

async function handleRpc(
  app: Application,
  request: IncomingMessage,
  response: ServerResponse,
  rawName: string,
): Promise<void> {
  if (request.method !== 'POST') {
    sendError(response, 405, 'METHOD_NOT_ALLOWED');
    return;
  }
  let actionName: string;
  try {
    actionName = decodeURIComponent(rawName);
  } catch {
    sendError(response, 400, 'BAD_REQUEST');
    return;
  }
  const action = actions[actionName as ActionName];
  if (!action) {
    sendError(response, 404, 'NOT_FOUND');
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(request, JSON_BODY_LIMIT);
  } catch (error) {
    sendError(response, error instanceof HttpError ? error.status : 400, 'BAD_REQUEST');
    return;
  }

  let input: unknown;
  if (action.input) {
    if (!body.length) {
      sendError(response, 400, ErrorCodes.INVALID_INPUT);
      return;
    }
    let decoded: unknown;
    try {
      decoded = parse(body.toString('utf8'));
    } catch {
      sendError(response, 400, 'BAD_REQUEST');
      return;
    }
    const parsed = action.input.safeParse(decoded);
    if (!parsed.success) {
      sendError(response, 400, ErrorCodes.INVALID_INPUT);
      return;
    }
    input = parsed.data;
  }

  try {
    const result = await action.fn({ app, request, response }, input);
    sendSuperJson(response, 200, [null, result]);
  } catch (error) {
    if (isActionFailure(error)) {
      sendSuperJson(response, 200, [{ code: error.code }]);
      return;
    }
    logger.error(error);
    sendSuperJson(response, 500, [{ code: ErrorCodes.INTERNAL_ERROR }]);
  }
}

function sendSuperJson(response: ServerResponse, status: number, data: unknown): void {
  if (response.writableEnded) return;
  const body = stringify(data);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function handleLocalUpload(
  app: Application,
  request: IncomingMessage,
  response: ServerResponse,
  rawId: string,
): Promise<void> {
  if (request.method !== 'POST') {
    sendError(response, 405, 'METHOD_NOT_ALLOWED');
    return;
  }

  let transferId: string;
  try {
    transferId = decodeURIComponent(rawId);
  } catch {
    sendError(response, 400, 'BAD_REQUEST');
    return;
  }

  if (app.network.outgoing.has(transferId)) {
    await app.network.upload(app.identity.id, transferId, request, response);
    return;
  }

  const transfer = app.transfers.get(transferId);
  if (!transfer || transfer.direction !== 'out') {
    sendError(response, 404, ErrorCodes.TRANSFER_NOT_FOUND);
    return;
  }
  if (!transfer.remoteToken) {
    sendError(response, 409, ErrorCodes.TRANSFER_STATE);
    return;
  }
  if (transfer.status !== 'ready') {
    sendError(response, 409, ErrorCodes.TRANSFER_STATE);
    return;
  }

  const declared = Number(request.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared !== transfer.file.size) {
    app.transfers.fail(transferId, ErrorCodes.TRANSFER_STATE);
    app.messages.setFileStatusByTransfer(transferId, 'failed', ErrorCodes.TRANSFER_STATE);
    sendError(response, 400, ErrorCodes.TRANSFER_STATE);
    return;
  }

  const target = app.peerTarget(transfer.peerId);
  const { request: remoteRequest, done } = app.remote.openUpload(
    target,
    transfer.id,
    transfer.remoteToken,
    transfer.file.size,
  );

  let canceled = false;
  app.transfers.setCancel(transferId, () => {
    canceled = true;
    request.destroy();
    remoteRequest.destroy(new Error('canceled'));
  });
  app.transfers.update(transferId, { status: 'sending' });

  request.on('aborted', () => {
    canceled = true;
    remoteRequest.destroy(new Error('client aborted'));
  });

  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      app.transfers.progress(transferId, received);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(request, meter, remoteRequest);
    const result = await done;
    if (result.status !== 200) {
      throw new Error(`peer rejected upload: ${result.status} ${result.body.slice(0, 200)}`);
    }
    if (received !== transfer.file.size) {
      throw new Error(`upload size mismatch: ${received} != ${transfer.file.size}`);
    }
    app.transfers.complete(transferId);
    app.messages.setFileStatusByTransfer(transferId, 'sent');
    if (!response.writableEnded) sendJson(response, 200, { ok: true });
  } catch (error) {
    const state = app.transfers.get(transferId)?.status;
    if (!canceled && state !== 'canceled') {
      const code = ErrorCodes.TRANSFER_UPLOAD_FAILED;
      app.transfers.fail(transferId, code);
      app.messages.setFileStatusByTransfer(transferId, 'failed', code);
      logger.debug(`上传 ${transfer.file.name} 失败：${String(error)}`);
    }
    if (!response.writableEnded && !canceled) {
      sendError(response, 502, ErrorCodes.TRANSFER_UPLOAD_FAILED);
    }
  } finally {
    app.transfers.clearCancel(transferId);
  }
}
