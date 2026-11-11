import { DEFAULT_PORT, normalizeDeviceName } from '@lanfly/common';
import { randomInt } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { DataStore } from './data';

export interface ServerConfig {
  name: string;
  roomId: string;
  port: number;
  outDir: string;
  noDiscovery: boolean;
  verbose: boolean;
}

export function createServerConfig(input: {
  name?: string;
  roomId?: string;
  port?: number;
  outDir?: string;
  noDiscovery?: boolean;
  verbose?: boolean;
}): ServerConfig {
  return {
    name: normalizeDeviceName(input.name ?? os.hostname(), 'lanfly'),
    roomId: normalizeRoomId(input.roomId),
    port: input.port ?? DEFAULT_PORT,
    outDir: resolveUserPath(input.outDir ?? defaultDownloadsDir()),
    noDiscovery: input.noDiscovery ?? false,
    verbose: input.verbose ?? false,
  };
}

/** Resolve the room before constructing device identity and native input services. */
export async function loadServerConfig(
  input: Parameters<typeof createServerConfig>[0],
  storage = new DataStore(),
): Promise<ServerConfig> {
  await storage.load();
  const saved = storage.get('roomId');
  const selected = input.roomId === undefined ? saved : input.roomId;
  if (selected !== undefined && typeof selected !== 'string') throw new Error('ROOM_ID_INVALID');
  const config = createServerConfig({ ...input, roomId: selected });
  if (saved !== config.roomId) await storage.set('roomId', config.roomId);
  return config;
}

/** 默认使用系统下载目录；Windows 上同样落在用户目录下的 Downloads。 */
function resolveUserPath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.resolve(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

export function defaultDownloadsDir(): string {
  const override = process.env.LANFLY_DOWNLOAD_DIR;
  if (override) return resolveUserPath(override);
  return path.join(os.homedir(), 'Downloads');
}

export function normalizeRoomId(value?: string): string {
  if (value === undefined) return String(randomInt(1_000_000)).padStart(6, '0');
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('ROOM_ID_INVALID');
  return id;
}
