import { t } from 'jinge';

import type { Toast } from '../types';

import Button from './Button';

export default function Toasts(props: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed right-5 bottom-24 z-50 flex w-[min(380px,calc(100vw-40px))] flex-col gap-2">
      {props.toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2.5 rounded-popup border px-3 py-2.5 text-[11.5px] leading-relaxed shadow-menu ${
            toast.kind === 'error'
              ? 'border-red-30 bg-red-10 text-red-50'
              : toast.kind === 'success'
                ? 'border-green-30 bg-green-10 text-green-40'
                : 'border-neutral-50 bg-neutral-30 text-neutral-100'
          }`}
        >
          <span
            className={`mt-px text-[14px] ${
              toast.kind === 'error'
                ? 'icon-[codicon--error]'
                : toast.kind === 'success'
                  ? 'icon-[codicon--check]'
                  : 'icon-[codicon--info]'
            }`}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 break-words">{toast.text}</span>
          <Button
            size="bare"
            className="-mt-1 -mr-1 shrink-0 p-1 text-[14px] opacity-60 hover:opacity-100"
            aria-label={t('关闭提示')}
            on:click={() => props.onDismiss(toast.id)}
          >
            <span className="icon-[codicon--close]" aria-hidden="true" />
          </Button>
        </div>
      ))}
    </div>
  );
}
