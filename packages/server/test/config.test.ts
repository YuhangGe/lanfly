import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadServerConfig } from '../src/config';
import { DataStore } from '../src/data';

const directories: string[] = [];
async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lanfly-config-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('persistent Room ID', () => {
  it('generates once and uses the saved room on subsequent startups', async () => {
    const dir = await directory();
    const first = await loadServerConfig({}, new DataStore(dir));
    expect(first.roomId).toMatch(/^\d{6}$/);
    expect(JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8')).roomId).toBe(
      first.roomId,
    );
    const next = await loadServerConfig({}, new DataStore(dir));
    expect(next.roomId).toBe(first.roomId);
  });
  it('persists explicit overrides and preserves other namespaces', async () => {
    const dir = await directory();
    const file = path.join(dir, 'data.json');
    await writeFile(
      file,
      JSON.stringify({
        roomId: 'old-room',
        input: { retained: true },
        browser: { key: 'retained' },
      }),
    );
    const selected = await loadServerConfig({ roomId: '000123' }, new DataStore(dir));
    expect(selected.roomId).toBe('000123');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      roomId: '000123',
      input: { retained: true },
      browser: { key: 'retained' },
    });
    expect((await loadServerConfig({}, new DataStore(dir))).roomId).toBe('000123');
  });
  it('preserves corrupt files and rejects invalid saved IDs instead of silently switching rooms', async () => {
    const dir = await directory();
    const file = path.join(dir, 'data.json');
    await writeFile(file, '{broken');
    await expect(loadServerConfig({}, new DataStore(dir))).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{broken');
    await writeFile(file, JSON.stringify({ roomId: 123456 }));
    await expect(loadServerConfig({}, new DataStore(dir))).rejects.toThrow('ROOM_ID_INVALID');
    expect(JSON.parse(await readFile(file, 'utf8')).roomId).toBe(123456);
    expect((await loadServerConfig({ roomId: 'valid' }, new DataStore(dir))).roomId).toBe('valid');
  });
});
