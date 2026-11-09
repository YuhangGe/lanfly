import type { IncomingMessage, ServerResponse } from 'node:http';

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLIC_DIR } from '../version';
import { sendError } from './http';

const PUBLIC_ROOT = path.resolve(fileURLToPath(PUBLIC_DIR));

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export async function sendStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return;
  }

  if (!existsSync(PUBLIC_ROOT)) {
    if (pathname === '/' || pathname === '/index.html') {
      const html =
        '<!doctype html><meta charset="utf-8"><title>lanfly</title>' +
        '<body style="font-family:system-ui;padding:40px;background:#181818;color:#ccc">' +
        '<h1>前端尚未构建</h1><p>请先运行 <code>pnpm build</code>，或使用 <code>pnpm dev</code> 访问 Vite 开发服务器。</p>';
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    sendError(res, 404, 'NOT_FOUND');
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendError(res, 400, 'BAD_REQUEST');
    return;
  }

  // 无后缀的路径视为前端入口，SPA 刷新时也能拿到 index.html。
  if (decoded === '/' || !/\.[a-z0-9]+$/i.test(decoded)) decoded = '/index.html';
  const filepath = path.resolve(PUBLIC_ROOT, `.${decoded}`);
  if (filepath !== PUBLIC_ROOT && !filepath.startsWith(PUBLIC_ROOT + path.sep)) {
    sendError(res, 404, 'NOT_FOUND');
    return;
  }

  let info;
  try {
    info = await stat(filepath);
  } catch {
    sendError(res, 404, 'NOT_FOUND');
    return;
  }
  if (!info.isFile()) {
    sendError(res, 404, 'NOT_FOUND');
    return;
  }

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  const type = MIME_TYPES[path.extname(filepath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    etag,
    'last-modified': info.mtime.toUTCString(),
    'cache-control':
      path.basename(filepath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filepath).pipe(res);
}
