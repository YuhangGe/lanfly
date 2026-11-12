import {
  connectPeerInput,
  forgetPeerInput,
  retryMessageInput,
  sendFileInput,
  sendMessageInput,
  transferIdInput,
  inputSettingsSchema,
  inputConnectSchema,
  desktopRequestInput,
  desktopDisplayInput,
  desktopAcceptInput,
  desktopRejectInput,
  desktopOfferInput,
  desktopIceInput,
  desktopBitrateInput,
  desktopKeyboardInput,
} from '@lanfly/common';

import { defineAction, type ServerAction } from '../core/action';
import { throwActionError } from '../core/errors';

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
export const inputEnable = defineAction(async ({ app }) => {
  if (app.desktop.hasActive()) throwActionError('INPUT_BUSY');
  return app.input.enable();
});
export const inputDisable = defineAction(async ({ app }) => app.input.disable());
export const inputConnect = defineAction(
  inputConnectSchema,
  async ({ app }, { peerId, role, edge }) => {
    if (app.desktop.hasActive()) throwActionError('INPUT_BUSY');
    return app.input.connect(app.peerTarget(peerId), { role, edge });
  },
);
export const inputForget = defineAction(async ({ app }) => app.input.forget());

export const desktopStatus = defineAction(async ({ app }) => app.desktop.status());
export const desktopPermissions = defineAction(async ({ app }) => app.desktop.permissions());
export const desktopState = defineAction(async ({ app }) => app.desktop.state(app.identity.id));
export const desktopDisplay = defineAction(desktopDisplayInput, async ({ app }, input) =>
  app.desktop.displayModes(input.peerId),
);
export const desktopRequest = defineAction(desktopRequestInput, async ({ app }, input) =>
  app.desktop.request(app.identity.id, input),
);
export const desktopAccept = defineAction(desktopAcceptInput, async ({ app }, input) =>
  app.desktop.accept(input.sessionId, input.control),
);
export const desktopReject = defineAction(desktopRejectInput, async ({ app }, input) =>
  app.desktop.reject(input.sessionId, input.reason),
);
export const desktopOffer = defineAction(desktopOfferInput, async ({ app }, input) =>
  app.desktop.offer(app.identity.id, input.sessionId, input.sdp),
);
export const desktopIce = defineAction(desktopIceInput, async ({ app }, input) =>
  app.desktop.ice(app.identity.id, input.sessionId, input.candidate),
);
export const desktopStop = defineAction(desktopRejectInput, async ({ app }, input) =>
  app.desktop.stopSession(app.identity.id, input.sessionId, input.reason),
);
export const desktopBitrate = defineAction(desktopBitrateInput, async ({ app }, input) =>
  app.desktop.setBitrate(app.identity.id, input.sessionId, input.bitrate),
);
export const desktopKeyboard = defineAction(desktopKeyboardInput, async ({ app }, input) =>
  app.desktop.keyboard(app.identity.id, input),
);

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
  inputConnect,
  inputForget,
  desktopStatus,
  desktopPermissions,
  desktopState,
  desktopRequest,
  desktopDisplay,
  desktopAccept,
  desktopReject,
  desktopOffer,
  desktopIce,
  desktopStop,
  desktopBitrate,
  desktopKeyboard,
} satisfies Record<string, ServerAction>;

export type ActionName = keyof typeof actions;
