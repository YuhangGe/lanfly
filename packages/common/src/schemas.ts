import { z } from 'zod';

import {
  DEFAULT_MIME,
  MAX_FILE_NAME_LENGTH,
  MAX_FILE_SIZE,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
} from './constants';

const idSchema = z.string().min(1).max(64);
const nameSchema = z.string().min(1).max(MAX_NAME_LENGTH);
const versionSchema = z.string().min(1).max(32);

export const peerInfoSchema = z.object({
  id: idSchema,
  name: nameSchema,
  port: z.number().int().min(1).max(65535),
  version: versionSchema,
  roomId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

export const fileMetaSchema = z.object({
  name: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  size: z.number().int().min(0).max(MAX_FILE_SIZE),
  mime: z.string().max(255).default(DEFAULT_MIME),
});

export const sendMessageInput = z.object({
  peerId: idSchema,
  text: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
});

export const connectPeerInput = z.object({
  address: z.string().trim().min(1).max(255),
});

export const forgetPeerInput = z.object({
  peerId: idSchema,
});

export const sendFileInput = z.object({
  peerId: idSchema,
  file: fileMetaSchema,
});

export const transferIdInput = z.object({
  transferId: idSchema,
});

export const retryMessageInput = z.object({
  messageId: idSchema,
});

export const peerMessageSchema = z.object({
  id: idSchema,
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  sentAt: z.number().int().nonnegative(),
  from: peerInfoSchema,
});

export const transferOfferSchema = z.object({
  transferId: idSchema,
  file: fileMetaSchema,
  from: peerInfoSchema,
});

export const helloRequestSchema = z.object({
  from: peerInfoSchema,
});

export type SendMessageInput = z.input<typeof sendMessageInput>;
export type ConnectPeerInput = z.input<typeof connectPeerInput>;
export type ForgetPeerInput = z.input<typeof forgetPeerInput>;
export type SendFileInput = z.input<typeof sendFileInput>;
export type TransferIdInput = z.input<typeof transferIdInput>;
export type RetryMessageInput = z.input<typeof retryMessageInput>;
export type PeerMessagePayload = z.output<typeof peerMessageSchema>;
export type TransferOfferPayload = z.output<typeof transferOfferSchema>;
