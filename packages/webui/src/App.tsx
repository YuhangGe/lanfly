import type {
  ActionResultError,
  FileUploadRequest,
  AppState,
  ChatMessage,
  DesktopEvent,
  MessageStatus,
  PeerView,
  SelfInfo,
  TransferView,
} from '@lanfly/common';

import {
  appState,
  cancelTransfer,
  connectPeer,
  desktopState,
  desktopStop,
  forgetPeer,
  openDownloads,
  retryMessage,
  sendFile,
  sendMessage,
} from '@server';
import { nextTick, onMount, ref, t, vm, watch } from 'jinge';

import type { Toast, UiMessage } from './types';

import AddPeerDialog from './components/AddPeerDialog';
import Avatar from './components/Avatar';
import Button from './components/Button';
import Dialog, { DialogActions } from './components/Dialog';
import InputSharingDialog from './components/InputSharingDialog';
import LanguageSwitcher from './components/LanguageSwitcher';
import MessageItem from './components/MessageItem';
import PeerList from './components/PeerList';
import RemoteDesktopDialog from './components/RemoteDesktopDialog';
import Toasts from './components/Toasts';
import Tooltip from './components/Tooltip';
import { ActionError } from './service/action';
import { browserMode, browserName, eventPath, joinBrowser, renameBrowser } from './service/browser';
import { DeferredFiles } from './service/deferred-files';
import { emitDesktopEvent } from './service/desktop';

const EMPTY_SELF: SelfInfo = {
  id: '',
  name: 'lanfly',
  port: 0,
  version: '',
  roomId: '',
  host: '',
  url: '',
  downloadsDir: '',
};

const EMPTY_PEER: PeerView = {
  id: '',
  name: '',
  port: 0,
  version: '',
  roomId: '',
  host: '',
  lastSeen: 0,
  online: false,
  manual: false,
};

function errorText(error: ActionResultError | null): string {
  return error ? new ActionError(error).message : '';
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export default function App() {
  const model = vm({
    loading: true,
    joinOpen: false,
    joinBusy: false,
    joinError: '',
    browserName: browserName(),
    renaming: false,
    connected: false,
    self: EMPTY_SELF,
    peers: [] as PeerView[],
    onlineCount: 0,
    messages: [] as ChatMessage[],
    transfers: {} as Record<string, TransferView>,
    activePeerId: '',
    activePeer: EMPTY_PEER,
    activeMessages: [] as UiMessage[],
    draft: '',
    unread: {} as Record<string, number>,
    dragging: false,
    addOpen: false,
    inputOpen: false,
    desktopOpen: false,
    desktopMinimized: false,
    desktopPeerId: '',
    desktopSessionId: '',
    desktopSharingId: '',
    desktopSwitch: null as {
      peerId: string;
      sessionId: string;
      currentName: string;
      nextName: string;
    } | null,
    addAddress: '',
    addBusy: false,
    addError: '',
    toasts: [] as Toast[],
  });

  const chatScroll = ref<HTMLDivElement>();
  const composer = ref<HTMLTextAreaElement>();
  const fileInput = ref<HTMLInputElement>();

  let eventSource: EventSource | undefined;
  let reconnectTimer: number | undefined;
  let disposed = false;
  let toastSequence = 0;
  const toastTimers = new Set<number>();
  const completedToasts = new Set<string>();
  const failedToasts = new Set<string>();
  const drafts = new Map<string, string>();
  const deferredFiles = new DeferredFiles((file) =>
    pushToast(
      t('文件 {name} 发送失败，请保持页面打开后重试', { name: truncate(file.name, 40) }),
      'error',
    ),
  );
  let autoSelectFirstPeer = true;

  function pushToast(text: string, kind: Toast['kind'] = 'info') {
    const id = (toastSequence += 1);
    model.toasts = [...model.toasts, { id, text, kind }];
    const timer = window.setTimeout(
      () => {
        model.toasts = model.toasts.filter((toast) => toast.id !== id);
        toastTimers.delete(timer);
      },
      kind === 'error' ? 6_000 : 3_600,
    );
    toastTimers.add(timer);
  }

  function dismissToast(id: number) {
    model.toasts = model.toasts.filter((toast) => toast.id !== id);
  }

  function updateTitle() {
    const total = Object.values(model.unread).reduce((sum, value) => sum + value, 0);
    const title = t('LanFly - 局域网聊天、文件互传、键鼠共享和远程桌面');
    document.title = total > 0 ? `(${total}) ${title}` : title;
  }

  function pruneUnread() {
    const valid = new Set(model.peers.map((peer) => peer.id));
    const next: Record<string, number> = {};
    for (const [id, count] of Object.entries(model.unread)) {
      if (valid.has(id) && count > 0) next[id] = count;
    }
    model.unread = next;
  }

  function refreshActiveMessages() {
    if (!model.activePeerId) {
      model.activeMessages = [];
      return;
    }
    const peerId = model.activePeerId;
    model.activeMessages = model.messages
      .filter((message) => message.peerId === peerId)
      .map((message) => ({
        ...message,
        transfer: message.transferId ? model.transfers[message.transferId] : undefined,
      }));
  }

  function syncActivePeer() {
    const peer =
      model.peers.find((item) => item.id === model.activePeerId) ??
      (autoSelectFirstPeer ? model.peers[0] : undefined);
    if (peer && peer.id !== model.activePeerId) {
      selectPeer(peer.id, false);
      return;
    }
    if (!peer) {
      if (model.activePeerId) drafts.set(model.activePeerId, model.draft);
      model.activePeerId = '';
      model.draft = '';
      model.activePeer = EMPTY_PEER;
      model.activeMessages = [];
      return;
    }
    model.activePeer = peer;
    refreshActiveMessages();
  }

  function visiblePeers(peers: PeerView[]): PeerView[] {
    return peers.filter(
      (peer) =>
        peer.id !== model.self.id &&
        // A browser page opened from this same host is a separate device on the server,
        // but it is this machine and must not appear as a chat target in its own UI.
        (browserMode || peer.host !== model.self.host || peer.port !== model.self.port),
    );
  }

  function applyState(state: AppState) {
    model.self = state.self;
    model.peers = visiblePeers(state.peers);
    model.onlineCount = model.peers.filter((peer) => peer.online).length;
    model.messages = state.messages;
    model.transfers = Object.fromEntries(
      state.transfers.map((transfer) => [transfer.id, transfer]),
    );
    model.loading = false;
    pruneUnread();
    syncActivePeer();
    updateTitle();
  }

  async function resumeDesktop() {
    if (browserMode) return;
    const [error, result] = await desktopState({ toastError: false });
    if (error || !result) return;
    const active = result.sessions.find(
      (session) =>
        session.role === 'controlled' &&
        (session.phase === 'accepted' ||
          session.phase === 'connecting' ||
          session.phase === 'connected'),
    );
    if (!active || model.desktopOpen) return;
    model.desktopPeerId = active.peerId;
    model.desktopSessionId = active.sessionId;
    model.desktopSharingId = active.sessionId;
    model.desktopMinimized = false;
    model.desktopOpen = true;
    pushToast(t('{name} 正在查看并控制你的屏幕', { name: active.peerName }), 'info');
  }

  async function refresh() {
    const [error, state] = await appState({ toastError: false });
    if (error || !state) {
      if (model.loading) {
        model.loading = false;
        pushToast(errorText(error) || t('无法读取本地服务状态'), 'error');
      }
      model.connected = false;
      return;
    }
    applyState(state);
    void resumeDesktop();
  }

  function applyPeers(peers: PeerView[]) {
    model.peers = visiblePeers(peers);
    model.onlineCount = model.peers.filter((peer) => peer.online).length;
    pruneUnread();
    syncActivePeer();
    updateTitle();
  }

  function selectPeer(id: string, focus = true) {
    if (model.activePeerId !== id) {
      if (model.activePeerId) drafts.set(model.activePeerId, model.draft);
      model.draft = drafts.get(id) ?? '';
    }
    if (id) autoSelectFirstPeer = true;
    model.activePeerId = id;
    model.unread = { ...model.unread, [id]: 0 };
    syncActivePeer();
    updateTitle();
    void nextTick().then(() => {
      scrollToBottom(true);
      if (composer.value) {
        autoGrow(composer.value);
        if (focus) composer.value.focus();
      }
    });
  }

  function addMessage(message: ChatMessage) {
    if (model.messages.some((item) => item.id === message.id)) return;
    model.messages = [...model.messages, message];
    if (message.direction === 'in' && model.peers.some((peer) => peer.id === message.peerId)) {
      selectPeer(message.peerId, false);
      return;
    }
    if (message.peerId === model.activePeerId) {
      refreshActiveMessages();
      void nextTick().then(() => scrollToBottom());
      return;
    }
    if (message.direction === 'out') return;
    model.unread = {
      ...model.unread,
      [message.peerId]: (model.unread[message.peerId] ?? 0) + 1,
    };
    updateTitle();
    const peer = model.peers.find((item) => item.id === message.peerId);
    const name = peer?.name ?? t('局域网设备');
    if (message.kind === 'file') {
      pushToast(
        t('{name} 发来文件 {file}', { name, file: truncate(message.file?.name ?? '', 40) }),
      );
    } else {
      pushToast(`${name}：${truncate(message.text ?? '', 60)}`);
    }
  }

  function updateStatus(payload: { id: string; status: MessageStatus; error?: string }) {
    const index = model.messages.findIndex((message) => message.id === payload.id);
    if (index < 0) return;
    const next = [...model.messages];
    next[index] = {
      ...next[index],
      status: payload.status,
      error: payload.error,
    };
    model.messages = next;
    if (next[index].peerId === model.activePeerId) refreshActiveMessages();
  }

  function applyTransfer(transfer: TransferView) {
    model.transfers = { ...model.transfers, [transfer.id]: transfer };
    if (transfer.peerId === model.activePeerId) refreshActiveMessages();
    if (
      transfer.direction === 'in' &&
      transfer.status === 'completed' &&
      !completedToasts.has(transfer.id)
    ) {
      completedToasts.add(transfer.id);
      pushToast(
        t('已接收 {name}', { name: truncate(transfer.savedName ?? transfer.file.name, 48) }),
        'success',
      );
    }
    if (
      transfer.direction === 'in' &&
      transfer.status === 'failed' &&
      !failedToasts.has(transfer.id)
    ) {
      failedToasts.add(transfer.id);
      pushToast(t('接收 {name} 失败', { name: truncate(transfer.file.name, 40) }), 'error');
    }
  }

  function scrollToBottom(force = false) {
    const element = chatScroll.value;
    if (!element) return;
    if (!force && element.scrollHeight - element.scrollTop - element.clientHeight > 160) return;
    element.scrollTop = element.scrollHeight;
  }

  function bindEvents() {
    const source = new EventSource(eventPath);
    eventSource = source;
    source.onopen = () => {
      model.connected = true;
      void refresh();
    };
    source.onerror = () => {
      model.connected = false;
      window.dispatchEvent(new Event('lanfly-service-disconnected'));
      if (browserMode && !model.joinBusy) void startBrowser();
    };
    source.addEventListener('reload', () => {
      window.location.reload();
    });
    source.addEventListener('peers', (event) => {
      const peers = parseEvent<PeerView[]>(event);
      if (peers) applyPeers(peers);
    });
    source.addEventListener('message', (event) => {
      const message = parseEvent<ChatMessage>(event);
      if (message) addMessage(message);
    });
    source.addEventListener('message-status', (event) => {
      const payload = parseEvent<{ id: string; status: MessageStatus; error?: string }>(event);
      if (payload) updateStatus(payload);
    });
    source.addEventListener('file-upload-request', (event) => {
      const request = parseEvent<FileUploadRequest>(event);
      if (request) deferredFiles.request(request);
    });
    source.addEventListener('file-upload-cancel', (event) => {
      const request = parseEvent<FileUploadRequest>(event);
      if (request) deferredFiles.cancel(request.sessionId);
    });
    source.addEventListener('file-offer-ended', (event) => {
      const request = parseEvent<{ transferId: string }>(event);
      if (request) deferredFiles.forget(request.transferId);
    });
    source.addEventListener('transfer', (event) => {
      const transfer = parseEvent<TransferView>(event);
      if (transfer) applyTransfer(transfer);
    });
    source.addEventListener('desktop', (event) => {
      const payload = parseEvent<DesktopEvent>(event);
      if (!payload) return;
      emitDesktopEvent(payload);
      if (
        payload.type === 'ended' &&
        model.desktopSharingId &&
        payload.sessionId === model.desktopSharingId
      ) {
        model.desktopSharingId = '';
        model.desktopOpen = false;
        model.desktopMinimized = false;
        model.desktopSessionId = '';
      }
      if (payload.type === 'accepted' && payload.session.role === 'controlled' && !browserMode) {
        const sameSession = model.desktopSharingId === payload.session.sessionId;
        model.desktopPeerId = payload.session.peerId;
        model.desktopSessionId = payload.session.sessionId;
        model.inputOpen = false;
        if (!sameSession) model.desktopMinimized = false;
        model.desktopOpen = true;
        model.desktopSharingId = payload.session.sessionId;
        pushToast(t('{name} 已开始查看并控制你的屏幕', { name: payload.session.peerName }), 'info');
      }
    });
  }

  function showDesktop(peerId: string) {
    model.desktopPeerId = peerId;
    model.desktopSessionId = '';
    model.desktopSharingId = '';
    model.desktopMinimized = false;
    model.inputOpen = false;
    model.desktopOpen = true;
  }

  async function openDesktop(peerId = model.activePeerId) {
    if (!peerId) return;
    if (model.desktopOpen && model.desktopPeerId === peerId) {
      model.desktopMinimized = false;
      return;
    }
    if (model.desktopPeerId && model.desktopPeerId !== peerId) {
      const [error, result] = await desktopState({ toastError: false });
      const active = result?.sessions.find(
        (session) =>
          session.phase === 'pending' ||
          session.phase === 'accepted' ||
          session.phase === 'connecting' ||
          session.phase === 'connected' ||
          session.phase === 'disconnected',
      );
      if (!error && active) {
        model.desktopSwitch = {
          peerId,
          sessionId: active.sessionId,
          currentName: active.peerName,
          nextName: model.peers.find((peer) => peer.id === peerId)?.name ?? t('目标设备'),
        };
        return;
      }
    }
    model.desktopOpen = false;
    await nextTick();
    showDesktop(peerId);
  }

  async function confirmDesktopSwitch() {
    const pending = model.desktopSwitch;
    if (!pending) return;
    model.desktopSwitch = null;
    await desktopStop({
      input: { sessionId: pending.sessionId, reason: 'SWITCHED' },
      toastError: false,
    });
    model.desktopOpen = false;
    await nextTick();
    showDesktop(pending.peerId);
  }

  async function sendDraft() {
    const text = model.draft.trim();
    if (!text) return;
    if (!model.activePeerId) {
      pushToast(t('请先选择一台设备'), 'error');
      return;
    }
    model.draft = '';
    if (composer.value) {
      composer.value.value = '';
      composer.value.style.height = '';
    }
    const [error, message] = await sendMessage({
      input: { peerId: model.activePeerId, text },
      toastError: false,
    });
    if (error) {
      pushToast(errorText(error), 'error');
      return;
    }
    if (message) addMessage(message);
  }

  async function retry(id: string) {
    const [error, message] = await retryMessage({
      input: { messageId: id },
      toastError: false,
    });
    if (error) {
      pushToast(errorText(error), 'error');
      return;
    }
    if (message) addMessage(message);
  }

  function upload(url: string, file: File): Promise<void> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.onload = () => {
        if (xhr.status !== 200)
          pushToast(t('文件 {name} 发送失败', { name: truncate(file.name, 40) }), 'error');
        resolve();
      };
      xhr.onerror = () => {
        pushToast(
          t('文件 {name} 发送失败，请检查网络', { name: truncate(file.name, 40) }),
          'error',
        );
        resolve();
      };
      xhr.onabort = () => resolve();
      xhr.send(file);
    });
  }

  async function sendOneFile(peerId: string, file: File) {
    const [error, result] = await sendFile({
      input: {
        peerId,
        file: {
          name: file.name || 'file',
          size: file.size,
          mime: file.type || 'application/octet-stream',
        },
      },
      toastError: false,
    });
    if (error || !result) {
      pushToast(errorText(error) || t('文件发送失败'), 'error');
      return;
    }
    if (result.deferred) deferredFiles.hold(result, file);
    else await upload(result.uploadUrl, file);
  }

  async function sendFiles(files: File[]) {
    if (!files.length) return;
    if (!model.activePeerId) {
      pushToast(t('请先选择一台设备'), 'error');
      return;
    }
    if (!model.activePeer.online) pushToast(t('对方当前离线，正在尝试发送…'), 'info');
    const peerId = model.activePeerId;
    for (const file of files) {
      await sendOneFile(peerId, file);
    }
  }

  function pickFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files ? [...input.files] : [];
    input.value = '';
    if (files.length) void sendFiles(files);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    model.dragging = false;
    const files = event.dataTransfer?.files ? [...event.dataTransfer.files] : [];
    if (files.length) void sendFiles(files);
  }

  function handlePaste(event: ClipboardEvent) {
    const files = event.clipboardData?.files;
    if (files && files.length) {
      event.preventDefault();
      void sendFiles([...files]);
    }
  }

  function autoGrow(element: HTMLTextAreaElement) {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 168)}px`;
  }

  function openAddPeer() {
    model.addOpen = true;
    model.addAddress = '';
    model.addError = '';
    model.addBusy = false;
  }

  function closeAddPeer() {
    if (model.addBusy) return;
    model.addOpen = false;
  }

  async function submitAddPeer() {
    const address = model.addAddress.trim();
    if (!address || model.addBusy) return;
    model.addBusy = true;
    model.addError = '';
    const [error, peer] = await connectPeer({
      input: { address },
      toastError: false,
    });
    if (error) {
      model.addError = errorText(error);
      model.addBusy = false;
      return;
    }
    model.addBusy = false;
    model.addOpen = false;
    pushToast(t('设备连接成功'), 'success');
    await refresh();
    if (peer) {
      selectPeer(peer.id);
    }
  }

  async function reconnect(peer: PeerView) {
    const address = peer.host.includes(':')
      ? `[${peer.host}]:${peer.port}`
      : `${peer.host}:${peer.port}`;
    const [error] = await connectPeer({ input: { address }, toastError: false });
    if (error) {
      pushToast(errorText(error), 'error');
      return;
    }
    pushToast(t('设备已重新连接'), 'success');
    await refresh();
  }

  async function removePeer(peerId: string) {
    const [error] = await forgetPeer({ input: { peerId }, toastError: false });
    if (error) {
      pushToast(errorText(error), 'error');
      return;
    }
    applyPeers(model.peers.filter((peer) => peer.id !== peerId));
    pushToast(t('已移除设备'), 'info');
  }

  async function cancel(id: string) {
    const [error] = await cancelTransfer({ input: { transferId: id }, toastError: false });
    if (error) pushToast(errorText(error), 'error');
  }

  async function openDownloadsFolder() {
    const [error] = await openDownloads({ toastError: false });
    if (error) pushToast(errorText(error), 'error');
  }

  async function copyAddress() {
    const address = `http://${model.self.host}:${model.self.port}`;
    try {
      await navigator.clipboard.writeText(address);
      pushToast(t('已复制局域网地址'), 'success');
    } catch {
      pushToast(t('局域网地址：{address}', { address }), 'info');
    }
  }

  function backToPeers() {
    autoSelectFirstPeer = false;
    selectPeer('', false);
  }

  watch(model, 'activeMessages', () => {
    void nextTick().then(() => scrollToBottom());
  });

  async function startBrowser() {
    if (model.joinBusy || disposed) return;
    window.clearTimeout(reconnectTimer);
    model.joinBusy = true;
    try {
      await joinBrowser(model.browserName.trim() || browserName());
      model.joinOpen = false;
      model.joinError = '';
      eventSource?.close();
      bindEvents();
      await refresh();
    } catch (error) {
      eventSource?.close();
      model.joinOpen = true;
      model.loading = false;
      model.joinError = error instanceof Error ? error.message : t('无法接入');
      if ((error as { status?: number }).status !== 401)
        reconnectTimer = window.setTimeout(() => void startBrowser(), 3000);
    } finally {
      model.joinBusy = false;
    }
  }

  async function submitBrowser() {
    if (!model.renaming) {
      await startBrowser();
      return;
    }
    try {
      await renameBrowser(model.browserName.trim());
      model.joinOpen = false;
      model.renaming = false;
      await refresh();
    } catch (error) {
      model.joinError = error instanceof Error ? error.message : t('修改失败');
    }
  }

  onMount(() => {
    if (browserMode) void startBrowser();
    else {
      void refresh();
      bindEvents();
    }
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      eventSource?.close();
      deferredFiles.stop();
      for (const timer of toastTimers) window.clearTimeout(timer);
      toastTimers.clear();
    };
  });

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-neutral-10 text-neutral-100">
      {model.joinOpen && (
        <Dialog
          title={model.renaming ? t('修改设备名称') : t('接入 lanfly')}
          canClose={model.renaming}
          onClose={() => {
            model.joinOpen = false;
          }}
        >
          <form
            className="flex flex-col gap-3"
            on:submit={(event) => {
              event.preventDefault();
              void submitBrowser();
            }}
          >
            <label>
              {t('设备名称')}
              <input
                className="mt-1 w-full rounded border border-neutral-60 bg-neutral-20 p-2"
                aria-label={t('设备名称')}
                value={model.browserName}
                maxLength={64}
                required
                on:input={(event) => {
                  model.browserName = (event.target as HTMLInputElement).value;
                }}
              />
            </label>
            {model.joinError && <p className="text-red-40">{model.joinError}</p>}
            <Button type="submit" variant="primary" disabled={model.joinBusy}>
              {model.renaming ? t('保存') : t('加入')}
            </Button>
          </form>
        </Dialog>
      )}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-40 bg-neutral-20/70 px-4">
        <div className="flex shrink-0 items-center gap-2">
          <span className="grid size-6 place-items-center rounded-[6px] bg-blue-30 text-white shadow-toolbar">
            <img className="size-[13px]" src="/favicon.svg" />
          </span>
          <strong className="text-[14px] tracking-[0.3px]">LanFly</strong>
        </div>
        <span className="h-4 w-px bg-neutral-50" />
        {model.self.id && (
          <div className="flex min-w-0 items-center gap-2">
            <Avatar name={model.self.name} id={model.self.id} size="sm" />
            <button
              className="truncate text-left text-[12px] text-neutral-100 disabled:cursor-default"
              disabled={!browserMode}
              on:click={() => {
                model.renaming = true;
                model.browserName = model.self.name;
                model.joinError = '';
                model.joinOpen = true;
              }}
            >
              {model.self.name}
            </button>
            <span
              className="flex shrink-0 items-center gap-1 rounded-full border border-neutral-50 bg-neutral-30 px-1.5 py-0.5 text-[9.5px] text-neutral-80 max-[900px]:hidden"
              title={t('相同 Room ID 的主机才能连接；数据明文传输')}
            >
              Room {model.self.roomId}
            </span>
            <button
              className="flex min-w-0 items-center gap-1 text-[10px] text-neutral-70 hover:text-neutral-90 max-[900px]:hidden"
              title={t('复制局域网地址：{address}', {
                address: `${model.self.host}:${model.self.port}`,
              })}
              on:click={() => void copyAddress()}
            >
              <span className="truncate">
                {model.self.host}:{model.self.port}
              </span>
              <span className="icon-[codicon--copy] shrink-0 text-[11px]" aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {model.desktopSharingId && (
            <Button
              size="compact"
              variant="ghost"
              className="text-green-40"
              title={t('屏幕共享中，点击打开')}
              aria-label={t('屏幕共享中，点击打开')}
              on:click={() => {
                model.desktopMinimized = false;
                model.desktopOpen = true;
              }}
            >
              <span
                className="icon-[codicon--screen-normal] text-[13px] sm:mr-1"
                aria-hidden="true"
              />
              <span className="max-[760px]:hidden">{t('屏幕共享中')}</span>
            </Button>
          )}
          <LanguageSwitcher />
          <span
            className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] ${
              model.connected
                ? 'border-neutral-50 text-neutral-80'
                : 'border-amber-30 bg-amber-10 text-amber-40'
            }`}
            title={
              model.connected ? t('本地服务连接正常') : t('与本地服务断开，EventSource 正在重连')
            }
          >
            <span
              className={`size-1.5 rounded-full ${model.connected ? 'bg-green-40' : 'typing-dot bg-amber-40'}`}
            />
            <span className="max-[900px]:hidden">
              {model.connected ? t('本地服务已连接') : t('正在重连…')}
            </span>
          </span>
          {!browserMode && (
            <Tooltip
              align="end"
              content={
                model.self.downloadsDir
                  ? t('当前下载目录\n{path}', { path: model.self.downloadsDir })
                  : t('当前下载目录尚未加载')
              }
            >
              <Button
                size="compact"
                variant="ghost"
                className="text-neutral-90 hover:text-neutral-110"
                aria-label={t('打开下载目录：{path}', {
                  path: model.self.downloadsDir || t('尚未加载'),
                })}
                on:click={() => void openDownloadsFolder()}
              >
                <span
                  className="icon-[codicon--folder-opened] align-middle text-[13px] sm:mr-1"
                  aria-hidden="true"
                />
                <span className="max-[760px]:hidden">{t('下载目录')}</span>
              </Button>
            </Tooltip>
          )}
          {!browserMode && (
            <Button
              size="compact"
              variant="primary"
              className="font-medium"
              aria-label={t('添加设备')}
              on:click={openAddPeer}
            >
              <span
                className="icon-[codicon--add] align-middle text-[13px] sm:mr-1"
                aria-hidden="true"
              />
              <span className="max-[760px]:hidden">{t('添加设备')}</span>
            </Button>
          )}
        </div>
      </header>

      {!model.connected && !model.loading && (
        <div className="shrink-0 border-b border-amber-30 bg-amber-10 px-4 py-1 text-center text-[10.5px] text-amber-40">
          {t('与本地 lanfly 服务的连接已断开，正在自动重连…')}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside
          className={`flex w-[278px] shrink-0 flex-col border-r border-neutral-40 bg-neutral-20/35 max-[760px]:w-full ${
            model.activePeerId ? 'max-[760px]:hidden' : ''
          }`}
        >
          <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
            <span className="text-[10px] font-semibold tracking-[0.12em] text-neutral-70 uppercase">
              {t('局域网设备')}
            </span>
            <span className="text-[10px] text-neutral-70">
              {t('{count} 在线', { count: model.onlineCount })}
            </span>
          </div>

          <PeerList
            readOnly={browserMode}
            peers={model.peers}
            activeId={model.activePeerId}
            unread={model.unread}
            onSelect={selectPeer}
            onRemove={(id) => void removePeer(id)}
            onReconnect={(peer) => void reconnect(peer)}
          />

          <div className="shrink-0 border-t border-neutral-40 px-4 py-3 text-[10px] leading-relaxed text-neutral-70">
            <div className="flex items-center gap-1.5">
              <span className="icon-[codicon--radio-tower] text-[11px]" aria-hidden="true" />
              <span>{browserMode ? t('已作为独立设备接入') : t('UDP 组播自动发现')}</span>
            </div>
            <div className="mt-1 text-neutral-70/80">
              {browserMode
                ? t('下载邀请有效 30 分钟；发送页面需保持打开。')
                : t('组播不可用时，点击“添加设备”输入对方 IP。')}
            </div>
          </div>
        </aside>

        <main
          className={`relative flex min-w-0 flex-1 flex-col ${model.activePeerId ? '' : 'max-[760px]:hidden'}`}
          on:dragEnter={(event) => {
            event.preventDefault();
            if (model.activePeerId) model.dragging = true;
          }}
          on:dragOver={(event) => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            if (model.activePeerId) model.dragging = true;
          }}
          on:dragLeave={(event) => {
            if (event.currentTarget === event.target) model.dragging = false;
          }}
          on:drop={handleDrop}
        >
          {model.loading && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-neutral-80">
              <span
                className="icon-[codicon--loading] animate-spin text-[26px]"
                aria-hidden="true"
              />
              <span className="text-[12px]">{t('正在连接本地服务…')}</span>
            </div>
          )}

          {!model.loading && !model.activePeerId && (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <div className="grid size-16 place-items-center rounded-full border border-neutral-40 bg-neutral-20 text-blue-40">
                <span
                  className={`${model.peers.length ? 'icon-[codicon--comment-discussion]' : 'icon-[codicon--radio-tower]'} text-[30px]`}
                  aria-hidden="true"
                />
              </div>
              <h1 className="mt-5 text-[17px] font-semibold text-neutral-110">
                {model.peers.length ? t('选择一台设备开始聊天') : t('正在发现局域网设备')}
              </h1>
              <p className="mt-2 max-w-[420px] text-[12px] leading-relaxed text-neutral-80">
                {model.peers.length
                  ? t(
                      '左侧列表中的设备与你运行着同一个 lanfly。选择后可以发送消息、拖拽文件，或直接粘贴截图。',
                    )
                  : t(
                      '让另一台电脑也运行 npx lanfly。同一局域网内会自动出现，不需要登录或配置服务器。',
                    )}
              </p>
              {!browserMode && !model.peers.length && (
                <div className="mt-6 flex items-center gap-2">
                  <Button variant="secondary" size="default" on:click={openAddPeer}>
                    <span
                      className="mr-1.5 icon-[codicon--plug] align-middle text-[13px]"
                      aria-hidden="true"
                    />
                    {t('手动添加 IP')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="default"
                    className="text-neutral-80"
                    on:click={() => void refresh()}
                  >
                    <span
                      className="mr-1.5 icon-[codicon--refresh] align-middle text-[13px]"
                      aria-hidden="true"
                    />
                    {t('刷新')}
                  </Button>
                </div>
              )}
              {model.self.id && (
                <div className="mt-8 rounded-popup border border-neutral-40 bg-neutral-20/70 px-4 py-2.5 text-[10.5px] text-neutral-70">
                  {t('本机地址：')}
                  <span className="ml-0.5 text-neutral-90">
                    {model.self.host}:{model.self.port}
                  </span>
                  <span className="mx-2 text-neutral-60">·</span>
                  Room {model.self.roomId}
                </div>
              )}
            </div>
          )}

          {!model.loading && model.activePeerId && model.activePeer.id && (
            <>
              <div className="flex h-[60px] shrink-0 items-center gap-3 border-b border-neutral-40 bg-neutral-20/30 px-5">
                <Button
                  size="icon"
                  className="text-neutral-90 min-[761px]:hidden"
                  title={t('返回设备列表')}
                  aria-label={t('返回设备列表')}
                  on:click={backToPeers}
                >
                  <span className="icon-[codicon--arrow-left] text-[16px]" aria-hidden="true" />
                </Button>
                <Avatar
                  name={model.activePeer.name}
                  id={model.activePeer.id}
                  online={model.activePeer.online}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-semibold text-neutral-110">
                      {model.activePeer.name}
                    </span>
                    {model.activePeer.manual && (
                      <span className="rounded-control border border-neutral-50 px-1 py-0.5 text-[9px] text-neutral-80">
                        {t('手动')}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-neutral-80">
                    <span
                      className={`size-1.5 rounded-full ${model.activePeer.online ? 'bg-green-40' : 'bg-neutral-70'}`}
                    />
                    <span>
                      {model.activePeer.online ? t('在线') : t('离线')}
                      <span className="mx-1 text-neutral-60">·</span>
                      {model.activePeer.kind === 'browser'
                        ? model.activePeer.host
                        : `${model.activePeer.host}:${model.activePeer.port}`}
                    </span>
                  </div>
                </div>
                {model.activePeer.kind !== 'browser' &&
                  model.activePeer.online &&
                  model.activePeer.id !== (browserMode ? model.self.gatewayId : undefined) && (
                    <Button
                      size="compact"
                      variant="ghost"
                      className="shrink-0 text-neutral-80 hover:text-neutral-110"
                      title={t('远程桌面：{name}', { name: model.activePeer.name })}
                      aria-label={t('远程桌面')}
                      on:click={() => void openDesktop(model.activePeer.id)}
                    >
                      <span
                        className="icon-[codicon--share-window] align-middle text-[13px] sm:mr-1"
                        aria-hidden="true"
                      />
                      <span className="max-[760px]:hidden">{t('远程桌面')}</span>
                    </Button>
                  )}
                {!browserMode &&
                  model.activePeer.kind !== 'browser' &&
                  model.activePeer.online &&
                  model.activePeer.id !== model.self.gatewayId && (
                    <Button
                      size="compact"
                      variant="ghost"
                      className="shrink-0 text-neutral-80 hover:text-neutral-110"
                      title={t('键鼠共享：{name}', { name: model.activePeer.name })}
                      aria-label={t('键鼠共享')}
                      on:click={() => {
                        model.inputOpen = true;
                      }}
                    >
                      <span
                        className="icon-[codicon--remote] align-middle text-[13px] sm:mr-1"
                        aria-hidden="true"
                      />
                      <span className="max-[760px]:hidden">{t('键鼠共享')}</span>
                    </Button>
                  )}
              </div>

              <div ref={chatScroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="mx-auto flex w-full max-w-[820px] flex-col gap-2.5">
                  {model.activeMessages.length === 0 && (
                    <div className="flex flex-col items-center gap-2 py-16 text-center text-neutral-70">
                      <span
                        className="icon-[codicon--comment-discussion] text-[24px]"
                        aria-hidden="true"
                      />
                      <p className="m-0 text-[11.5px]">
                        {t('还没有消息。向 {name} 发送第一条消息吧。', {
                          name: model.activePeer.name,
                        })}
                      </p>
                      <p className="m-0 text-[10.5px] text-neutral-70">
                        {t('对方离线时消息会显示发送失败，可在消息下方重试。')}
                      </p>
                    </div>
                  )}
                  {model.activeMessages.map((message) => (
                    <MessageItem
                      key={message.id}
                      message={message}
                      onRetry={(id) => void retry(id)}
                      onCancel={(id) => void cancel(id)}
                      onCopied={(copied) =>
                        pushToast(
                          copied ? t('已复制消息') : t('复制失败'),
                          copied ? 'success' : 'error',
                        )
                      }
                    />
                  ))}
                  <div className="h-1" />
                </div>
              </div>

              <div className="shrink-0 border-t border-neutral-40 bg-neutral-20/40 px-5 py-3">
                <div className="mx-auto w-full max-w-[820px]">
                  <div className="flex items-end gap-1.5 rounded-[12px] border border-neutral-50 bg-neutral-30 p-1.5 transition-colors focus-within:border-neutral-60">
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      accept="*/*"
                      className="hidden"
                      on:change={pickFiles}
                    />
                    <Button
                      size="icon"
                      className="mb-0.5 shrink-0 text-neutral-80 hover:bg-white/5 hover:text-neutral-110"
                      title={t('发送文件')}
                      aria-label={t('发送文件')}
                      on:click={() => fileInput.value?.click()}
                    >
                      <span className="icon-[codicon--attach] text-[17px]" aria-hidden="true" />
                    </Button>
                    <textarea
                      ref={composer}
                      rows={1}
                      value={model.draft}
                      placeholder={t('发送给 {name}…', { name: model.activePeer.name })}
                      aria-label={t('消息内容')}
                      on:input={(event) => {
                        model.draft = event.target.value;
                        autoGrow(event.target);
                      }}
                      on:keyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                          event.preventDefault();
                          void sendDraft();
                        }
                      }}
                      on:paste={handlePaste}
                      className="max-h-42 min-h-7 min-w-0 flex-1 bg-transparent px-1 py-1 text-[13px] leading-[1.55] text-neutral-110 outline-none placeholder:text-neutral-70"
                    />
                    <Button
                      size="icon"
                      variant="primary"
                      className="mb-0.5 shrink-0 rounded-[7px]"
                      disabled={!model.draft.trim()}
                      title={t('发送（Enter）')}
                      aria-label={t('发送消息')}
                      on:click={() => void sendDraft()}
                    >
                      <span className="icon-[codicon--send] text-[15px]" aria-hidden="true" />
                    </Button>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between px-1 text-[10px] text-neutral-70">
                    <span>{t('Enter 发送 · Shift+Enter 换行 · 支持拖拽或粘贴文件')}</span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`size-1.5 rounded-full ${model.activePeer.online ? 'bg-green-40' : 'bg-neutral-60'}`}
                      />
                      {model.activePeer.online ? t('对方在线') : t('对方离线')}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}

          {model.dragging && (
            <div className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-[12px] border-2 border-dashed border-blue-40 bg-neutral-20/85 backdrop-blur-[2px]">
              <div className="flex flex-col items-center gap-2 text-blue-40">
                <span className="icon-[codicon--cloud-upload] text-[34px]" aria-hidden="true" />
                <span className="text-[13px] font-medium">{t('松开鼠标发送文件')}</span>
                <span className="text-[10.5px] text-neutral-80">{t('文件会直接传到对方设备')}</span>
              </div>
            </div>
          )}
        </main>
      </div>

      {model.addOpen && (
        <AddPeerDialog
          address={model.addAddress}
          busy={model.addBusy}
          error={model.addError}
          onAddress={(value) => (model.addAddress = value)}
          onSubmit={() => void submitAddPeer()}
          onClose={closeAddPeer}
        />
      )}

      {model.inputOpen && (
        <InputSharingDialog
          peers={model.peers}
          activePeerId={model.activePeerId}
          onClose={() => {
            model.inputOpen = false;
          }}
        />
      )}

      {model.desktopSwitch && (
        <Dialog
          title={t('切换远程桌面')}
          size="compact"
          onClose={() => {
            model.desktopSwitch = null;
          }}
        >
          <p className="m-0 text-[12px] leading-relaxed text-neutral-90">
            {t('当前正在与')}{' '}
            <strong className="text-neutral-110">{model.desktopSwitch.currentName}</strong>{' '}
            {t('进行远程桌面。')}
          </p>
          <p className="mt-2 mb-0 text-[12px] leading-relaxed text-neutral-80">
            {t('结束当前会话并连接到')}{' '}
            <strong className="text-neutral-110">{model.desktopSwitch.nextName}</strong>
            {t('？')}
          </p>
          <DialogActions>
            <Button
              variant="secondary"
              on:click={() => {
                model.desktopSwitch = null;
              }}
            >
              {t('取消')}
            </Button>
            <Button variant="danger" on:click={() => void confirmDesktopSwitch()}>
              {t('结束并切换')}
            </Button>
          </DialogActions>
        </Dialog>
      )}

      {model.desktopOpen && (
        <RemoteDesktopDialog
          peers={model.peers}
          activePeerId={model.desktopPeerId || model.activePeerId}
          browserMode={browserMode}
          gatewayId={model.self.gatewayId}
          localAddressHint={browserMode ? undefined : model.self.host}
          initialSessionId={model.desktopSessionId}
          minimized={model.desktopMinimized}
          onMinimize={() => {
            model.desktopMinimized = true;
          }}
          onClose={() => {
            model.desktopOpen = false;
            model.desktopMinimized = false;
            model.desktopSessionId = '';
            model.desktopSharingId = '';
            model.desktopPeerId = '';
          }}
        />
      )}

      <Toasts toasts={model.toasts} onDismiss={dismissToast} />
    </div>
  );
}

function parseEvent<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent).data as string) as T;
  } catch {
    return null;
  }
}
