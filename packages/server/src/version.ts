import { existsSync, readFileSync } from 'node:fs';

function readVersion(): string {
  try {
    const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && 'version' in value) {
      return String(value.version);
    }
  } catch {
    // 开发脚本直接运行源码时 package.json 仍然存在；读取失败时用兜底值。
  }
  return '0.0.0';
}

export const VERSION = readVersion();

/**
 * 发布包布局是 dist/cli.js + dist/public；源码开发时 server bundle 位于
 * packages/server/dist，前端由 Vite 单独提供。这里同时兼容两种布局。
 */
const PUBLIC_CANDIDATES = [
  new URL('./public/', import.meta.url),
  new URL('../public/', import.meta.url),
];
export const PUBLIC_DIR =
  PUBLIC_CANDIDATES.find((candidate) => existsSync(candidate)) ?? PUBLIC_CANDIDATES[0];
