import type { InputEdge, InputStatus, PeerView } from '@lanfly/common';

import {
  inputConnect,
  inputDisable,
  inputForget,
  inputPermissions,
  inputRefresh,
  inputStatus,
} from '@server';
import { onMount, t, vm } from 'jinge';

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
};
function phaseLabel(phase: InputStatus['phase']) {
  switch (phase) {
    case 'disabled':
      return t('已停止');
    case 'waiting':
      return t('等待连接');
    case 'connecting':
      return t('正在连接');
    case 'connected':
      return t('已连接');
  }
}

const fieldClass =
  'rounded-control border border-neutral-60 bg-neutral-40 px-2.5 py-2 text-[12px] text-neutral-110 outline-none focus:border-blue-40 disabled:opacity-50';
function statusError(code: string) {
  return new ActionError({ code }).message;
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
    peerId: props.peers.find((p) => p.id === props.activePeerId && p.kind !== 'browser')?.id ?? '',
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
    if (
      model.loading ||
      status.settings.role !== model.status.settings.role ||
      status.settings.edge !== model.status.settings.edge
    ) {
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
      else if (status) {
        model.status = status;
        model.role = status.settings.role;
        model.edge = status.settings.edge;
      }
    } finally {
      if (mounted) model.busy = false;
    }
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
    <Dialog title={t('键鼠共享')} size="wide" onClose={props.onClose}>
      <div className="flex flex-col gap-4 text-[12px] text-neutral-90">
        <p className="m-0 leading-relaxed">
          {t(
            '两台单屏 Mac 共用一套键鼠。选择本机角色后连接，对方自动使用相反角色，无需配对或确认校验码。',
          )}
        </p>
        {model.loading && <p role="status">{t('正在读取本机状态…')}</p>}
        {!model.loading && !model.status.supported && (
          <p>{t('当前系统暂不支持键鼠共享；聊天与文件传输仍可使用。')}</p>
        )}
        {!model.loading && model.status.supported && (
          <>
            {!model.status.available && (
              <p className="text-red-40">
                {t('未找到原生组件，请重新安装 lanfly，并允许安装可选依赖。')}
              </p>
            )}
            {model.status.available && (
              <div className="rounded-control border border-neutral-50 bg-neutral-20 p-3 text-[11px] leading-relaxed">
                <div>
                  {t(
                    '辅助功能：{accessibility} · 输入监控：{inputMonitoring} · 显示器：{screens} 个',
                    {
                      accessibility: model.status.accessibility ? t('已授权') : t('未授权'),
                      inputMonitoring: model.status.inputMonitoring ? t('已授权') : t('未授权'),
                      screens: model.status.screens,
                    },
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    disabled={model.busy}
                    on:click={() => void run(() => inputRefresh({ toastError: false }))}
                  >
                    {t('刷新权限')}
                  </Button>
                  {(!model.status.accessibility || !model.status.inputMonitoring) && (
                    <Button
                      variant="secondary"
                      disabled={model.busy}
                      on:click={() => void run(() => inputPermissions({ toastError: false }))}
                    >
                      {t('请求系统授权')}
                    </Button>
                  )}
                </div>
                {(!model.status.accessibility || !model.status.inputMonitoring) && (
                  <p className="mb-0">
                    {t(
                      '请在系统设置中授权运行 lanfly 的终端或 Node 进程，再点击“刷新权限”，无需重启。',
                    )}
                  </p>
                )}
                {model.status.screens !== 1 && (
                  <p className="mb-0 text-red-40">
                    {t('双方均需一个活动显示器，请断开外接显示器后重试。')}
                  </p>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                {t('本机角色')}
                <select
                  value={model.role}
                  disabled={model.busy}
                  className={fieldClass}
                  on:change={(e) => {
                    model.role = e.target.value as 'server' | 'client';
                  }}
                >
                  <option value="server">{t('服务端 · 提供键鼠')}</option>
                  <option value="client">{t('客户端 · 接收控制')}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                {t('连接设备')}
                <select
                  value={model.peerId}
                  disabled={model.busy}
                  className={fieldClass}
                  on:change={(e) => {
                    model.peerId = e.target.value;
                  }}
                >
                  <option value="">{t('请选择一台设备')}</option>
                  {props.peers
                    .filter((p) => p.kind !== 'browser')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.online ? '' : t('（离线）')}
                      </option>
                    ))}
                </select>
              </label>
              <label className="col-span-2 flex flex-col gap-1.5">
                {t('客户端位于服务端')}
                <select
                  value={model.edge}
                  disabled={model.busy}
                  className={fieldClass}
                  on:change={(e) => {
                    model.edge = e.target.value as InputEdge;
                  }}
                >
                  <option value="left">{t('← 左侧')}</option>
                  <option value="right">{t('→ 右侧')}</option>
                  <option value="top">{t('↑ 上方')}</option>
                  <option value="bottom">{t('↓ 下方')}</option>
                </select>
              </label>
            </div>
            <div className="rounded-control border border-neutral-50 p-3" aria-live="polite">
              <strong>
                {phaseLabel(model.status.phase)}
                {model.status.peerName ? ` · ${model.status.peerName}` : ''}
              </strong>
              {model.status.phase === 'connected' && (
                <p className="mb-0">
                  {model.status.controlling ? t('键鼠正在客户端上使用。') : t('键鼠在服务端本机。')}
                  {t('移到相邻屏幕边缘即可切换。')}
                </p>
              )}
              {model.status.error && (
                <p className="mb-0 text-red-40">{statusError(model.status.error)}</p>
              )}
            </div>
            <p className="m-0 text-[11px] leading-relaxed text-neutral-80">
              {t(
                '双方授权后，同 Room ID 的主机可直接连接。一次只连接一台设备。Ctrl + Option + Command + Esc 可停止双方共享。连接和位置会保存，同一 Room ID 再次启动时自动恢复；手动停止会关闭自动恢复。不包含剪贴板同步。',
              )}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              {model.status.targetName && (
                <Button
                  variant="ghost"
                  disabled={model.busy}
                  on:click={() => void run(() => inputForget({ toastError: false }))}
                >
                  {t('清除已保存连接')}
                </Button>
              )}
              {model.status.enabled && (
                <Button
                  variant="secondary"
                  disabled={model.busy}
                  on:click={() => void run(() => inputDisable({ toastError: false }))}
                >
                  {t('停止共享')}
                </Button>
              )}
              <Button
                variant="primary"
                disabled={
                  model.busy ||
                  !model.peerId ||
                  !model.status.available ||
                  !model.status.accessibility ||
                  !model.status.inputMonitoring ||
                  model.status.screens !== 1
                }
                on:click={() =>
                  void run(() =>
                    inputConnect({
                      input: { peerId: model.peerId, role: model.role, edge: model.edge },
                      toastError: false,
                    }),
                  )
                }
              >
                {model.busy ? t('正在连接…') : t('连接')}
              </Button>
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
