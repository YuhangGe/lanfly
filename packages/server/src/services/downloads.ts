import { stripControlChars } from '@lanfly/common';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { link, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ILLEGAL = /[\\/:*?"<>|]/g;

/** 只保留文件名本身，清除路径分隔符、控制字符和 Windows 保留名。 */
export function sanitizeFileName(raw: string): string {
  let name = path.basename(raw.replaceAll('\\', '/'));
  name = stripControlChars(name.normalize('NFC'));
  name = name.replace(ILLEGAL, '_').trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!name) name = 'file';
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;

  const chars = Array.from(name);
  if (chars.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    const stem = chars.slice(0, Math.max(1, 180 - ext.length)).join('');
    name = `${stem}${ext}`;
  }
  return name || 'file';
}

export async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export function candidateName(name: string, index: number): string {
  if (index === 0) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  return `${stem} (${index})${ext}`;
}

/** 找到一个尚未存在的最终路径，不创建文件。 */
export function uniquePath(directory: string, name: string): string {
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = path.join(directory, candidateName(name, index));
    if (!existsSync(candidate)) return candidate;
  }
  return path.join(directory, `${Date.now()}-${name}`);
}

/**
 * 把下载到临时文件的内容移到最终位置。优先使用 link 原子占名，
 * 避免并发接收时覆盖已有文件；文件系统不支持硬链接时回退到 rename。
 */
export async function finalizeFile(
  tempPath: string,
  directory: string,
  name: string,
): Promise<string> {
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = path.join(directory, candidateName(name, index));
    try {
      await link(tempPath, candidate);
      await unlink(tempPath).catch(() => undefined);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      if (code === 'EPERM' || code === 'ENOSYS' || code === 'EXDEV' || code === 'EACCES') {
        try {
          await rename(tempPath, candidate);
          return candidate;
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw renameError;
        }
      }
      throw error;
    }
  }
  throw new Error('无法为文件生成不重复的名称');
}

export function openDirectory(directory: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const args = process.platform === 'win32' ? [directory] : [directory];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => undefined);
  child.unref();
}

export function temporaryPath(directory: string, transferId: string): string {
  return path.join(directory, `.lanfly-${transferId}.part`);
}

/** 清理上次异常退出遗留的临时文件；只处理超过一天的 .part，避免误删其它实例的传输。 */
export async function cleanupStaleTempFiles(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const cutoff = Date.now() - 24 * 60 * 60_000;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      if (!entry.name.startsWith('.lanfly-') || !entry.name.endsWith('.part')) return;
      const filePath = path.join(directory, entry.name);
      try {
        const info = await stat(filePath);
        if (info.mtimeMs < cutoff) await unlink(filePath);
      } catch {
        // 文件可能已被其它进程清理。
      }
    }),
  );
}
