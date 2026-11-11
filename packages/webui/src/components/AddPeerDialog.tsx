import Button from './Button';
import Dialog, { DialogActions } from './Dialog';

export default function AddPeerDialog(props: {
  address: string;
  busy: boolean;
  error: string;
  onAddress: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title="添加设备"
      descriptionId="add-peer-description"
      canClose={!props.busy}
      onClose={props.onClose}
    >
      <form
        on:submit={(event) => {
          event.preventDefault();
          if (!props.busy) props.onSubmit();
        }}
      >
        <p id="add-peer-description" className="m-0 text-[11.5px] leading-relaxed text-neutral-90">
          输入对方运行 lanfly 的地址。组播被网络禁用时，可以用这种方式主动建立连接。
        </p>
        <label className="mt-4 flex flex-col gap-1.5 text-[11px] text-neutral-90">
          设备地址
          <input
            data-dialog-initial-focus
            value={props.address}
            placeholder="192.168.1.23 或 192.168.1.23:8087"
            autoComplete="off"
            spellCheck={false}
            disabled={props.busy}
            on:input={(event) => props.onAddress(event.target.value)}
            className="w-full rounded-control border border-neutral-60 bg-neutral-40 px-2.5 py-2 text-[12.5px] text-neutral-110 outline-none placeholder:text-neutral-70 focus:border-blue-40 disabled:opacity-50"
          />
        </label>
        <div className="mt-2 min-h-4 text-[11px] text-red-40">{props.error}</div>
        <div className="mt-1 rounded-control border border-neutral-50 bg-neutral-20 px-2.5 py-2 text-[10.5px] leading-relaxed text-neutral-80">
          端口不是 8087 时请写成 <code className="text-neutral-100">IP:端口</code>
          。两台主机需使用相同的 <code className="text-neutral-100">Room ID</code>
          ；不同 Room ID 的主机无法互连。
        </div>
        <DialogActions>
          <Button variant="secondary" disabled={props.busy} on:click={props.onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={props.busy || !props.address.trim()}>
            {props.busy ? (
              <>
                <span
                  className="mr-1 icon-[codicon--loading] inline-block animate-spin align-middle"
                  aria-hidden="true"
                />
                连接中…
              </>
            ) : (
              '连接'
            )}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
