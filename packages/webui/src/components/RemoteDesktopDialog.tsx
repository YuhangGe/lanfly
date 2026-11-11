import {
  DESKTOP_DEFAULT_BITRATE,
  type ActionResultError,
  type DesktopEvent,
  type DesktopIceCandidate,
  type DesktopPhase,
  type DesktopSessionView,
  type DesktopStatus,
  type PeerView,
} from '@lanfly/common';
import {
  desktopIce,
  desktopOffer,
  desktopPermissions,
  desktopRequest,
  desktopState,
  desktopStatus,
  desktopStop,
} from '@server';
import { nextTick, onMount, ref, vm } from 'jinge';

import { ActionError } from '../service/action';
import { browserLocalAddress } from '../service/browser';
import { onDesktopEvent } from '../service/desktop';
import { DesktopControl } from '../service/desktop-input';
import Button from './Button';
import Dialog from './Dialog';

type UiPhase = 'idle' | 'waiting' | 'connecting' | 'connected' | 'ended' | 'error';

const ICE_SERVERS: RTCIceServer[] = [];

function errorText(error: ActionResultError | null | undefined): string {
  return error ? new ActionError(error).message : '';
}

function phaseText(phase: UiPhase): string {
  switch (phase) {
    case 'waiting':
      return '等待对方授权';
    case 'connecting':
      return '正在建立视频连接';
    case 'connected':
      return '已连接';
    case 'ended':
      return '会话已结束';
    case 'error':
      return '连接失败';
    default:
      return '选择设备';
  }
}

function withLanAddress(
  candidate: DesktopIceCandidate,
  address: string,
): DesktopIceCandidate | null {
  if (!address || address === '.local') return null;
  const parts = candidate.candidate.split(' ');
  if (parts.length < 8 || !parts[4].endsWith('.local')) return null;
  const direct = [...parts];
  direct[4] = address;
  return { ...candidate, candidate: direct.join(' ') };
}

function statusFromPhase(phase: DesktopPhase): UiPhase {
  if (phase === 'pending') return 'waiting';
  if (phase === 'accepted') return 'connecting';
  if (phase === 'connected') return 'connected';
  if (phase === 'disconnected') return 'connecting';
  if (phase === 'failed') return 'error';
  if (phase === 'rejected' || phase === 'stopped') return 'ended';
  return 'idle';
}

export default function RemoteDesktopDialog(props: {
  peers: PeerView[];
  activePeerId: string;
  browserMode: boolean;
  gatewayId?: string;
  localAddressHint?: string;
  initialSessionId?: string;
  onClose: () => void;
}) {
  const model = vm({
    phase: 'idle' as UiPhase,
    mode: 'controller' as 'controller' | 'controlled',
    session: null as DesktopSessionView | null,
    error: '',
    busy: false,
    status: null as DesktopStatus | null,
    statusLoading: true,
    peerId: '',
    controlGranted: true,
    bitrate: DESKTOP_DEFAULT_BITRATE,
    videoReady: false,
    fullscreen: false,
    controlReady: false,
    width: 0,
    height: 0,
    lanAddress: '',
  });
  const stage = ref<HTMLDivElement>();
  const video = ref<HTMLVideoElement>();

  let mounted = true;
  let statusTimer: number | undefined;
  let unsubscribe: (() => void) | undefined;
  let pc: RTCPeerConnection | undefined;
  let dc: RTCDataChannel | undefined;
  let stream: MediaStream | undefined;
  let control: DesktopControl | undefined;
  let remoteDescriptionSet = false;
  let canSendCandidates = false;
  let connecting = false;
  let closing = false;
  const pendingRemote: DesktopIceCandidate[] = [];
  const pendingLocal: DesktopIceCandidate[] = [];

  function nativePeers(): PeerView[] {
    return props.peers.filter((peer) => peer.kind !== 'browser' && peer.id !== props.gatewayId);
  }

  function setInitialPeer() {
    if (props.gatewayId && model.peerId === props.gatewayId) model.peerId = '';
    if (model.peerId) return;
    const active = props.peers.find(
      (peer) =>
        peer.id === props.activePeerId && peer.kind !== 'browser' && peer.id !== props.gatewayId,
    );
    if (active) model.peerId = active.id;
    else model.peerId = nativePeers().find((peer) => peer.online)?.id ?? '';
  }

  function applySession(session: DesktopSessionView) {
    model.session = session;
    model.mode = session.role;
    model.phase = statusFromPhase(session.phase);
    model.controlGranted = session.control;
    model.width = session.width;
    model.height = session.height;
    model.error = session.error ?? '';
    if (session.role === 'controller') {
      model.peerId = session.peerId;
      if (session.phase === 'accepted') {
        model.phase = 'connecting';
        if (!session.error) void connect(session);
      } else if (session.phase === 'connecting' || session.phase === 'connected') {
        model.phase = 'error';
        model.error = '这个会话已经由另一个页面建立，请先结束会话后重试。';
      }
    }
  }

  async function loadState() {
    const [error, result] = await desktopState({ toastError: false });
    if (!mounted) return;
    if (error) {
      model.error = errorText(error);
      return;
    }
    const sessions = result?.sessions ?? [];
    const initial = props.initialSessionId
      ? sessions.find((session) => session.sessionId === props.initialSessionId)
      : undefined;
    const target = initial ?? sessions[0];
    if (target) applySession(target);
    else setInitialPeer();
  }

  async function refreshStatus() {
    if (props.browserMode) {
      model.statusLoading = false;
      return;
    }
    const [error, status] = await desktopStatus({ toastError: false });
    if (!mounted) return;
    model.statusLoading = false;
    if (error) {
      model.error = errorText(error);
      return;
    }
    if (status) {
      model.status = status;
      if (model.session?.role === 'controlled' && model.error === 'DESKTOP_PERMISSION')
        model.error = '';
    }
  }

  async function requestPermissions() {
    if (model.busy || props.browserMode) return;
    model.busy = true;
    try {
      const [error, status] = await desktopPermissions({ toastError: false });
      if (!mounted) return;
      if (error) model.error = errorText(error);
      else if (status) {
        model.status = status;
        model.statusLoading = false;
      }
    } finally {
      if (mounted) model.busy = false;
    }
  }

  async function startRequest() {
    if (model.busy) return;
    setInitialPeer();
    if (!model.peerId) {
      model.error = '请选择一台在线设备';
      return;
    }
    model.busy = true;
    model.error = '';
    try {
      const [error, session] = await desktopRequest({
        input: { peerId: model.peerId, bitrate: model.bitrate },
        toastError: false,
      });
      if (!mounted) return;
      if (error || !session) {
        model.error = errorText(error) || '无法发起远程桌面请求';
        model.phase = 'error';
        return;
      }
      model.session = session;
      model.mode = 'controller';
      model.controlGranted = true;
      model.error = session.error ? new ActionError({ code: session.error }).message : '';
      model.phase = session.error ? 'error' : statusFromPhase(session.phase);
      if (!session.error && session.phase === 'accepted') void connect(session);
    } finally {
      if (mounted) model.busy = false;
    }
  }

  function bindDataChannel(channel: RTCDataChannel) {
    dc = channel;
    channel.onopen = () => {
      model.controlReady = true;
      maybeAttachControl();
    };
    channel.onclose = () => {
      model.controlReady = false;
      control?.detach();
    };
    channel.onerror = () => {
      model.controlReady = false;
    };
  }

  function maybeAttachControl() {
    if (!model.controlGranted || !dc || dc.readyState !== 'open') return;
    const stageElement = stage.value;
    const videoElement = video.value;
    if (!stageElement || !videoElement) return;
    if (!control) {
      control = new DesktopControl(stageElement, videoElement, (payload) => {
        if (dc?.readyState === 'open') dc.send(JSON.stringify(payload));
      });
    }
    control.attach();
  }

  async function connect(session: DesktopSessionView) {
    if (connecting || model.phase === 'connected') return;
    if (session.role !== 'controller') return;
    connecting = true;
    cleanupPeer();
    model.phase = 'connecting';
    model.error = '';
    try {
      const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });
      pc = peer;
      peer.onicecandidate = (event) => {
        if (!event.candidate) return;
        const json = event.candidate.toJSON();
        if (!json.candidate) return;
        const candidate: DesktopIceCandidate = {
          candidate: json.candidate,
          sdpMid: json.sdpMid,
          sdpMLineIndex: json.sdpMLineIndex,
          usernameFragment: json.usernameFragment,
        };
        const direct = withLanAddress(candidate, model.lanAddress);
        if (!canSendCandidates) {
          pendingLocal.push(candidate);
          if (direct) pendingLocal.push(direct);
          return;
        }
        void sendIceCandidate(session.sessionId, candidate);
        if (direct) void sendIceCandidate(session.sessionId, direct);
      };
      peer.ontrack = (event) => {
        stream = event.streams[0] ?? new MediaStream([event.track]);
        if (video.value) {
          video.value.srcObject = stream;
          void video.value.play().catch(() => undefined);
        }
        model.videoReady = true;
        void nextTick().then(maybeAttachControl);
      };
      peer.onconnectionstatechange = () => {
        if (!mounted || pc !== peer) return;
        switch (peer.connectionState) {
          case 'connected':
            model.phase = 'connected';
            model.error = '';
            void nextTick().then(maybeAttachControl);
            break;
          case 'disconnected':
            model.phase = 'connecting';
            break;
          case 'failed':
            model.phase = 'error';
            model.error = 'WebRTC 连接失败，请确认两台设备在同一局域网内。';
            break;
          default:
            break;
        }
      };
      bindDataChannel(peer.createDataChannel('lanfly-control', { ordered: true }));
      peer.addTransceiver('video', { direction: 'recvonly' });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const sdp = peer.localDescription?.sdp ?? offer.sdp;
      if (!sdp) throw new Error('无法生成 SDP offer');
      const [error, result] = await desktopOffer({
        input: { sessionId: session.sessionId, sdp },
        toastError: false,
      });
      if (!mounted) return;
      if (error || !result) {
        throw new Error(errorText(error) || 'SDP 交换失败');
      }
      await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
      remoteDescriptionSet = true;
      canSendCandidates = true;
      for (const candidate of pendingRemote.splice(0)) {
        await peer.addIceCandidate(candidate).catch(() => undefined);
      }
      for (const candidate of pendingLocal.splice(0)) {
        void sendIceCandidate(session.sessionId, candidate);
      }
      model.width = result.width || model.width;
      model.height = result.height || model.height;
    } catch (error) {
      if (!mounted) return;
      model.phase = 'error';
      model.error = error instanceof Error ? error.message : '无法建立远程桌面连接';
      cleanupPeer();
    } finally {
      connecting = false;
    }
  }

  async function sendIceCandidate(id: string, candidate: DesktopIceCandidate) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [error] = await desktopIce({
        input: { sessionId: id, candidate },
        toastError: false,
      });
      if (!error) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  async function addRemoteCandidate(candidate: DesktopIceCandidate) {
    if (!pc) return;
    if (!remoteDescriptionSet) {
      pendingRemote.push(candidate);
      return;
    }
    await pc.addIceCandidate(candidate).catch(() => undefined);
  }

  function handleEvent(event: DesktopEvent) {
    if (!mounted || event.type === 'request') return;
    if (event.type === 'accepted') {
      const current = model.session;
      if (!current || current.sessionId !== event.session.sessionId) return;
      model.session = event.session;
      model.controlGranted = true;
      model.width = event.session.width;
      model.height = event.session.height;
      if (event.session.error) {
        model.phase = 'error';
        model.error = new ActionError({ code: event.session.error }).message;
        return;
      }
      model.phase = 'connecting';
      if (event.session.role === 'controller') void connect(event.session);
      return;
    }
    if (event.type === 'rejected') {
      const current = model.session;
      if (!current || current.sessionId !== event.session.sessionId) return;
      model.phase = 'ended';
      model.error = event.reason ? `对方拒绝：${event.reason}` : '对方拒绝了远程桌面请求';
      cleanupPeer();
      return;
    }
    const session = model.session;
    if (!session || event.sessionId !== session.sessionId) return;
    if (event.type === 'ice') {
      void addRemoteCandidate(event.candidate);
    } else if (event.type === 'state') {
      model.phase = statusFromPhase(event.phase);
      if (event.error) {
        model.error = new ActionError({ code: event.error }).message;
        if (event.phase === 'failed') cleanupPeer();
      }
    } else if (event.type === 'ended') {
      model.phase = 'ended';
      if (event.reason && event.reason !== 'STOPPED') {
        model.error = new ActionError({ code: event.reason }).message;
      }
      cleanupPeer();
    }
  }

  function cleanupPeer() {
    control?.detach();
    control = undefined;
    if (dc) {
      dc.onopen = null;
      dc.onclose = null;
      dc.onerror = null;
      try {
        dc.close();
      } catch {
        // already closed
      }
      dc = undefined;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = undefined;
    }
    if (video.value) {
      video.value.srcObject = null;
    }
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // already closed
      }
      pc = undefined;
    }
    remoteDescriptionSet = false;
    canSendCandidates = false;
    pendingRemote.length = 0;
    pendingLocal.length = 0;
    model.controlReady = false;
    model.videoReady = false;
  }

  async function stopSession(reason = 'STOPPED') {
    const session = model.session;
    cleanupPeer();
    model.phase = 'ended';
    if (!session) return;
    const [error] = await desktopStop({
      input: { sessionId: session.sessionId, reason },
      toastError: false,
    });
    if (error && error.code !== 'DESKTOP_NOT_FOUND' && error.code !== 'DESKTOP_STATE')
      model.error = errorText(error);
    model.session = { ...session, phase: 'stopped' };
  }

  async function close() {
    if (closing) return;
    closing = true;
    if (
      model.session &&
      (model.phase === 'waiting' ||
        model.phase === 'connecting' ||
        model.phase === 'connected' ||
        model.phase === 'error')
    ) {
      await stopSession('USER_CLOSED').catch(() => undefined);
    } else {
      cleanupPeer();
    }
    mounted = false;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    props.onClose();
  }

  async function toggleFullscreen() {
    const element = stage.value;
    if (!element) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await element.requestFullscreen();
    } catch {
      // Fullscreen may be denied by the browser; the inline stage still works.
    }
  }

  onMount(() => {
    const element = video.value;
    const metadata = () => {
      model.videoReady = true;
      if (video.value) {
        model.width = video.value.videoWidth;
        model.height = video.value.videoHeight;
      }
      maybeAttachControl();
    };
    const fullscreen = () => {
      model.fullscreen = Boolean(document.fullscreenElement);
    };
    const pagehide = () => {
      control?.release();
      const session = model.session;
      if (
        session &&
        (model.phase === 'waiting' || model.phase === 'connecting' || model.phase === 'connected')
      ) {
        const url = props.browserMode ? '/api/v1/browser/rpc/desktopStop' : '/__rpc/desktopStop';
        const body = JSON.stringify({
          json: { sessionId: session.sessionId, reason: 'PAGE_CLOSED' },
        });
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      }
    };
    element?.addEventListener('loadedmetadata', metadata);
    document.addEventListener('fullscreenchange', fullscreen);
    window.addEventListener('pagehide', pagehide);
    unsubscribe = onDesktopEvent(handleEvent);
    if (props.browserMode) {
      void browserLocalAddress().then((address) => {
        if (mounted) model.lanAddress = address;
      });
    } else {
      model.lanAddress = props.localAddressHint ?? '';
    }
    void loadState();
    if (!props.browserMode) {
      void refreshStatus();
      statusTimer = window.setInterval(() => {
        if (!model.busy) void refreshStatus();
      }, 2500);
    }
    setInitialPeer();
    return () => {
      mounted = false;
      unsubscribe?.();
      window.clearInterval(statusTimer);
      element?.removeEventListener('loadedmetadata', metadata);
      document.removeEventListener('fullscreenchange', fullscreen);
      window.removeEventListener('pagehide', pagehide);
      cleanupPeer();
    };
  });

  return (
    <Dialog title="远程桌面" size="screen" onClose={() => void close()} canClose={!model.busy}>
      <div className="flex flex-col gap-3 text-[12px] text-neutral-90">
        {!model.session && (
          <div className="rounded-control border border-neutral-50 bg-neutral-20 p-3">
            <p className="m-0 leading-relaxed text-neutral-80">
              选择一台局域网内的 Mac，发起后对方自动接受并开启鼠标键盘控制。视频通过 WebRTC
              直接传输，不经过 Node.js 中转。被控端需预先授予屏幕录制和辅助功能权限。
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
              <label className="flex flex-col gap-1.5">
                远程设备
                <select
                  value={model.peerId}
                  className="rounded-control border border-neutral-60 bg-neutral-40 px-2.5 py-2 text-[12px] text-neutral-110 outline-none focus:border-blue-40"
                  on:change={(event) => {
                    model.peerId = (event.target as HTMLSelectElement).value;
                  }}
                >
                  <option value="">请选择一台设备</option>
                  {nativePeers().map((peer) => (
                    <option key={peer.id} value={peer.id}>
                      {peer.name}
                      {peer.online ? '' : '（离线）'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                画质
                <select
                  value={String(model.bitrate)}
                  className="rounded-control border border-neutral-60 bg-neutral-40 px-2.5 py-2 text-[12px] text-neutral-110 outline-none focus:border-blue-40"
                  on:change={(event) => {
                    model.bitrate = Number((event.target as HTMLSelectElement).value);
                  }}
                >
                  <option value="2000000">流畅（2 Mbps）</option>
                  <option value="4000000">均衡（4 Mbps）</option>
                  <option value="8000000">清晰（8 Mbps）</option>
                </select>
              </label>
            </div>
            <p className="mt-3 mb-0 text-[11px] leading-relaxed text-neutral-70">
              建立后会自动开启鼠标和键盘控制，不需要对方再确认。
            </p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[10.5px] leading-relaxed text-neutral-70">
                手机浏览器也可作为查看端；控制端需要 macOS 的辅助功能权限。
              </span>
              <Button
                variant="primary"
                disabled={model.busy || !model.peerId}
                on:click={() => void startRequest()}
              >
                {model.busy ? '正在连接…' : '开始远程桌面'}
              </Button>
            </div>
          </div>
        )}

        {model.session && (
          <div className="flex items-center justify-between gap-3 rounded-control border border-neutral-50 bg-neutral-20 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  model.phase === 'connected'
                    ? 'bg-green-40'
                    : model.phase === 'error'
                      ? 'bg-red-40'
                      : 'typing-dot bg-amber-40'
                }`}
              />
              <span className="truncate text-[12px] text-neutral-100">
                {model.session.peerName} · {phaseText(model.phase)}
              </span>
              {model.controlGranted &&
                (model.phase === 'connecting' || model.phase === 'connected') && (
                  <span className="rounded-full border border-green-40/40 bg-green-40/10 px-1.5 py-0.5 text-[9.5px] text-green-40">
                    可控制
                  </span>
                )}
            </div>
            <div className="flex shrink-0 gap-1.5">
              {model.phase === 'connected' && (
                <Button
                  size="compact"
                  variant="secondary"
                  title={model.fullscreen ? '退出全屏' : '全屏显示'}
                  on:click={() => void toggleFullscreen()}
                >
                  <span
                    className={`${model.fullscreen ? 'icon-[codicon--screen-normal]' : 'icon-[codicon--screen-full]'} text-[13px]`}
                    aria-hidden="true"
                  />
                </Button>
              )}
              {(model.phase === 'waiting' ||
                model.phase === 'connecting' ||
                model.phase === 'connected' ||
                model.phase === 'error') && (
                <Button
                  size="compact"
                  variant="danger"
                  disabled={model.busy}
                  on:click={() => void stopSession('USER_STOPPED')}
                >
                  停止远程桌面
                </Button>
              )}
            </div>
          </div>
        )}

        {model.session?.role === 'controlled' &&
          (model.phase === 'connecting' || model.phase === 'connected') && (
            <div className="rounded-control border border-neutral-50 bg-neutral-20 p-4 text-[12px] leading-relaxed text-neutral-80">
              <p className="m-0">
                正在向 {model.session.peerName} 共享屏幕，鼠标键盘控制已同时开启。
              </p>
              <p className="mt-1 mb-0 text-[11px] text-neutral-70">
                随时可以点击“停止远程桌面”结束共享。停止后对方会立即失去画面和控制。
              </p>
            </div>
          )}

        {model.session?.role === 'controller' && (
          <div
            ref={stage}
            tabIndex={0}
            aria-label="远程桌面画面"
            className={`relative overflow-hidden rounded-control border border-neutral-60 bg-black outline-none ${
              model.phase === 'connected' || model.phase === 'connecting' ? '' : 'hidden'
            } h-[min(62vh,620px)]`}
          >
            <video
              ref={video}
              autoPlay
              muted
              playsInline
              className="h-full w-full object-contain"
            />
            {model.phase !== 'connected' && (
              <div className="absolute inset-0 grid place-items-center bg-black/60 text-center">
                <div className="flex flex-col items-center gap-2 text-neutral-80">
                  <span
                    className="icon-[codicon--loading] animate-spin text-[26px]"
                    aria-hidden="true"
                  />
                  <span className="text-[11.5px]">{phaseText(model.phase)}…</span>
                  {model.session && (
                    <span className="text-[10.5px] text-neutral-70">
                      {model.session.peerName} · WebRTC / H.264
                    </span>
                  )}
                </div>
              </div>
            )}
            {model.phase === 'connected' && model.controlGranted && !model.controlReady && (
              <div className="pointer-events-none absolute bottom-2 left-2 rounded-control bg-black/60 px-2 py-1 text-[10px] text-amber-40">
                控制通道正在建立，视频已可查看
              </div>
            )}
          </div>
        )}

        {model.phase === 'connected' && model.session?.role === 'controller' && (
          <p className="m-0 text-[10.5px] leading-relaxed text-neutral-70">
            点击画面后可使用鼠标和键盘；离开窗口会释放所有按键。
            {model.width > 0 && model.height > 0 ? ` 分辨率 ${model.width}×${model.height}。` : ''}
          </p>
        )}

        {model.phase === 'ended' && (
          <div className="rounded-control border border-neutral-50 bg-neutral-20 p-4 text-[12px] leading-relaxed">
            <strong>远程桌面已结束</strong>
            <p className="mt-1 mb-0 text-neutral-80">{model.error || '会话已停止。'}</p>
            <div className="mt-3 flex justify-end">
              <Button variant="secondary" on:click={() => void close()}>
                关闭
              </Button>
            </div>
          </div>
        )}

        {model.error && model.phase !== 'ended' && (
          <p
            role="alert"
            className="m-0 rounded-control border border-red-40/40 bg-red-40/10 px-2.5 py-2 text-[11px] text-red-40"
          >
            {model.error}
          </p>
        )}

        {model.phase === 'error' && model.session && (
          <div className="flex justify-end">
            <Button variant="secondary" on:click={() => void stopSession('USER_STOPPED')}>
              结束会话
            </Button>
          </div>
        )}

        {!props.browserMode && model.status && model.status.available && (
          <div className="flex flex-wrap items-center gap-2 rounded-control border border-neutral-50 px-2.5 py-2 text-[10px] text-neutral-70">
            <span>屏幕录制：{model.status.screenRecording ? '已授权' : '未授权'}</span>
            <span>辅助功能：{model.status.accessibility ? '已授权' : '未授权'}</span>
            <span>显示器：{model.status.screens} 个</span>
            {(!model.status.screenRecording || !model.status.accessibility) && (
              <Button
                size="compact"
                variant="secondary"
                disabled={model.busy}
                on:click={() => void requestPermissions()}
              >
                请求系统授权
              </Button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
