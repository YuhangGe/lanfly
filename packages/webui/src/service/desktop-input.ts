import { CapsLockPress } from './caps-lock';

/** macOS virtual key codes for KeyboardEvent.code. */
const MAC_KEY_CODES: Record<string, number> = {
  Escape: 53,
  Backquote: 50,
  Digit1: 18,
  Digit2: 19,
  Digit3: 20,
  Digit4: 21,
  Digit5: 23,
  Digit6: 22,
  Digit7: 26,
  Digit8: 28,
  Digit9: 25,
  Digit0: 29,
  Minus: 27,
  Equal: 24,
  Backspace: 51,
  Tab: 48,
  KeyQ: 12,
  KeyW: 13,
  KeyE: 14,
  KeyR: 15,
  KeyT: 17,
  KeyY: 16,
  KeyU: 32,
  KeyI: 34,
  KeyO: 31,
  KeyP: 35,
  BracketLeft: 33,
  BracketRight: 30,
  Backslash: 42,
  CapsLock: 57,
  KeyA: 0,
  KeyS: 1,
  KeyD: 2,
  KeyF: 3,
  KeyG: 5,
  KeyH: 4,
  KeyJ: 38,
  KeyK: 40,
  KeyL: 37,
  Semicolon: 41,
  Quote: 39,
  Enter: 36,
  ShiftLeft: 56,
  KeyZ: 6,
  KeyX: 7,
  KeyC: 8,
  KeyV: 9,
  KeyB: 11,
  KeyN: 45,
  KeyM: 46,
  Comma: 43,
  Period: 47,
  Slash: 44,
  ShiftRight: 60,
  ControlLeft: 59,
  AltLeft: 58,
  MetaLeft: 55,
  Space: 49,
  MetaRight: 54,
  AltRight: 61,
  ControlRight: 62,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
  Insert: 114,
  Home: 115,
  PageUp: 116,
  Delete: 117,
  End: 119,
  PageDown: 121,
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
  Numpad0: 82,
  Numpad1: 83,
  Numpad2: 84,
  Numpad3: 85,
  Numpad4: 86,
  Numpad5: 87,
  Numpad6: 88,
  Numpad7: 89,
  Numpad8: 91,
  Numpad9: 92,
  NumpadMultiply: 67,
  NumpadAdd: 69,
  NumpadSubtract: 78,
  NumpadDecimal: 65,
  NumpadDivide: 75,
  NumpadEnter: 76,
  IntlBackslash: 10,
  PrintScreen: 105,
  ScrollLock: 107,
  Pause: 113,
  ContextMenu: 110,
};

const FLAG_SHIFT = 1 << 17;
const FLAG_CONTROL = 1 << 18;
const FLAG_OPTION = 1 << 19;
const FLAG_COMMAND = 1 << 20;
const FLAG_CAPS_LOCK = 1 << 16;

export function macKeyCode(code: string): number | undefined {
  return MAC_KEY_CODES[code];
}

export function keyboardFlags(event: KeyboardEvent): number {
  let flags = 0;
  if (event.shiftKey) flags |= FLAG_SHIFT;
  if (event.ctrlKey) flags |= FLAG_CONTROL;
  if (event.altKey) flags |= FLAG_OPTION;
  if (event.metaKey) flags |= FLAG_COMMAND;
  if (event.getModifierState?.('CapsLock')) flags |= FLAG_CAPS_LOCK;
  return flags;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Captures pointer and keyboard input over the video and forwards normalized events over the
 * authorized WebRTC data channel. Letterboxing, CSS scaling and devicePixelRatio are handled
 * by measuring the rendered video rect; the controlled host maps 0..1 onto its real display.
 */
export class DesktopControl {
  #cleanup: Array<() => void> = [];
  #buttons = new Set<number>();
  #lastClickAt = 0;
  #lastClickButton = -1;
  #clickCount = 1;
  #frame = 0;
  #pending: Point | null = null;
  #attached = false;
  #capsPress = new CapsLockPress();
  #keyboardLocked = false;

  constructor(
    private readonly stage: HTMLElement,
    private readonly video: HTMLVideoElement,
    private readonly send: (payload: unknown) => void,
  ) {}

  attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    this.#listen(this.stage, 'pointerdown', (event) => this.#pointerDown(event as PointerEvent));
    this.#listen(this.stage, 'pointermove', (event) => this.#pointerMove(event as PointerEvent));
    this.#listen(this.stage, 'pointerup', (event) => this.#pointerUp(event as PointerEvent));
    this.#listen(this.stage, 'pointercancel', (event) => this.#pointerUp(event as PointerEvent));
    this.#listen(this.stage, 'wheel', (event) => this.#wheel(event as WheelEvent), {
      passive: false,
    });
    this.#listen(this.stage, 'contextmenu', (event) => event.preventDefault());
    this.#listen(this.stage, 'keydown', (event) => this.#key(event as KeyboardEvent, true));
    this.#listen(this.stage, 'keyup', (event) => this.#key(event as KeyboardEvent, false));
    // Capture only while the remote stage owns focus. DOM cancellation does not
    // guarantee suppression of macOS's own input-source shortcut.
    this.#listen(window, 'keydown', (event) => this.#caps(event as KeyboardEvent, true), {
      capture: true,
    });
    this.#listen(window, 'keyup', (event) => this.#caps(event as KeyboardEvent, false), {
      capture: true,
    });
    this.#listen(this.stage, 'blur', () => this.release());
    const visibility = () => {
      if (document.visibilityState === 'hidden') this.release();
    };
    const windowBlur = () => this.release();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', windowBlur);
    this.#cleanup.push(() => document.removeEventListener('visibilitychange', visibility));
    this.#cleanup.push(() => window.removeEventListener('blur', windowBlur));
  }

  detach(): void {
    this.release();
    this.#unlockKeyboard();
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#pending = null;
    for (const cleanup of this.#cleanup.splice(0)) cleanup();
    this.#attached = false;
  }

  release(): void {
    this.#buttons.clear();
    this.#capsPress.reset();
    this.#send({ t: 'release' });
    this.#unlockKeyboard();
  }

  async lockKeyboard(): Promise<void> {
    const keyboard = (
      navigator as Navigator & {
        keyboard?: { lock?: () => Promise<void>; unlock?: () => void };
      }
    ).keyboard;
    if (!keyboard?.lock || this.#keyboardLocked) return;
    try {
      // Keyboard Lock lets the page receive browser-reserved shortcuts such as Cmd+N/T/W
      // while the remote desktop view owns the keyboard.
      await keyboard.lock();
      this.#keyboardLocked = true;
    } catch {
      // Not available outside a supported user gesture/fullscreen context.
    }
  }

  #unlockKeyboard(): void {
    if (!this.#keyboardLocked) return;
    this.#keyboardLocked = false;
    (
      navigator as Navigator & {
        keyboard?: { unlock?: () => void };
      }
    ).keyboard?.unlock?.();
  }

  #caps(event: KeyboardEvent, down: boolean): void {
    if (event.code !== 'CapsLock' || !this.stage.contains(document.activeElement)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.#capsPress.update(down, event.getModifierState('CapsLock'), event.repeat)) {
      this.switchInputSource();
    }
  }

  switchInputSource(): void {
    if (this.#attached) this.#send({ t: 'source' });
  }

  #listen(
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    this.#cleanup.push(() => target.removeEventListener(type, listener, options));
  }

  #send(payload: unknown): void {
    try {
      this.send(payload);
    } catch {
      // The peer connection may have closed between the event and this write.
    }
  }

  #point(clientX: number, clientY: number): Point | null {
    const rect = this.video.getBoundingClientRect();
    const videoWidth = this.video.videoWidth;
    const videoHeight = this.video.videoHeight;
    if (!videoWidth || !videoHeight || rect.width <= 0 || rect.height <= 0) return null;
    const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
    const width = videoWidth * scale;
    const height = videoHeight * scale;
    const offsetX = (rect.width - width) / 2;
    const offsetY = (rect.height - height) / 2;
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left - offsetX) / width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top - offsetY) / height)),
    };
  }

  #pointerDown(event: PointerEvent): void {
    if (event.button > 2) return;
    void this.lockKeyboard();
    this.stage.focus({ preventScroll: true });
    try {
      this.stage.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional; synthetic events and some browsers reject it.
    }
    const point = this.#point(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    const now = Date.now();
    if (now - this.#lastClickAt < 400 && this.#lastClickButton === event.button) {
      this.#clickCount = Math.min(3, this.#clickCount + 1);
    } else {
      this.#clickCount = 1;
    }
    this.#lastClickAt = now;
    this.#lastClickButton = event.button;
    this.#buttons.add(event.button);
    this.#send({
      t: 'button',
      button: event.button,
      down: true,
      clicks: this.#clickCount,
      ...point,
    });
  }

  #pointerMove(event: PointerEvent): void {
    const point = this.#point(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    if (this.#buttons.size) {
      const drag = Math.min(...this.#buttons) + 1;
      this.#send({ t: 'move', ...point, drag });
      return;
    }
    this.#pending = point;
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      const pending = this.#pending;
      this.#pending = null;
      if (pending) this.#send({ t: 'move', ...pending });
    });
  }

  #pointerUp(event: PointerEvent): void {
    if (!this.#buttons.has(event.button)) return;
    const point = this.#point(event.clientX, event.clientY) ?? { x: 0.5, y: 0.5 };
    event.preventDefault();
    this.#buttons.delete(event.button);
    try {
      this.stage.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    this.#send({ t: 'button', button: event.button, down: false, clicks: 0, ...point });
  }

  #wheel(event: WheelEvent): void {
    const point = this.#point(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    this.#send({
      t: 'wheel',
      ...point,
      dx: Math.max(-1000, Math.min(1000, event.deltaX)),
      dy: Math.max(-1000, Math.min(1000, event.deltaY)),
    });
  }

  #key(event: KeyboardEvent, down: boolean): void {
    if (event.code === 'CapsLock') {
      this.#caps(event, down);
      return;
    }
    const key = macKeyCode(event.code);
    if (key === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.#send({ t: 'key', key, down, flags: keyboardFlags(event) });
  }
}
