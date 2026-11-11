import { formatBytes, formatClock, type TransferView } from '@lanfly/common';
import { t } from 'jinge';

import type { UiMessage } from '../types';

import { ActionError } from '../service/action';
import Button from './Button';

const ARCHIVE = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'];
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const CODE = ['js', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'md', 'py', 'rs', 'go', 'sh', 'c'];
const TEXT = ['txt', 'log', 'csv'];

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ARCHIVE.includes(ext)) return 'icon-[codicon--file-zip]';
  if (IMAGE.includes(ext)) return 'icon-[codicon--file-media]';
  if (ext === 'pdf') return 'icon-[codicon--file-pdf]';
  if (CODE.includes(ext)) return 'icon-[codicon--file-code]';
  if (TEXT.includes(ext)) return 'icon-[codicon--file-text]';
  return 'icon-[codicon--file]';
}

function isActive(transfer: TransferView | undefined): boolean {
  if (transfer?.expired) return false;
  return (
    transfer?.status === 'offering' ||
    transfer?.status === 'ready' ||
    transfer?.status === 'sending' ||
    transfer?.status === 'receiving'
  );
}

function percent(transfer: TransferView | undefined): number {
  if (!transfer) return 0;
  if (transfer.status === 'completed') return 100;
  if (transfer.file.size <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((transfer.bytes / transfer.file.size) * 100)));
}

function errorLabel(code: string): string {
  return new ActionError({ code }).message;
}

function transferLabel(transfer: TransferView | undefined): string {
  if (!transfer) return t('文件');
  if (transfer.expired) return t('下载邀请已过期');
  switch (transfer.status) {
    case 'offering':
      return t('等待对方确认…');
    case 'ready':
      return transfer.deferred
        ? transfer.direction === 'out'
          ? t('等待对方下载 · 邀请有效 30 分钟')
          : t('点击下载 · 发送页面需在线')
        : t('准备发送…');
    case 'sending':
      return transfer.direction === 'out' ? t('发送中…') : t('接收中…');
    case 'receiving':
      return t('接收中…');
    case 'completed':
      if (transfer.direction === 'out') {
        if (!transfer.expiresAt) return t('已送达');
        return transfer.downloadedAt ? t('对方已下载') : t('等待对方下载');
      }
      if (!transfer.downloadUrl) return t('已保存到下载目录');
      return transfer.downloadedAt ? t('已下载 · 发送页面在线时可再次下载') : t('可下载');
    case 'failed':
      return transfer.direction === 'out' ? t('发送失败') : t('接收失败');
    case 'canceled':
      return t('已取消');
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // LAN pages are often not a secure context; fall through to execCommand.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export default function MessageItem(props: {
  message: UiMessage;
  onRetry: (messageId: string) => void;
  onCancel: (transferId: string) => void;
  onCopied?: (copied: boolean) => void;
}) {
  const copyable = props.message.kind === 'text' && Boolean(props.message.text);
  let pressTimer: number | undefined;
  let pressStartX = 0;
  let pressStartY = 0;
  let pressMoved = false;

  function clearPress() {
    if (pressTimer !== undefined) {
      window.clearTimeout(pressTimer);
      pressTimer = undefined;
    }
  }

  async function copyMessage() {
    if (!copyable || !props.message.text) return;
    props.onCopied?.(await writeClipboard(props.message.text));
  }

  function pressStart(event: PointerEvent) {
    if (!copyable || event.pointerType !== 'touch') return;
    clearPress();
    pressMoved = false;
    pressStartX = event.clientX;
    pressStartY = event.clientY;
    pressTimer = window.setTimeout(() => {
      pressTimer = undefined;
      if (!pressMoved) void copyMessage();
    }, 520);
  }

  function pressMove(event: PointerEvent) {
    if (pressTimer === undefined) return;
    if (Math.hypot(event.clientX - pressStartX, event.clientY - pressStartY) > 8) {
      pressMoved = true;
      clearPress();
    }
  }

  function pressEnd() {
    clearPress();
  }

  return (
    <div
      className={`message-enter flex w-full ${props.message.direction === 'out' ? 'justify-end' : 'justify-start'}`}
      data-message-id={props.message.id}
    >
      <div
        className={`group relative flex max-w-[min(78%,600px)] min-w-0 flex-col ${props.message.direction === 'out' ? 'items-end' : 'items-start'}`}
      >
        <div
          className={`relative min-w-0 rounded-[11px] px-3 py-2 text-[13px] leading-[1.55] shadow-bubble max-[760px]:select-none max-[760px]:[-webkit-touch-callout:none] ${
            props.message.direction === 'out'
              ? 'rounded-tr-[4px] bg-blue-30 text-white'
              : 'rounded-tl-[4px] border border-neutral-60 bg-neutral-50 text-neutral-110'
          }`}
          on:pointerDown={pressStart}
          on:pointerMove={pressMove}
          on:pointerUp={pressEnd}
          on:pointerCancel={pressEnd}
          on:pointerLeave={pressEnd}
          on:contextMenu={(event: MouseEvent) => {
            if (copyable && window.matchMedia('(pointer: coarse)').matches) event.preventDefault();
          }}
        >
          {props.message.kind === 'text' ? (
            <p className="m-0 break-words whitespace-pre-wrap">{props.message.text}</p>
          ) : (
            <div className="flex w-[min(300px,68vw)] items-center gap-2.5">
              <div
                className={`grid size-9 shrink-0 place-items-center rounded-[8px] ${
                  props.message.direction === 'out'
                    ? 'bg-white/15 text-white'
                    : 'bg-neutral-60 text-blue-40'
                }`}
              >
                <span
                  className={`${fileIcon(props.message.file?.name ?? 'file')} text-[20px]`}
                  aria-hidden="true"
                />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-[12.5px] font-medium"
                  title={props.message.file?.name}
                >
                  {props.message.file?.name}
                </div>
                <div
                  className={`mt-0.5 text-[10.5px] ${props.message.direction === 'out' ? 'text-white/70' : 'text-neutral-90'}`}
                >
                  {formatBytes(props.message.file?.size ?? 0)} ·{' '}
                  {transferLabel(props.message.transfer)}
                </div>
                {props.message.transfer?.downloadUrl &&
                  props.message.transfer.status !== 'receiving' &&
                  props.message.transfer.status !== 'canceled' &&
                  !props.message.transfer.expired && (
                    <a
                      className="mt-1 inline-block text-blue-40 underline"
                      href={props.message.transfer.downloadUrl}
                      download
                    >
                      {t('下载文件')}
                    </a>
                  )}
                {isActive(props.message.transfer) &&
                  !(
                    props.message.transfer?.deferred && props.message.transfer.status === 'ready'
                  ) && (
                    <div className="mt-1.5">
                      <div
                        className={`h-1 overflow-hidden rounded-full ${props.message.direction === 'out' ? 'bg-black/25' : 'bg-neutral-60'}`}
                      >
                        <div
                          className={`h-full rounded-full transition-[width] duration-150 ${props.message.direction === 'out' ? 'bg-white/85' : 'bg-blue-40'}`}
                          style={`width:${percent(props.message.transfer)}%`}
                        />
                      </div>
                      <div
                        className={`mt-1 flex items-center justify-between text-[10px] ${props.message.direction === 'out' ? 'text-white/65' : 'text-neutral-90'}`}
                      >
                        <span>
                          {formatBytes(props.message.transfer?.bytes ?? 0)} /{' '}
                          {formatBytes(props.message.transfer?.file.size ?? 0)}
                        </span>
                        <span>{percent(props.message.transfer)}%</span>
                      </div>
                    </div>
                  )}
                {props.message.transfer?.status === 'completed' &&
                  props.message.transfer.direction === 'in' &&
                  props.message.transfer.savedName &&
                  props.message.transfer.savedName !== props.message.file?.name && (
                    <div
                      className="mt-0.5 truncate text-[10px] text-neutral-80"
                      title={props.message.transfer.savedName}
                    >
                      {t('文件名：{name}', { name: props.message.transfer.savedName })}
                    </div>
                  )}
                {props.message.transfer?.status === 'failed' && props.message.transfer.error && (
                  <div
                    className={`mt-0.5 truncate text-[10px] ${props.message.direction === 'out' ? 'text-white/65' : 'text-red-40'}`}
                  >
                    {t('错误：{error}', { error: errorLabel(props.message.transfer.error) })}
                  </div>
                )}
              </div>
              {isActive(props.message.transfer) && props.message.transfer?.id && (
                <Button
                  size="icon"
                  className={`shrink-0 ${props.message.direction === 'out' ? 'text-white/70 hover:bg-white/15 hover:text-white' : 'text-neutral-90 hover:bg-white/10 hover:text-neutral-120'}`}
                  title={t('取消传输')}
                  aria-label={t('取消传输 {name}', { name: props.message.transfer.file.name })}
                  on:click={() => props.onCancel(props.message.transfer?.id ?? '')}
                >
                  <span className="icon-[codicon--close] text-[14px]" aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
        </div>
        {props.message.kind === 'text' && Boolean(props.message.text) && (
          <Button
            size="bare"
            className={`absolute top-1 z-10 grid size-6 place-items-center rounded-[6px] border border-neutral-60 bg-neutral-30 text-neutral-90 opacity-0 shadow-toolbar transition-opacity duration-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-[760px]:hidden ${
              props.message.direction === 'out' ? 'right-full mr-1' : 'left-full ml-1'
            }`}
            title={t('复制消息')}
            aria-label={t('复制消息')}
            on:click={(event) => {
              event.stopPropagation();
              void copyMessage();
            }}
          >
            <span className="icon-[codicon--copy] text-[13px]" aria-hidden="true" />
          </Button>
        )}
        <div
          className={`mt-1 flex items-center gap-1.5 text-[10.5px] text-neutral-80 ${props.message.direction === 'out' ? 'pr-0.5' : 'pl-0.5'}`}
        >
          <span>{formatClock(props.message.createdAt)}</span>
          {props.message.direction === 'out' &&
            props.message.kind === 'text' &&
            props.message.status === 'sending' && (
              <span className="flex items-center gap-1">
                <span
                  className="icon-[codicon--loading] animate-spin text-[11px]"
                  aria-hidden="true"
                />
                {t('发送中')}
              </span>
            )}
          {props.message.direction === 'out' &&
            props.message.kind === 'text' &&
            props.message.status === 'sent' && (
              <span className="flex items-center gap-1 text-green-40">
                <span className="icon-[codicon--check] text-[11px]" aria-hidden="true" />
                {t('已发送')}
              </span>
            )}
          {props.message.direction === 'out' &&
            props.message.kind === 'text' &&
            props.message.status === 'failed' && (
              <span className="flex items-center gap-1 text-red-40">
                <span className="icon-[codicon--error] text-[11px]" aria-hidden="true" />
                {t('发送失败')}
                <button
                  className="cursor-pointer text-blue-40 underline underline-offset-2 hover:text-blue-50"
                  on:click={() => props.onRetry(props.message.id)}
                >
                  {t('重试')}
                </button>
              </span>
            )}
        </div>
      </div>
    </div>
  );
}
