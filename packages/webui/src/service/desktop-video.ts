/** Ask for interactive playout; browsers may retain their network-dependent minimum. */
export function configureDesktopReceiver(receiver: RTCRtpReceiver): void {
  const interactive = receiver as RTCRtpReceiver & {
    jitterBufferTarget?: number | null;
    playoutDelayHint?: number | null;
  };
  // These are independent optional APIs. A rejected hint must not abort video setup.
  for (const property of ['jitterBufferTarget', 'playoutDelayHint'] as const) {
    if (!(property in interactive)) continue;
    try {
      interactive[property] = 0;
    } catch {
      // Older browsers can expose an unsupported or read-only property.
    }
  }
}
