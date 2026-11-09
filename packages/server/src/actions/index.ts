import {
  connectPeerInput,
  forgetPeerInput,
  retryMessageInput,
  sendFileInput,
  sendMessageInput,
  transferIdInput,
} from '@lanfly/common';

import { defineAction, type ServerAction } from '../core/action';

export const appState = defineAction(async (context) => context.app.getState());

export const sendMessage = defineAction(sendMessageInput, async (context, input) =>
  context.app.sendMessage(input),
);

export const retryMessage = defineAction(retryMessageInput, async (context, input) =>
  context.app.retryMessage(input),
);

export const connectPeer = defineAction(connectPeerInput, async (context, input) =>
  context.app.connectPeer(input),
);

export const forgetPeer = defineAction(forgetPeerInput, async (context, input) => {
  context.app.forgetPeer(input);
});

export const sendFile = defineAction(sendFileInput, async (context, input) =>
  context.app.sendFile(input),
);

export const cancelTransfer = defineAction(transferIdInput, async (context, input) =>
  context.app.cancelTransfer(input),
);

export const openDownloads = defineAction(async (context) => context.app.openDownloads());

export const actions = {
  appState,
  sendMessage,
  retryMessage,
  connectPeer,
  forgetPeer,
  sendFile,
  cancelTransfer,
  openDownloads,
} satisfies Record<string, ServerAction>;

export type ActionName = keyof typeof actions;
