import { describe, expect, it } from 'bun:test';

import { CapsLockPress } from '../../webui/src/service/caps-lock';

describe('remote desktop Caps Lock input-source actions', () => {
  it('sends one action per normal press/release pair', () => {
    const caps = new CapsLockPress();
    expect(caps.update(true, true, false)).toBe(true);
    expect(caps.update(false, true, false)).toBe(false);
    expect(caps.update(true, false, false)).toBe(true);
    expect(caps.update(false, false, false)).toBe(false);
  });

  it('handles macOS lock and unlock notifications as separate presses', () => {
    const caps = new CapsLockPress();
    expect(caps.update(true, true, false)).toBe(true);
    expect(caps.update(false, false, false)).toBe(true);
    expect(caps.update(true, true, false)).toBe(true);
  });

  it('handles source-switching presses that leave Caps Lock off', () => {
    const caps = new CapsLockPress();
    expect(caps.update(true, false, false)).toBe(true);
    expect(caps.update(true, false, true)).toBe(false);
    expect(caps.update(false, false, false)).toBe(false);
    expect(caps.update(true, false, false)).toBe(true);
  });

  it('accepts an initial unlock notification and clears state on release', () => {
    const caps = new CapsLockPress();
    expect(caps.update(false, false, false)).toBe(true);
    expect(caps.update(false, false, false)).toBe(false);
    caps.reset();
    expect(caps.update(true, true, false)).toBe(true);
  });
});
