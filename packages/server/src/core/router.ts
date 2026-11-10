import type { IncomingMessage, ServerResponse } from 'node:http';

import { LOCAL_RPC_PREFIX, LOCAL_UPLOAD_PREFIX, PEER_API_PREFIX, SSE_PATH } from '@lanfly/common';

import type { Application } from '../app';

import { handleBrowserRequest } from '../api/browser';
import { handleLocalRequest } from '../api/local';
import { handlePeerRequest } from '../api/peer';
import { logger } from '../logger';
import { HttpError, sendError } from './http';
import { sendStatic } from './static';

export function createHttpHandler(app: Application) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
    void dispatch(app, request, response).catch((error) => {
      logger.error(error);
      if (!response.headersSent)
        sendError(
          response,
          error instanceof HttpError ? error.status : 500,
          error instanceof HttpError ? error.message : 'INTERNAL_ERROR',
        );
      else if (!response.writableEnded) response.end();
    });
  };
}

async function dispatch(
  app: Application,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    sendError(response, 400, 'BAD_REQUEST');
    return;
  }

  const pathname = url.pathname;
  if (pathname.startsWith('/api/v1/browser/')) {
    await handleBrowserRequest(app, request, response, pathname);
    return;
  }
  if (pathname.startsWith(PEER_API_PREFIX)) {
    await handlePeerRequest(app, request, response, pathname, url.search);
    return;
  }
  if (
    pathname.startsWith(LOCAL_RPC_PREFIX) ||
    pathname.startsWith(LOCAL_UPLOAD_PREFIX) ||
    pathname === SSE_PATH
  ) {
    await handleLocalRequest(app, request, response, pathname);
    return;
  }
  await sendStatic(request, response, pathname);
}
