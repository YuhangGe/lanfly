import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
  }
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const body = await readBody(req, limit);
  if (!body.length) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, code: string): void {
  sendJson(res, status, { error: code });
}

export function clientAddress(req: IncomingMessage): string {
  const address = req.socket.remoteAddress ?? '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

export function isLoopback(req: IncomingMessage): boolean {
  const address = clientAddress(req);
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

export function isLocalHostHeader(req: IncomingMessage): boolean {
  const header = req.headers.host;
  if (!header) return false;
  try {
    const hostname = new URL(`http://${header}`).hostname;
    return (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

export function isLocalOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname;
    return (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/** 本地 UI 接口只允许 loopback 访问，避免局域网内其它机器操作本机下载目录。 */
export function isTrustedLocalRequest(req: IncomingMessage): boolean {
  return isLoopback(req) && isLocalHostHeader(req) && isLocalOrigin(req);
}
