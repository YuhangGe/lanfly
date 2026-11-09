import { formatBytes, formatClock, type TransferView } from '@lanfly/common';

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
  if (!transfer) return '文件';
  switch (transfer.status) {
    case 'offering':
      return '等待对方确认…';
    case 'ready':
      return '准备发送…';
    case 'sending':
      return transfer.direction === 'out' ? '发送中…' : '接收中…';
    case 'receiving':
      return '接收中…';
    case 'completed':
      return transfer.direction === 'out' ? '已送达' : '已保存到下载目录';
    case 'failed':
      return transfer.direction === 'out' ? '发送失败' : '接收失败';
    case 'canceled':
      return '已取消';
  }
}

export default function MessageItem(props: {
  message: UiMessage;
  onRetry: (messageId: string) => void;
  onCancel: (transferId: string) => void;
}) {
  return (
    <div
      className={`message-enter flex w-full ${props.message.direction === 'out' ? 'justify-end' : 'justify-start'}`}
      data-message-id={props.message.id}
    >
      <div
        className={`flex max-w-[min(78%,600px)] min-w-0 flex-col ${props.message.direction === 'out' ? 'items-end' : 'items-start'}`}
      >
        <div
          className={`min-w-0 rounded-[11px] px-3 py-2 text-[13px] leading-[1.55] shadow-bubble ${
            props.message.direction === 'out'
              ? 'rounded-tr-[4px] bg-blue-30 text-white'
              : 'rounded-tl-[4px] border border-neutral-40 bg-neutral-30 text-neutral-100'
          }`}
        >
          {props.message.kind === 'text' ? (
            <p className="m-0 break-words whitespace-pre-wrap">{props.message.text}</p>
          ) : (
            <div className="flex w-[min(300px,68vw)] items-center gap-2.5">
              <div
                className={`grid size-9 shrink-0 place-items-center rounded-[8px] ${
                  props.message.direction === 'out'
                    ? 'bg-white/15 text-white'
                    : 'bg-neutral-40 text-blue-40'
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
                  className={`mt-0.5 text-[10.5px] ${props.message.direction === 'out' ? 'text-white/70' : 'text-neutral-80'}`}
                >
                  {formatBytes(props.message.file?.size ?? 0)} ·{' '}
                  {transferLabel(props.message.transfer)}
                </div>
                {isActive(props.message.transfer) && (
                  <div className="mt-1.5">
                    <div
                      className={`h-1 overflow-hidden rounded-full ${props.message.direction === 'out' ? 'bg-black/25' : 'bg-neutral-50'}`}
                    >
                      <div
                        className={`h-full rounded-full transition-[width] duration-150 ${props.message.direction === 'out' ? 'bg-white/85' : 'bg-blue-40'}`}
                        style={`width:${percent(props.message.transfer)}%`}
                      />
                    </div>
                    <div
                      className={`mt-1 flex items-center justify-between text-[10px] ${props.message.direction === 'out' ? 'text-white/65' : 'text-neutral-80'}`}
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
                      文件名：{props.message.transfer.savedName}
                    </div>
                  )}
                {props.message.transfer?.status === 'failed' && props.message.transfer.error && (
                  <div
                    className={`mt-0.5 truncate text-[10px] ${props.message.direction === 'out' ? 'text-white/65' : 'text-red-40'}`}
                  >
                    错误：{errorLabel(props.message.transfer.error)}
                  </div>
                )}
              </div>
              {isActive(props.message.transfer) && props.message.transfer?.id && (
                <Button
                  size="icon"
                  className={`shrink-0 ${props.message.direction === 'out' ? 'text-white/70 hover:bg-white/15 hover:text-white' : 'text-neutral-80 hover:bg-white/5 hover:text-neutral-110'}`}
                  title="取消传输"
                  aria-label={`取消传输 ${props.message.transfer.file.name}`}
                  on:click={() => props.onCancel(props.message.transfer?.id ?? '')}
                >
                  <span className="icon-[codicon--close] text-[14px]" aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
        </div>
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
                发送中
              </span>
            )}
          {props.message.direction === 'out' &&
            props.message.kind === 'text' &&
            props.message.status === 'sent' && (
              <span className="flex items-center gap-1 text-green-40">
                <span className="icon-[codicon--check] text-[11px]" aria-hidden="true" />
                已发送
              </span>
            )}
          {props.message.direction === 'out' &&
            props.message.kind === 'text' &&
            props.message.status === 'failed' && (
              <span className="flex items-center gap-1 text-red-40">
                <span className="icon-[codicon--error] text-[11px]" aria-hidden="true" />
                发送失败
                <button
                  className="cursor-pointer text-blue-40 underline underline-offset-2 hover:text-blue-50"
                  on:click={() => props.onRetry(props.message.id)}
                >
                  重试
                </button>
              </span>
            )}
        </div>
      </div>
    </div>
  );
}
