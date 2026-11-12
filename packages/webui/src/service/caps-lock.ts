/** macOS can expose Caps as alternating keydown/keyup lock-state notifications.
 * Other platforms send a conventional down/up pair for each physical press. */
export class CapsLockPress {
  #down = false;
  #locked: boolean | undefined;

  update(down: boolean, locked: boolean, repeat: boolean): boolean {
    const previous = this.#locked;
    const changed = previous !== undefined && previous !== locked;
    const pressed =
      !repeat && (changed || (down && !this.#down) || (!down && previous === undefined));
    this.#down = down;
    this.#locked = locked;
    return pressed;
  }

  reset(): void {
    this.#down = false;
    this.#locked = undefined;
  }
}
