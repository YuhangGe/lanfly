import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export interface NativeStatus {
  accessibility: boolean;
  inputMonitoring: boolean;
  screens: number;
}

export interface NativeInput {
  status(): string;
  requestPermissions(): void;
  start(role: string, edge: string): void;
  poll(): string;
  inject(event: string): void;
  reset(): void;
  stop(): void;
}

let binding: NativeInput | undefined;
export function loadNative(): NativeInput | undefined {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) return;
  if (binding) return binding;
  const require = createRequire(import.meta.url);
  // Root bundle, server development bundle, and unbundled source respectively.
  const local = [
    '../native/index.node',
    '../../../native/index.node',
    '../../../../native/index.node',
  ]
    .map((p) => fileURLToPath(new URL(p, import.meta.url)))
    .find(existsSync);
  try {
    binding = require(local ?? `lanfly-input-darwin-${process.arch}`) as NativeInput;
    return binding;
  } catch {
    return undefined;
  }
}
