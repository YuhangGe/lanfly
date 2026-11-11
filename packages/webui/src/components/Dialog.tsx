import { onMount, ref, t, type JNode } from 'jinge';

import Button from './Button';
import { onChanges } from './reactivity';

/** 原生 <dialog> 负责焦点圈定和 Esc 关闭，组件只同步生命周期。 */
export default function Dialog(props: {
  title: string;
  label?: string;
  children: JNode;
  onClose: () => void;
  canClose?: boolean;
  placement?: 'top' | 'center';
  size?: 'default' | 'compact' | 'wide' | 'screen';
  className?: string;
  descriptionId?: string;
  open?: boolean;
}) {
  const element = ref<HTMLDialogElement>();
  const titleId = `dialog-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

  onMount(() => {
    const dialog = element.value!;
    const previous = document.activeElement;
    if (props.open ?? true) dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]')?.focus();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  });

  onChanges(() => {
    const dialog = element.value!;
    if (props.open ?? true) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [[props, ['open']]]);

  onChanges(() => {
    const dialog = element.value!;
    const backdrop = (event: MouseEvent) => {
      if (!(props.canClose ?? true) || event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      ) {
        props.onClose();
      }
    };
    dialog.addEventListener('mousedown', backdrop);
    return () => dialog.removeEventListener('mousedown', backdrop);
  }, [
    [props, ['canClose']],
    [props, ['onClose']],
  ]);

  return (
    <dialog
      ref={element}
      tabIndex={-1}
      aria-label={props.label ?? props.title}
      aria-labelledby={(props.label ?? props.title) === props.title ? titleId : undefined}
      aria-describedby={props.descriptionId}
      className={`dialog fixed inset-x-0 mx-auto max-h-[calc(100dvh-40px)] overflow-auto rounded-dialog border border-neutral-60 bg-neutral-30 p-5 text-neutral-100 shadow-dialog ${(props.placement ?? 'top') === 'center' ? 'inset-y-0 my-auto' : 'top-[min(17vh,150px)] bottom-auto my-0'} ${(props.size ?? 'default') === 'screen' ? 'w-[min(1080px,calc(100vw-24px))]' : (props.size ?? 'default') === 'wide' ? 'w-[min(580px,calc(100vw-40px))]' : (props.size ?? 'default') === 'compact' ? 'w-[min(320px,calc(100vw-40px))]' : 'w-[min(430px,calc(100vw-40px))]'} ${props.className ?? ''}`}
      on:cancel={(event) => {
        event.preventDefault();
        if (props.canClose ?? true) props.onClose();
      }}
    >
      <div className="mb-5 flex items-center justify-between text-[14px] text-neutral-110">
        <strong id={titleId}>{props.title}</strong>
        {(props.canClose ?? true) && (
          <Button
            size="bare"
            className="text-[18px] text-neutral-90 hover:text-neutral-110"
            aria-label={t('关闭{title}', { title: props.title })}
            on:click={props.onClose}
          >
            <span className="icon-[codicon--close] align-middle" aria-hidden="true" />
          </Button>
        )}
      </div>
      {props.children}
    </dialog>
  );
}

export function DialogActions(props: { children: JNode }) {
  return <div className="mt-6 flex justify-end gap-2.5">{props.children}</div>;
}
