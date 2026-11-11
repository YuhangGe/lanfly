import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  JSON_BODY_LIMIT,
  desktopIceInput,
  desktopOfferInput,
  desktopRejectInput,
  desktopRequestInput,
  retryMessageInput,
  sendFileInput,
  sendMessageInput,
  transferIdInput,
} from '@lanfly/common';
import { parse, stringify } from 'superjson';
import { z } from 'zod';

import type { Application } from '../app';

import { isActionFailure } from '../core/errors';
import { clientAddress, HttpError, readBody, sendError, sendJson } from '../core/http';

const joinSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  name: z.string().trim().min(1).max(64),
});

/** Browser actions have their own allowlist and never dispatch host administration/native-input actions. */
export async function handleBrowserRequest(
  app: Application,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  try {
    const origin = request.headers.origin;
    if (origin && new URL(origin).host !== request.headers.host)
      throw new HttpError(403, 'FORBIDDEN');
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'FORBIDDEN');
    if (request.method === 'POST' && !origin) throw new HttpError(403, 'ORIGIN_REQUIRED');
    const route = pathname.slice('/api/v1/browser/'.length);
    if (route === 'join' && request.method === 'POST') {
      const input = joinSchema.parse(
        JSON.parse((await readBody(request, JSON_BODY_LIMIT)).toString('utf8')),
      );
      const result = app.network.join(input.token, input.name);
      response.setHeader('set-cookie', result.cookie);
      sendJson(response, 200, { id: result.id });
      return;
    }
    if (route === 'address' && request.method === 'GET') {
      // Used only to replace Chrome's mDNS host candidate with the browser's real LAN address
      // in the desktop signaling hint. It does not grant any access by itself.
      sendJson(response, 200, { address: clientAddress(request) });
      return;
    }
    const id = app.network.authenticate(request);
    if (route === 'events' && request.method === 'GET') {
      app.network.attach(id, response);
      return;
    }
    if (route.startsWith('download/') && request.method === 'GET') {
      await app.network.download(id, route.slice(9), response);
      return;
    }
    if (route.startsWith('upload/') && request.method === 'POST') {
      await app.network.upload(id, route.slice(7), request, response);
      return;
    }
    if (!route.startsWith('rpc/') || request.method !== 'POST')
      throw new HttpError(404, 'NOT_FOUND');
    const body = await readBody(request, JSON_BODY_LIMIT);
    const input: unknown = body.length ? parse(body.toString('utf8')) : undefined;
    let result: unknown;
    switch (route.slice(4)) {
      case 'appState':
        result = app.network.state(id);
        break;
      case 'sendMessage': {
        const p = sendMessageInput.parse(input);
        result = await app.network.sendText(id, p.peerId, p.text);
        break;
      }
      case 'sendFile': {
        const p = sendFileInput.parse(input);
        result = await app.network.sendFile(id, p.peerId, p.file);
        break;
      }
      case 'retryMessage':
        result = await app.network.retry(id, retryMessageInput.parse(input).messageId);
        break;
      case 'cancelTransfer':
        app.network.cancel(id, transferIdInput.parse(input).transferId);
        break;
      case 'browserRename':
        app.network.rename(
          id,
          z.object({ name: z.string().trim().min(1).max(64) }).parse(input).name,
        );
        break;
      case 'desktopRequest':
        result = await app.desktop.request(id, desktopRequestInput.parse(input));
        break;
      case 'desktopState':
        result = app.desktop.state(id);
        break;
      case 'desktopOffer': {
        const p = desktopOfferInput.parse(input);
        result = await app.desktop.offer(id, p.sessionId, p.sdp);
        break;
      }
      case 'desktopIce': {
        const p = desktopIceInput.parse(input);
        await app.desktop.ice(id, p.sessionId, p.candidate);
        break;
      }
      case 'desktopStop': {
        const p = desktopRejectInput.parse(input);
        await app.desktop.stopSession(id, p.sessionId, p.reason);
        break;
      }
      default:
        throw new HttpError(403, 'FORBIDDEN');
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(stringify([null, result]));
  } catch (error) {
    if (isActionFailure(error) && !response.headersSent) {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(stringify([{ code: error.code }]));
      return;
    }
    if (response.headersSent) {
      response.end();
      return;
    }
    sendError(
      response,
      error instanceof HttpError
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : 502,
      error instanceof Error ? error.message : 'BROWSER_ERROR',
    );
  }
}
