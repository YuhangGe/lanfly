import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DataStore } from '../src/data';
import { InputStore } from '../src/input/store';

const directories: string[] = [];
async function directory() {
  const result = await mkdtemp(path.join(os.tmpdir(), 'lanfly-data-'));
  directories.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('data.json configuration', () => {
  it('persists configuration namespaces without losing other settings', async () => {
    const dir = await directory();
    const data = new DataStore(dir);
    await data.load();
    await data.set('ui', { theme: 'dark' });
    const input = new InputStore(dir);
    await input.load();
    input.data!.settings.edge = 'left';
    await input.save();
    const loaded = new DataStore(dir);
    await loaded.load();
    expect(loaded.get('ui')).toEqual({ theme: 'dark' });
    expect(loaded.get('input')).toMatchObject({ settings: { edge: 'left' }, autoStart: false });
    expect(path.basename(input.file)).toBe('data.json');
    expect((await stat(input.file)).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent writes while preserving every namespace', async () => {
    const data = new DataStore(await directory());
    await data.load();
    await Promise.all([data.set('first', 1), data.set('second', 2), data.set('third', 3)]);
    expect(JSON.parse(await readFile(data.file, 'utf8'))).toEqual({
      first: 1,
      second: 2,
      third: 3,
    });
  });

  it('migrates an approved legacy pairing once and retains its identity', async () => {
    const dir = await directory();
    const input = new InputStore(dir);
    await input.load();
    const publicKey = input.publicKey;
    const { autoStart: _autoStart, ...legacy } = input.data!;
    legacy.settings = { role: 'client', edge: 'bottom' };
    legacy.paired = { key: publicKey, name: 'Saved peer', host: '192.168.1.20', port: 8089 };
    const legacyFile = path.join(dir, 'input.json');
    const content = JSON.stringify(legacy);
    await writeFile(legacyFile, content);
    await rm(input.file);
    const other = new DataStore(dir);
    await other.load();
    await other.set('ui', { theme: 'light' });
    const migrated = new InputStore(dir);
    await migrated.load();
    expect(migrated.publicKey).toBe(publicKey);
    expect(migrated.data?.autoStart).toBe(true);
    expect(migrated.data?.paired).toEqual(legacy.paired);
    expect(migrated.settings).toEqual(legacy.settings);
    expect(await readFile(legacyFile, 'utf8')).toBe(content);
    migrated.data!.autoStart = false;
    await migrated.save();
    const reloaded = new InputStore(dir);
    await reloaded.load();
    expect(reloaded.data?.autoStart).toBe(false);
    const stored = JSON.parse(await readFile(input.file, 'utf8')) as { ui: unknown };
    expect(stored.ui).toEqual({ theme: 'light' });
  });

  it('preserves corrupt files instead of silently regenerating paired identities', async () => {
    const dir = await directory();
    const file = path.join(dir, 'data.json');
    await writeFile(file, '{broken config');
    await expect(new InputStore(dir).load()).rejects.toThrow('INPUT_CONFIG_ERROR');
    expect(await readFile(file, 'utf8')).toBe('{broken config');
    await writeFile(file, JSON.stringify({ input: { version: 999 } }));
    await expect(new InputStore(dir).load()).rejects.toThrow('INPUT_CONFIG_ERROR');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ input: { version: 999 } });
  });
});
