import { inputSettingsSchema, type InputSettings } from '@lanfly/common';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const savedSchema = z.object({
  version: z.literal(1),
  privateKey: z.string(),
  settings: inputSettingsSchema,
  paired: z
    .object({
      key: z.string().max(256),
      name: z.string().max(64),
      host: z.string().max(255),
      port: z.number().int().min(1).max(65535),
    })
    .optional(),
});
export type SavedInput = z.infer<typeof savedSchema>;

export class InputStore {
  readonly file: string;
  data: SavedInput | undefined;
  key: KeyObject | undefined;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    directory = process.env.LANFLY_CONFIG_DIR ??
      path.join(os.homedir(), 'Library', 'Application Support', 'lanfly'),
  ) {
    this.file = path.join(directory, 'input.json');
  }

  async load(): Promise<void> {
    try {
      this.data = savedSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
      this.key = createPrivateKey({
        key: Buffer.from(this.data.privateKey, 'base64'),
        type: 'pkcs8',
        format: 'der',
      });
      if (this.key.asymmetricKeyType !== 'x25519') throw new Error('INPUT_CONFIG_ERROR');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('INPUT_CONFIG_ERROR');
      const { privateKey } = generateKeyPairSync('x25519');
      this.key = privateKey;
      this.data = {
        version: 1,
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        settings: { role: 'server', edge: 'right' },
      };
    }
  }

  get publicKey(): string {
    return createPublicKey(this.key!).export({ type: 'spki', format: 'der' }).toString('base64');
  }

  get settings(): InputSettings {
    return this.data?.settings ?? { role: 'server', edge: 'right' };
  }

  async save(): Promise<void> {
    const content = JSON.stringify(this.data, null, 2) + '\n';
    // Serialize atomic writes, including failures, so pair/config changes cannot race.
    const next = this.#writes
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const temp = `${this.file}.${process.pid}.tmp`;
        await writeFile(temp, content, { mode: 0o600 });
        await rename(temp, this.file);
      });
    this.#writes = next;
    await next;
  }
}
