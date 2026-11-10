import type { InputEdge, InputStatus, PeerView } from '@lanfly/common';

import {
  inputConfigure,
  inputConfirm,
  inputConnect,
  inputDisable,
  inputEnable,
  inputForget,
  inputPairing,
  inputPermissions,
  inputStatus,
} from '@server';
import { onMount, vm } from 'jinge';

import { ActionError } from '../service/action';
import Button from './Button';
import Dialog from './Dialog';

const EMPTY: InputStatus = {
  supported: true,
  available: false,
  accessibility: false,
  inputMonitoring: false,
  screens: 0,
  settings: { role: 'server', edge: 'right' },
  enabled: false,
  phase: 'disabled',
  controlling: false,
  confirmed: false,
};
const phaseText = {
  disabled: '已停止',
  waiting: '等待连接',
  connecting: '正在连接',
  pairing: '等待双方确认',
  connected: '已连接',
};
const edges: { value: InputEdge; label: string; arrow: string }[] = [
  { value: 'left', label: '左侧', arrow: '←' },
  { value: 'right', label: '右侧', arrow: '→' },
  { value: 'top', label: '上方', arrow: '↑' },
  { value: 'bottom', label: '下方', arrow: '↓' },
];
const fieldClass =
  'rounded-control border border-neutral-60 bg-neutral-40 px-2.5 py-2 text-[12px] text-neutral-110 outline-none focus:border-blue-40 disabled:opacity-50';
function edgeArrow(edge: InputEdge) {
  return edges.find((e) => e.value === edge)?.arrow ?? '→';
}
function untilText(until: number | undefined) {
  return until ? new Date(until).toLocaleTimeString() : '';
}
function statusError(code: string | undefined) {
  return code ? new ActionError({ code }).message : '';
}
function phaseLabel(phase: InputStatus['phase']) {
  return phaseText[phase];
}

export default function InputSharingDialog(props: {
  peers: PeerView[];
  activePeerId: string;
  onClose: () => void;
}) {
  const model = vm({
    status: EMPTY,
    loading: true,
    busy: false,
    error: '',
    role: 'server' as 'server' | 'client',
    edge: 'right' as InputEdge,
    peerId: props.activePeerId,
  });
  let mounted = true;
  let sequence = 0;

  async function refresh() {
    const version = ++sequence;
    const [error, status] = await inputStatus({ toastError: false });
    if (!mounted || version !== sequence) return;
    if (error) {
      model.error = new ActionError(error).message;
      model.loading = false;
      return;
    }
    if (!status) return;
    if (model.loading) {
      model.role = status.settings.role;
      model.edge = status.settings.edge;
    }
    model.status = status;
    model.loading = false;
  }

  async function run(action: () => ReturnType<typeof inputStatus>) {
    if (model.busy) return;
    model.busy = true;
    model.error = '';
    ++sequence;
    try {
      const [error, status] = await action();
      if (!mounted) return;
      if (error) model.error = new ActionError(error).message;
      else if (status) model.status = status;
    } finally {
      if (mounted) model.busy = false;
    }
  }

  async function enable() {
    await run(async () => {
      const [error] = await inputConfigure({
        input: { role: model.role, edge: model.edge },
        toastError: false,
      });
      if (error) return [error];
      const result = await inputEnable({ toastError: false });
      if (result[0] || model.role !== 'client' || !model.peerId) return result;
      return inputConnect({ input: { peerId: model.peerId }, toastError: false });
    });
  }

  onMount(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!model.busy) void refresh();
    }, 1000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  });

  return (
    <Dialog title="键鼠共享" size="wide" onClose={props.onClose}>
      <div className="flex flex-col gap-4 text-[12px] text-neutral-90">
        <p className="m-0 leading-relaxed">
          两台 Mac 共用一套键鼠。服务端提供键鼠，客户端接收控制，双方均需使用单显示器。
        </p>
        {model.loading && <p role="status">正在读取本机状态…</p>}
        {!model.loading && !model.status.supported && (
          <p className="rounded-control border border-neutral-50 bg-neutral-20 p-3">
            当前系统暂不支持键鼠共享。首版支持 macOS 的 Apple Silicon 和 Intel
            机型，聊天与文件传输仍可正常使用。
          </p>
        )}
        {!model.loading && model.status.supported && (
          <>
            {!model.status.available && (
              <p className="text-red-40">
                未找到原生组件，请重新安装 lanfly，并确认安装时允许可选依赖。
              </p>
            )}
            {model.status.available && (
              <div className="rounded-control border border-neutral-50 bg-neutral-20 p-3 text-[11px] leading-relaxed">
                <div>
                  辅助功能：{model.status.accessibility ? '已授权' : '未授权'} · 输入监控：
                  {model.status.inputMonitoring ? '已授权' : '未授权'} · 显示器：
                  {model.status.screens} 个
                </div>
                {model.status.screens !== 1 && (
                  <p className="mb-0 text-red-40">暂不支持多显示器，请断开外接显示器后重试。</p>
                )}
                {(!model.status.accessibility || !model.status.inputMonitoring) && (
                  <div className="mt-2 flex flex-col items-start gap-2">
                    <span>
                      请在“系统设置 → 隐私与安全性”中授权运行 lanfly 的终端或 Node
                      进程。授权后可能需要重启 lanfly。
                    </span>
                    <Button
                      variant="secondary"
                      disabled={model.busy}
                      on:click={() => void run(() => inputPermissions({ toastError: false }))}
                    >
                      请求系统授权
                    </Button>
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                本机角色
                <select
                  value={model.role}
                  disabled={model.status.enabled || model.busy}
                  className={fieldClass}
                  on:change={(e) => {
                    model.role = e.target.value as 'server' | 'client';
                  }}
                >
                  <option value="server">服务端 · 提供键鼠</option>
                  <option value="client">客户端 · 接收控制</option>
                </select>
              </label>
              {model.role === 'server' && (
                <label className="flex flex-col gap-1.5">
                  客户端位于本机
                  <select
                    value={model.edge}
                    disabled={model.status.enabled || model.busy}
                    className={fieldClass}
                    on:change={(e) => {
                      model.edge = e.target.value as InputEdge;
                    }}
                  >
                    <option value="left">← 左侧</option>
                    <option value="right">→ 右侧</option>
                    <option value="top">↑ 上方</option>
                    <option value="bottom">↓ 下方</option>
                  </select>
                </label>
              )}
              {model.role === 'client' && (
                <label className="flex flex-col gap-1.5">
                  连接服务端
                  <select
                    value={model.peerId}
                    disabled={model.status.enabled || model.busy}
                    className={fieldClass}
                    on:change={(e) => {
                      model.peerId = e.target.value;
                    }}
                  >
                    <option value="">
                      {model.status.pairedName
                        ? `已配对：${model.status.pairedName}`
                        : '请选择一台设备'}
                    </option>
                    {props.peers.map((peer) => (
                      <option key={peer.id} value={peer.id}>
                        {peer.name}
                        {peer.online ? '' : '（离线）'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {model.role === 'server' && (
              <div
                className={`flex items-center justify-center gap-4 rounded-control border border-neutral-50 bg-neutral-20 py-4 text-neutral-100 ${model.edge === 'left' ? 'flex-row-reverse' : model.edge === 'top' ? 'flex-col-reverse' : model.edge === 'bottom' ? 'flex-col' : 'flex-row'}`}
              >
                <span className="rounded-control border border-neutral-60 px-4 py-3">
                  本机 · 服务端
                </span>
                <span className="text-xl text-blue-40">{edgeArrow(model.edge)}</span>
                <span className="rounded-control border border-neutral-60 px-4 py-3">
                  另一台 Mac
                </span>
              </div>
            )}
            <div className="rounded-control border border-neutral-50 p-3" aria-live="polite">
              <div className="flex items-center gap-2 font-medium text-neutral-110">
                <span
                  className={`size-2 rounded-full ${model.status.phase === 'connected' ? 'bg-green-40' : 'bg-neutral-70'}`}
                />
                {phaseLabel(model.status.phase)}
                {model.status.peerName && <span>· {model.status.peerName}</span>}
              </div>
              {model.status.phase === 'connected' && (
                <p className="mb-0 text-[11px]">
                  {model.status.controlling ? '键鼠正在客户端上使用' : '键鼠在服务端本机'}
                  。移动到相邻屏幕边缘即可切换。
                </p>
              )}
              {model.status.phase === 'waiting' && (
                <p className="mb-0 text-[11px]">
                  {model.role === 'server'
                    ? '请在另一台 Mac 的 WebUI 中选择“客户端”并连接本机。'
                    : '正在等待服务端；请确认对方已启用共享。'}
                </p>
              )}
              {model.status.pairingUntil && model.status.phase !== 'pairing' && (
                <p className="mb-0 text-[11px]">
                  允许首次配对至 {untilText(model.status.pairingUntil)}。
                </p>
              )}
              {model.status.phase === 'pairing' && model.status.pairingCode && (
                <div className="mt-3 flex flex-col items-start gap-3">
                  <span>请核对两台 Mac 的校验码完全相同，再分别确认：</span>
                  <strong className="font-mono text-2xl tracking-[0.25em] text-neutral-110">
                    {model.status.pairingCode}
                  </strong>
                  <Button
                    variant="primary"
                    disabled={model.busy || model.status.confirmed}
                    on:click={() =>
                      void run(() =>
                        inputConfirm({
                          input: { code: model.status.pairingCode! },
                          toastError: false,
                        }),
                      )
                    }
                  >
                    {model.status.confirmed ? '已确认，等待对方' : '两端校验码相同，确认配对'}
                  </Button>
                </div>
              )}
              {model.status.error && (
                <p className="mb-0 text-red-40">{statusError(model.status.error)}</p>
              )}
            </div>
            <p className="m-0 text-[11px] leading-relaxed text-neutral-80">
              紧急停止：在任一台 Mac 按 Ctrl + Option + Command + Esc。关闭网页会继续共享；退出
              lanfly
              后停止。配对和位置会保存，正常退出后下次启动自动恢复共享；手动停止或紧急停止会关闭自动恢复。不包含剪贴板同步。
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              {model.status.pairedName && (
                <Button
                  variant="ghost"
                  disabled={model.busy}
                  on:click={() => void run(() => inputForget({ toastError: false }))}
                >
                  解除与 {model.status.pairedName} 的配对
                </Button>
              )}
              {model.status.enabled &&
                model.role === 'server' &&
                !model.status.pairedName &&
                !model.status.pairingUntil &&
                model.status.phase === 'waiting' && (
                  <Button
                    variant="secondary"
                    disabled={model.busy}
                    on:click={() => void run(() => inputPairing({ toastError: false }))}
                  >
                    允许首次配对
                  </Button>
                )}
              {model.status.enabled ? (
                <Button
                  variant="secondary"
                  disabled={model.busy}
                  on:click={() => void run(() => inputDisable({ toastError: false }))}
                >
                  停止共享
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={
                    model.busy ||
                    !model.status.available ||
                    !model.status.accessibility ||
                    !model.status.inputMonitoring ||
                    model.status.screens !== 1 ||
                    (model.role === 'client' && !model.peerId && !model.status.pairedName)
                  }
                  on:click={() => void enable()}
                >
                  {model.busy ? '正在启用…' : '保存并启用'}
                </Button>
              )}
            </div>
          </>
        )}
        {model.error && (
          <p role="alert" className="m-0 text-red-40">
            {model.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
