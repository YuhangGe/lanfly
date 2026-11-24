import { desktopPeerRequestSchema, desktopRequestInput } from '@lanfly/common';
import { describe, expect, it } from 'bun:test';

import { configureDesktopReceiver } from '../../webui/src/service/desktop-video';

describe('interactive desktop video', () => {
  it('accepts the selectable frame rates without accepting unbounded encoder work', () => {
    for (const fps of [30, 60] as const) {
      expect(desktopRequestInput.parse({ peerId: 'peer', fps }).fps).toBe(fps);
      expect(desktopPeerRequestSchema.shape.fps.parse(fps)).toBe(fps);
    }
    for (const fps of [0, 59, 120, '60']) {
      expect(desktopRequestInput.safeParse({ peerId: 'peer', fps }).success).toBe(false);
    }
    expect(desktopRequestInput.parse({ peerId: 'peer' }).fps).toBeUndefined();
  });

  it('keeps video setup working when an optional browser hint rejects writes', () => {
    const receiver = {
      get jitterBufferTarget() {
        return null;
      },
      set jitterBufferTarget(_value: number | null) {
        throw new Error('unsupported');
      },
      playoutDelayHint: null as number | null,
    };
    expect(() => configureDesktopReceiver(receiver as unknown as RTCRtpReceiver)).not.toThrow();
    expect(receiver.playoutDelayHint).toBe(0);
    expect(() => configureDesktopReceiver({} as RTCRtpReceiver)).not.toThrow();
  });
});
