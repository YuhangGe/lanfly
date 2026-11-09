import { DEFAULT_PORT, normalizeDeviceName } from '@lanfly/common';
import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  name: string;
  secret?: string;
  port: number;
  outDir: string;
  noDiscovery: boolean;
  verbose: boolean;
}

export function createServerConfig(input: {
  name?: string;
  secret?: string;
  port?: number;
  outDir?: string;
  noDiscovery?: boolean;
  verbose?: boolean;
}): ServerConfig {
  return {
    name: normalizeDeviceName(input.name ?? os.hostname(), 'lanfly'),
    secret: input.secret || undefined,
    port: input.port ?? DEFAULT_PORT,
    outDir: resolveUserPath(input.outDir ?? defaultDownloadsDir()),
    noDiscovery: input.noDiscovery ?? false,
    verbose: input.verbose ?? false,
  };
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
