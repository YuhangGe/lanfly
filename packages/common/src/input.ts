import { z } from 'zod';

export const inputSettingsSchema = z.object({
  role: z.enum(['server', 'client']),
  edge: z.enum(['left', 'right', 'top', 'bottom']),
});
export const inputConnectSchema = z.object({ peerId: z.string().min(1).max(64) });
export const inputConfirmSchema = z.object({ code: z.string().regex(/^\d{8}$/) });
export type InputSettings = z.infer<typeof inputSettingsSchema>;
export type InputEdge = InputSettings['edge'];

export interface InputStatus {
  supported: boolean;
  available: boolean;
  accessibility: boolean;
  inputMonitoring: boolean;
  screens: number;
  settings: InputSettings;
  enabled: boolean;
  phase: 'disabled' | 'waiting' | 'connecting' | 'pairing' | 'connected';
  controlling: boolean;
  peerName?: string;
  pairedName?: string;
  pairingCode?: string;
  confirmed: boolean;
  pairingUntil?: number;
  error?: string;
}
