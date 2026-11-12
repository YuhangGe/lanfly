import type * as ServerActions from '@server';

import { rootProxy } from './core';

/**
 * 仅供 Vite 开发期依赖扫描和插件未命中时兜底：真正的构建产物中
 * `@server` 导入会被 lanfly-server-action 插件替换为运行时 RPC 代理。
 */
export const appState = rootProxy.appState as unknown as typeof ServerActions.appState;
export const sendMessage = rootProxy.sendMessage as unknown as typeof ServerActions.sendMessage;
export const retryMessage = rootProxy.retryMessage as unknown as typeof ServerActions.retryMessage;
export const connectPeer = rootProxy.connectPeer as unknown as typeof ServerActions.connectPeer;
export const forgetPeer = rootProxy.forgetPeer as unknown as typeof ServerActions.forgetPeer;
export const sendFile = rootProxy.sendFile as unknown as typeof ServerActions.sendFile;
export const cancelTransfer =
  rootProxy.cancelTransfer as unknown as typeof ServerActions.cancelTransfer;
export const openDownloads =
  rootProxy.openDownloads as unknown as typeof ServerActions.openDownloads;
export const inputStatus = rootProxy.inputStatus as unknown as typeof ServerActions.inputStatus;
export const inputRefresh = rootProxy.inputRefresh as unknown as typeof ServerActions.inputRefresh;
export const inputPermissions =
  rootProxy.inputPermissions as unknown as typeof ServerActions.inputPermissions;
export const inputConfigure =
  rootProxy.inputConfigure as unknown as typeof ServerActions.inputConfigure;
export const inputEnable = rootProxy.inputEnable as unknown as typeof ServerActions.inputEnable;
export const inputDisable = rootProxy.inputDisable as unknown as typeof ServerActions.inputDisable;
export const inputConnect = rootProxy.inputConnect as unknown as typeof ServerActions.inputConnect;
export const inputForget = rootProxy.inputForget as unknown as typeof ServerActions.inputForget;
export const desktopStatus =
  rootProxy.desktopStatus as unknown as typeof ServerActions.desktopStatus;
export const desktopPermissions =
  rootProxy.desktopPermissions as unknown as typeof ServerActions.desktopPermissions;
export const desktopState = rootProxy.desktopState as unknown as typeof ServerActions.desktopState;
export const desktopRequest =
  rootProxy.desktopRequest as unknown as typeof ServerActions.desktopRequest;
export const desktopAccept =
  rootProxy.desktopAccept as unknown as typeof ServerActions.desktopAccept;
export const desktopReject =
  rootProxy.desktopReject as unknown as typeof ServerActions.desktopReject;
export const desktopOffer = rootProxy.desktopOffer as unknown as typeof ServerActions.desktopOffer;
export const desktopIce = rootProxy.desktopIce as unknown as typeof ServerActions.desktopIce;
export const desktopStop = rootProxy.desktopStop as unknown as typeof ServerActions.desktopStop;
export const desktopBitrate =
  rootProxy.desktopBitrate as unknown as typeof ServerActions.desktopBitrate;
export const desktopKeyboard =
  rootProxy.desktopKeyboard as unknown as typeof ServerActions.desktopKeyboard;

export const desktopDisplay =
  rootProxy.desktopDisplay as unknown as typeof ServerActions.desktopDisplay;
