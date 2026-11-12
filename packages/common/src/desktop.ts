import { z } from 'zod';

import { peerInfoSchema } from './schemas';

/** Desktop capture defaults. Frames are H.264 at 30 fps and capped at 1080p. */
export const DESKTOP_MAX_WIDTH = 3840;
export const DESKTOP_MAX_HEIGHT = 2160;
export const DESKTOP_FPS = 30;
export const DESKTOP_DEFAULT_BITRATE = 4_000_000;
export const DESKTOP_MIN_BITRATE = 500_000;
export const DESKTOP_MAX_BITRATE = 32_000_000;
export const DESKTOP_REQUEST_TTL_MS = 60_000;
export const DESKTOP_ACCEPT_TTL_MS = 45_000;
export const DESKTOP_EVENT = 'desktop';

export const desktopIceCandidateSchema = z.object({
  candidate: z.string().min(1).max(4096),
  sdpMid: z.string().max(256).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});
export type DesktopIceCandidate = z.infer<typeof desktopIceCandidateSchema>;

export type DesktopRole = 'controller' | 'controlled';
export type DesktopPhase =
  | 'pending'
  | 'accepted'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'stopped'
  | 'rejected'
  | 'failed';

export interface DesktopSessionView {
  sessionId: string;
  role: DesktopRole;
  peerId: string;
  peerName: string;
  phase: DesktopPhase;
  controlRequested: boolean;
  control: boolean;
  width: number;
  height: number;
  createdAt: number;
  expiresAt?: number;
  error?: string;
}

export interface DesktopDisplayView {
  id: number;
  width: number;
  height: number;
  scale: number;
  logicalWidth: number;
  logicalHeight: number;
  originX: number;
  originY: number;
}

export interface DesktopStatus {
  supported: boolean;
  available: boolean;
  screenRecording: boolean;
  accessibility: boolean;
  inputMonitoring?: boolean;
  screens: number;
  display?: DesktopDisplayView;
  session?: { id: string; width: number; height: number };
}

export interface DesktopOfferResult {
  sdp: string;
  width: number;
  height: number;
}

export type DesktopKeyboardEvent =
  | { t: 'key'; key: number; down: boolean; flags: number }
  | { t: 'source' }
  | { t: 'release' };
export interface DesktopKeyboardResult {
  supported: boolean;
  active: boolean;
  events: DesktopKeyboardEvent[];
}
export const desktopKeyboardInput = z.object({
  sessionId: z.string().min(1).max(64),
  clientId: z.string().uuid(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  active: z.boolean(),
});
export type DesktopKeyboardInput = z.infer<typeof desktopKeyboardInput>;

export type DesktopEvent =
  | { type: 'request'; session: DesktopSessionView }
  | { type: 'accepted'; session: DesktopSessionView }
  | { type: 'rejected'; session: DesktopSessionView; reason?: string }
  | { type: 'ice'; sessionId: string; candidate: DesktopIceCandidate }
  | {
      type: 'state';
      sessionId: string;
      phase: DesktopPhase;
      error?: string;
    }
  | { type: 'ended'; sessionId: string; reason?: string };

export const desktopResolutionSchema = z.object({
  width: z.number().int().min(640).max(7680),
  height: z.number().int().min(480).max(4320),
});
export type DesktopResolution = z.infer<typeof desktopResolutionSchema>;
export const desktopResolutionChoiceSchema = z.union([
  z.literal('keep'),
  z.literal('fit'),
  desktopResolutionSchema,
]);
export type DesktopResolutionChoice = z.infer<typeof desktopResolutionChoiceSchema>;
export const desktopResolutionPreferenceSchema = z.object({
  controller: z.string().min(1).max(256),
  controlled: z.string().min(1).max(256),
  choice: desktopResolutionChoiceSchema,
});
export type DesktopResolutionPreference = z.infer<typeof desktopResolutionPreferenceSchema>;
export const desktopDisplayModeSchema = desktopResolutionSchema.extend({
  pixelWidth: z.number().int().min(1).max(32768).optional(),
  pixelHeight: z.number().int().min(1).max(32768).optional(),
});
export const desktopDisplayModesSchema = z.object({
  supported: z.boolean(),
  current: desktopDisplayModeSchema.optional(),
  modes: z.array(desktopDisplayModeSchema).max(256),
});
export type DesktopDisplayModes = z.infer<typeof desktopDisplayModesSchema>;
export const desktopDisplayInput = z.object({ peerId: z.string().min(1).max(64) });
export const desktopPeerDisplaySchema = z.object({ from: peerInfoSchema });

/** Match controller screen pixels against each remote mode's backing pixels. */
export function fitDesktopResolution(
  info: DesktopDisplayModes,
  width: number,
  height: number,
): DesktopResolution | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const aspect = info.current ? info.current.width / info.current.height : width / height;
  const modes = info.modes.filter(
    (mode) => Math.abs(Math.log(mode.width / mode.height / aspect)) < 0.05,
  );
  const candidates = modes.length ? modes : info.modes;
  const pixelWidth = (mode: DesktopDisplayModes['modes'][number]) => mode.pixelWidth ?? mode.width;
  const pixelHeight = (mode: DesktopDisplayModes['modes'][number]) =>
    mode.pixelHeight ?? mode.height;
  const area = (mode: DesktopDisplayModes['modes'][number]) => pixelWidth(mode) * pixelHeight(mode);
  const fits = candidates.filter(
    (mode) => pixelWidth(mode) <= width && pixelHeight(mode) <= height,
  );
  const mode = [...(fits.length ? fits : candidates)].sort((a, b) =>
    fits.length ? area(b) - area(a) : area(a) - area(b),
  )[0];
  return mode ? { width: mode.width, height: mode.height } : undefined;
}

export const desktopRequestInput = z.object({
  resolutionChoice: desktopResolutionChoiceSchema.optional(),
  resolution: desktopResolutionSchema.optional(),
  peerId: z.string().min(1).max(64),
  bitrate: z.number().int().min(DESKTOP_MIN_BITRATE).max(DESKTOP_MAX_BITRATE).optional(),
});

export const desktopAcceptInput = z.object({
  sessionId: z.string().min(1).max(64),
  control: z.boolean().default(false),
});

export const desktopSessionInput = z.object({
  sessionId: z.string().min(1).max(64),
});

export const desktopRejectInput = desktopSessionInput.extend({
  reason: z.string().max(128).optional(),
});

export const desktopOfferInput = z.object({
  sessionId: z.string().min(1).max(64),
  sdp: z
    .string()
    .min(2)
    .max(512 * 1024),
});

export const desktopIceInput = z.object({
  sessionId: z.string().min(1).max(64),
  candidate: desktopIceCandidateSchema,
});

export const desktopBitrateInput = z.object({
  sessionId: z.string().min(1).max(64),
  bitrate: z.number().int().min(DESKTOP_MIN_BITRATE).max(DESKTOP_MAX_BITRATE),
});

export type DesktopRequestInput = z.output<typeof desktopRequestInput>;
export type DesktopAcceptInput = z.output<typeof desktopAcceptInput>;

/** Peer-to-peer signaling payloads. Room headers bind the sender; the token binds the session. */
export const desktopPeerRequestSchema = z.object({
  resolution: desktopResolutionSchema.optional(),
  sessionId: z.string().min(1).max(64),
  from: peerInfoSchema,
  // Kept optional for wire compatibility. Remote control is always enabled for desktop
  // sessions; the target no longer has a separate approval step.
  control: z.boolean().optional(),
  viewer: z.string().min(1).max(64).optional(),
  bitrate: z.number().int().min(DESKTOP_MIN_BITRATE).max(DESKTOP_MAX_BITRATE).optional(),
});

export const desktopPeerAcceptSchema = z.object({
  sessionId: z.string().min(1).max(64),
  from: peerInfoSchema,
  token: z.string().min(32).max(128),
  control: z.boolean(),
  width: z.number().int().min(1).max(16384),
  height: z.number().int().min(1).max(16384),
});

export const desktopPeerRejectSchema = z.object({
  sessionId: z.string().min(1).max(64),
  from: peerInfoSchema,
  reason: z.string().max(128).optional(),
});

export const desktopPeerOfferSchema = z.object({
  sessionId: z.string().min(1).max(64),
  from: peerInfoSchema,
  sdp: z
    .string()
    .min(2)
    .max(512 * 1024),
});

export const desktopPeerIceSchema = z.object({
  sessionId: z.string().min(1).max(64),
  from: peerInfoSchema,
  candidate: desktopIceCandidateSchema,
});

export const desktopPeerStopSchema = z.object({
  sessionId: z.string().min(1).max(64),
  from: peerInfoSchema,
  reason: z.string().max(128).optional(),
});

export const desktopPeerStateSchema = z.object({
  sessionId: z.string().min(1).max(64),
  from: peerInfoSchema,
  phase: z.enum(['connected', 'disconnected', 'failed']),
  error: z.string().max(128).optional(),
});

export const desktopPeerErrorSchema = z.object({
  sessionId: z.string().min(1).max(64),
  from: peerInfoSchema,
  error: z.string().min(1).max(128),
});

/** Automatic acceptance returned by the controlled host. The token never reaches the browser. */
export const desktopRequestResponseSchema = z.object({
  accepted: z.literal(true),
  from: peerInfoSchema,
  token: z.string().min(32).max(128),
  control: z.boolean(),
  width: z.number().int().min(0).max(16384),
  height: z.number().int().min(0).max(16384),
  screenRecording: z.boolean(),
});
export type DesktopRequestResponse = z.infer<typeof desktopRequestResponseSchema>;

export type DesktopPeerRequest = z.infer<typeof desktopPeerRequestSchema>;
export type DesktopPeerAccept = z.infer<typeof desktopPeerAcceptSchema>;
export type DesktopPeerOffer = z.infer<typeof desktopPeerOfferSchema>;
export type DesktopPeerIce = z.infer<typeof desktopPeerIceSchema>;
export type DesktopPeerStop = z.infer<typeof desktopPeerStopSchema>;
