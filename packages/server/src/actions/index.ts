import {
  connectPeerInput,
  forgetPeerInput,
  retryMessageInput,
  sendFileInput,
  sendMessageInput,
  transferIdInput,
  inputSettingsSchema,
  inputConnectSchema,
  inputConfirmSchema,
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

export const inputStatus = defineAction(async ({ app }) => app.input.status());
export const inputRefresh = defineAction(async ({ app }) => app.input.refresh());
export const inputPermissions = defineAction(async ({ app }) => app.input.permissions());
export const inputConfigure = defineAction(inputSettingsSchema, async ({ app }, settings) =>
  app.input.configure(settings),
);
export const inputEnable = defineAction(async ({ app }) => app.input.enable());
export const inputDisable = defineAction(async ({ app }) => app.input.disable());
export const inputPairing = defineAction(async ({ app }) => app.input.openPairing());
export const inputConnect = defineAction(inputConnectSchema, async ({ app }, { peerId }) =>
  app.input.connect(app.peerTarget(peerId)),
);
export const inputConfirm = defineAction(inputConfirmSchema, async ({ app }, { code }) =>
  app.input.confirm(code),
);
export const inputForget = defineAction(async ({ app }) => app.input.forget());

export const actions = {
  appState,
  sendMessage,
  retryMessage,
  connectPeer,
  forgetPeer,
  sendFile,
  cancelTransfer,
  openDownloads,
  inputStatus,
  inputRefresh,
  inputPermissions,
  inputConfigure,
  inputEnable,
  inputDisable,
  inputPairing,
  inputConnect,
  inputConfirm,
  inputForget,
} satisfies Record<string, ServerAction>;

export type ActionName = keyof typeof actions;
