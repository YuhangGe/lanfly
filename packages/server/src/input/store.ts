import { inputSettingsSchema, type InputSettings } from '@lanfly/common';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { DataStore } from '../data';

const targetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(64),
  host: z.string().max(255),
  port: z.number().int().min(1).max(65535),
  roomId: z.string().min(1).max(64),
});
const savedSchema = z.object({
  version: z.literal(2),
  id: z.string().uuid(),
  settings: inputSettingsSchema,
  autoStart: z.boolean().default(false),
  target: targetSchema.optional(),
});
const legacySchema = z.object({ version: z.literal(1), settings: inputSettingsSchema });
export type SavedInput = z.infer<typeof savedSchema>;
export class InputStore {
  readonly storage: DataStore;
  readonly file: string;
  data?: SavedInput;
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
      let saved = this.storage.get('input');
      if (saved === undefined) {
        try {
          saved = JSON.parse(await readFile(this.#legacyFile, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (saved !== undefined && (saved as { version?: number }).version === 2)
        this.data = savedSchema.parse(saved);
      else {
        // Old cryptographic pairings have no Room ID. Retain layout only; reconnect explicitly in the new room.
        const legacy = saved === undefined ? undefined : legacySchema.parse(saved);
        this.data = {
          version: 2,
          id: randomUUID(),
          settings: legacy?.settings ?? { role: 'server', edge: 'right' },
          autoStart: false,
        };
        await this.save();
      }
    } catch {
      throw new Error('INPUT_CONFIG_ERROR');
    }
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
