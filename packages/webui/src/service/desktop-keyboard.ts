import type {
  DesktopKeyboardEvent,
  DesktopKeyboardInput,
  DesktopKeyboardResult,
} from '@lanfly/common';

export type KeyboardRequest = (
  input: Omit<DesktopKeyboardInput, 'sessionId'>,
) => Promise<DesktopKeyboardResult>;

/** The page controls the lease; the native tap supplies one ordered keyboard stream. */
export class NativeDesktopKeyboard {
  #clientId = crypto.randomUUID();
  #revision = 0;
  #wanted = false;
  #supported = true;
  #confirmed = 0;
  #timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly request: KeyboardRequest,
    private readonly events: (events: DesktopKeyboardEvent[]) => void,
    private readonly stopped: () => void,
    private readonly error: (error: unknown) => void,
  ) {}

  get ownsKeyboard(): boolean {
    return this.#wanted && this.#supported;
  }

  focus(): void {
    if (this.#wanted || !this.#supported) return;
    this.#wanted = true;
    const revision = ++this.#revision;
    void this.#poll(revision);
  }

  blur(): void {
    if (!this.#wanted) return;
    this.#wanted = false;
    clearTimeout(this.#timer);
    const revision = ++this.#revision;
    void this.request({ clientId: this.#clientId, revision, active: false }).catch(() => undefined);
  }

  async #poll(revision: number): Promise<void> {
    if (!this.#wanted || revision !== this.#revision) return;
    try {
      const result = await this.request({ clientId: this.#clientId, revision, active: true });
      if (!this.#wanted || revision !== this.#revision) return;
      if (!result.supported) {
        this.#supported = false;
        this.#wanted = false;
        return;
      }
      if (result.events.length) this.events(result.events);
      if (!result.active) {
        this.#wanted = false;
        this.stopped();
        return;
      }
      if (this.#confirmed !== revision) {
        this.#confirmed = revision;
        this.error(null);
      }
      this.#timer = setTimeout(() => void this.#poll(revision), 8);
    } catch (error) {
      if (revision !== this.#revision) return;
      this.blur();
      this.events([{ t: 'release' }]);
      this.stopped();
      this.error(error);
    }
  }
}
