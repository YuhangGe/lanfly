import type { DesktopEvent } from '@lanfly/common';

type Listener = (event: DesktopEvent) => void;

const listeners = new Set<Listener>();

export function onDesktopEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitDesktopEvent(event: DesktopEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error(error);
    }
  }
}
