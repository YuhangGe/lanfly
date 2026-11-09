import { MAX_NAME_LENGTH } from './constants';

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 删除 ASCII 控制字符，避免它们进入设备名或文件名。 */
export function stripControlChars(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) result += char;
  }
  return result;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${SIZE_UNITS[unit]}`;
}

/** 去掉 hostname 常见的 .local 后缀，并压掉控制字符。 */
export function normalizeDeviceName(value: string | undefined, fallback = 'lanfly'): string {
  const cleaned = stripControlChars(
    (value ?? '').normalize('NFKC').replace(/\.(local|lan|home)$/i, ''),
  ).trim();
  const name = cleaned || fallback;
  return Array.from(name).slice(0, MAX_NAME_LENGTH).join('');
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
