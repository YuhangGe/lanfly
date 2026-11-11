import type { PeerView } from '@lanfly/common';

import { t } from 'jinge';

import Avatar from './Avatar';
import Button from './Button';

export default function PeerList(props: {
  peers: PeerView[];
  readOnly?: boolean;
  activeId: string;
  unread: Record<string, number>;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onReconnect: (peer: PeerView) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1">
      {props.peers.length === 0 && (
        <div className="px-3 py-8 text-center text-[11.5px] leading-relaxed text-neutral-80">
          {t('正在寻找局域网设备…')}
          <br />
          {props.readOnly ? t('等待接入主机发现设备') : t('也可以右上角手动添加 IP')}
        </div>
      )}
      {props.peers.map((peer) => (
        <div
          key={peer.id}
          className={`peer-row group relative flex items-center rounded-[6px] transition-colors ${
            props.activeId === peer.id ? 'bg-neutral-50' : 'hover:bg-white/5'
          } ${peer.online ? '' : 'opacity-65'}`}
        >
          <button
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left"
            on:click={() => props.onSelect(peer.id)}
            title={`${peer.name} · ${peer.host}:${peer.port}`}
          >
            <Avatar name={peer.name} id={peer.id} online={peer.online} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 truncate text-[12.5px] font-medium text-neutral-110">
                  {peer.name}
                </span>
                {peer.manual && (
                  <span
                    className="icon-[codicon--plug] shrink-0 text-[11px] text-neutral-70"
                    title={t('手动添加的设备')}
                    aria-label={t('手动添加的设备')}
                  />
                )}
              </span>
              <span className="mt-0.5 block truncate text-[10.5px] text-neutral-80">
                {peer.online
                  ? peer.kind === 'browser'
                    ? peer.host
                    : `${peer.host}:${peer.port}`
                  : t('离线')}
              </span>
            </span>
            {props.unread[peer.id] > 0 && (
              <span className="ml-1 grid min-w-5 shrink-0 place-items-center rounded-full bg-blue-30 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {props.unread[peer.id] > 99 ? '99+' : props.unread[peer.id]}
              </span>
            )}
          </button>
          {!props.readOnly && peer.kind !== 'browser' && (
            <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5 rounded bg-neutral-40/95 opacity-0 shadow-toolbar transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              {!peer.online && (
                <Button
                  size="icon"
                  className="text-neutral-90 hover:text-blue-40"
                  title={t('重新连接 {name}', { name: peer.name })}
                  aria-label={t('重新连接 {name}', { name: peer.name })}
                  on:click={(event) => {
                    event.stopPropagation();
                    props.onReconnect(peer);
                  }}
                >
                  <span className="icon-[codicon--refresh] text-[14px]" aria-hidden="true" />
                </Button>
              )}
              <Button
                size="icon"
                className="text-neutral-90 hover:text-red-40"
                title={t('移除 {name}', { name: peer.name })}
                aria-label={t('移除 {name}', { name: peer.name })}
                on:click={(event) => {
                  event.stopPropagation();
                  props.onRemove(peer.id);
                }}
              >
                <span className="icon-[codicon--close] text-[14px]" aria-hidden="true" />
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
