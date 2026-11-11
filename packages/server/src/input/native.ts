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
  desktopStatus?(): string;
  desktopRequestPermissions?(): void;
  desktopStart?(sessionId: string, config: string): string;
  desktopOffer?(sessionId: string, sdp: string): string;
  desktopIce?(sessionId: string, candidate: string): void;
  desktopStop?(sessionId: string): void;
  desktopStopAll?(): void;
  desktopPoll?(): string;
  desktopBitrate?(sessionId: string, bitrate: number): void;
  desktopKeyframe?(sessionId: string): void;
  desktopInput?(event: string): void;
}

export interface NativeDesktop {
  desktopStatus(): string;
  desktopRequestPermissions(): void;
  desktopStart(sessionId: string, config: string): string;
  desktopOffer(sessionId: string, sdp: string): string;
  desktopIce(sessionId: string, candidate: string): void;
  desktopStop(sessionId: string): void;
  desktopStopAll(): void;
  desktopPoll(): string;
  desktopBitrate(sessionId: string, bitrate: number): void;
  desktopKeyframe(sessionId: string): void;
  desktopInput(event: string): void;
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

/** Desktop screen capture and WebRTC are only present in native builds that include them. */
export function loadDesktopNative(): NativeDesktop | undefined {
  const native = loadNative();
  if (!native || typeof native.desktopStatus !== 'function') return undefined;
  return native as NativeDesktop;
}
