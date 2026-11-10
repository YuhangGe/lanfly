import { inputSettingsSchema, type InputSettings } from '@lanfly/common';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { DataStore } from '../data';

const savedSchema = z.object({
  version: z.literal(1),
  privateKey: z.string(),
  settings: inputSettingsSchema,
  autoStart: z.boolean().default(false),
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
  readonly storage: DataStore;
  readonly #legacyFile: string;

  constructor(directory?: string) {
    this.storage = new DataStore(directory);
    this.file = this.storage.file;
    this.#legacyFile = path.join(
      directory ??
        process.env.LANFLY_CONFIG_DIR ??
        path.join(os.homedir(), 'Library', 'Application Support', 'lanfly'),
      'input.json',
    );
  }

  async load(): Promise<void> {
    try {
      await this.storage.load();
      const saved = this.storage.get('input');
      if (saved !== undefined) this.data = savedSchema.parse(saved);
      else {
        try {
          const legacy = savedSchema.parse(JSON.parse(await readFile(this.#legacyFile, 'utf8')));
          this.data = { ...legacy, autoStart: Boolean(legacy.paired) };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const { privateKey } = generateKeyPairSync('x25519');
          this.data = {
            version: 1,
            privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
            settings: { role: 'server', edge: 'right' },
            autoStart: false,
          };
        }
      }
      this.key = createPrivateKey({
        key: Buffer.from(this.data.privateKey, 'base64'),
        type: 'pkcs8',
        format: 'der',
      });
      if (this.key.asymmetricKeyType !== 'x25519') throw new Error('INPUT_CONFIG_ERROR');
      if (saved === undefined) await this.save();
    } catch {
      throw new Error('INPUT_CONFIG_ERROR');
    }
  }

  get publicKey(): string {
    return createPublicKey(this.key!).export({ type: 'spki', format: 'der' }).toString('base64');
  }

  get settings(): InputSettings {
    return this.data?.settings ?? { role: 'server', edge: 'right' };
  }

  async save(): Promise<void> {
    await this.storage.set('input', this.data);
  }

  async flush(): Promise<void> {
    await this.storage.flush();
  }
}
