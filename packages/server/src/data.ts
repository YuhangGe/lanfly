import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Config namespaces share data.json beside the running CLI bundle, not the shell cwd. */
export class DataStore {
  readonly file: string;
  loaded = false;
  #data: Record<string, unknown> = {};
  #writes: Promise<void> = Promise.resolve();

  constructor(
    directory = process.env.LANFLY_CONFIG_DIR ?? path.dirname(fileURLToPath(import.meta.url)),
  ) {
    this.file = path.join(directory, 'data.json');
  }

  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('CONFIG_DATA_ERROR');
      this.#data = value as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.#data = {};
    }
    this.loaded = true;
  }

  get(key: string): unknown {
    return this.#data[key];
  }

  async set(key: string, value: unknown): Promise<void> {
    const previous = this.#data;
    this.#data = { ...previous, [key]: value };
    const content = JSON.stringify(this.#data, null, 2) + '\n';
    const next = this.#writes
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.#writes = next;
    await next;
  }

  async flush(): Promise<void> {
    await this.#writes.catch(() => {});
  }
}
