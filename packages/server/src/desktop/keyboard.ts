import type { DesktopKeyboardInput, DesktopKeyboardResult } from '@lanfly/common';

import type { NativeDesktop } from '../input/native';

/** One focused page owns the native keyboard. Revisions fence late HTTP requests. */
export class DesktopKeyboardCapture {
  #fences = new Map<string, { revision: number; active: boolean }>();
  #owner?: { sessionId: string; clientId: string };

  constructor(private readonly native: () => NativeDesktop | undefined) {}

  poll(input: DesktopKeyboardInput): DesktopKeyboardResult {
    const empty: DesktopKeyboardResult = { supported: true, active: false, events: [] };
    const native = this.native();
    if (
      !native?.desktopKeyboardStart ||
      !native.desktopKeyboardPoll ||
      !native.desktopKeyboardStop
    ) {
      return { ...empty, supported: false };
    }
    const previous = this.#fences.get(input.clientId);
    if (!previous && this.#fences.size >= 128) {
      if (!input.active) return empty;
      throw new Error('DESKTOP_STATE');
    }
    if (previous && input.revision < previous.revision) return empty;
    const sameOwner =
      this.#owner?.clientId === input.clientId && this.#owner.sessionId === input.sessionId;
    if (!input.active) {
      this.#fences.set(input.clientId, { revision: input.revision, active: false });
      if (sameOwner) this.stop();
      return empty;
    }
    if (previous && input.revision === previous.revision && (!previous.active || !sameOwner))
      return empty;
    if (!sameOwner || !previous || input.revision > previous.revision) {
      this.stop();
      this.#fences.set(input.clientId, { revision: input.revision, active: false });
      native.desktopKeyboardStart();
      this.#owner = { sessionId: input.sessionId, clientId: input.clientId };
      this.#fences.set(input.clientId, { revision: input.revision, active: true });
    }
    try {
      const result = JSON.parse(native.desktopKeyboardPoll()) as Omit<
        DesktopKeyboardResult,
        'supported'
      >;
      if (!result.active) this.stop();
      return { supported: true, active: result.active, events: result.events };
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(sessionId?: string): void {
    if (!this.#owner || (sessionId && this.#owner.sessionId !== sessionId)) return;
    const fence = this.#fences.get(this.#owner.clientId);
    if (fence) fence.active = false;
    this.#owner = undefined;
    this.native()?.desktopKeyboardStop?.();
  }

  finish(sessionId: string): void {
    this.stop(sessionId);
    if (!this.#owner) this.#fences.clear();
  }
}
