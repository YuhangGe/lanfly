import type { FileMeta, TransferDirection, TransferStatus, TransferView } from '@lanfly/common';

import { randomUUID } from 'node:crypto';

import type { EventHub } from './events';

export interface TransferRecord extends TransferView {
  /** 接收方校验上传使用的临时令牌，只存在于服务端内存。 */
  token?: string;
  /** 发送方上传到接收方时携带的令牌。 */
  remoteToken?: string;
  tempPath?: string;
  cancel?: () => void;
  lastProgressAt?: number;
  uploading?: boolean;
}

const PROGRESS_INTERVAL_MS = 80;

export class TransferStore {
  #transfers = new Map<string, TransferRecord>();

  constructor(private readonly events: EventHub) {}

  list(): TransferView[] {
    return [...this.#transfers.values()].map((transfer) => viewOf(transfer));
  }

  get(id: string): TransferRecord | undefined {
    return this.#transfers.get(id);
  }

  createOutgoing(peerId: string, file: FileMeta): TransferRecord {
    const transfer: TransferRecord = {
      id: randomUUID(),
      peerId,
      direction: 'out',
      file,
      status: 'offering',
      bytes: 0,
      createdAt: Date.now(),
    };
    this.#transfers.set(transfer.id, transfer);
    this.#emit(transfer);
    return transfer;
  }

  createIncoming(peerId: string, id: string, file: FileMeta, token: string): TransferRecord {
    const transfer: TransferRecord = {
      id,
      peerId,
      direction: 'in',
      file,
      status: 'receiving',
      bytes: 0,
      createdAt: Date.now(),
      token,
    };
    this.#transfers.set(id, transfer);
    this.#emit(transfer);
    return transfer;
  }

  update(
    id: string,
    patch: Partial<Pick<TransferRecord, 'status' | 'error' | 'savedName' | 'tempPath'>>,
  ): TransferRecord | undefined {
    const transfer = this.#transfers.get(id);
    if (!transfer) return undefined;
    Object.assign(transfer, patch);
    this.#emit(transfer);
    return transfer;
  }

  progress(id: string, bytes: number, force = false): void {
    const transfer = this.#transfers.get(id);
    if (!transfer) return;
    transfer.bytes = bytes;
    const now = Date.now();
    if (!force && transfer.lastProgressAt && now - transfer.lastProgressAt < PROGRESS_INTERVAL_MS) {
      return;
    }
    transfer.lastProgressAt = now;
    this.#emit(transfer);
  }

  complete(id: string, savedName?: string): void {
    const transfer = this.#transfers.get(id);
    if (!transfer) return;
    transfer.status = 'completed';
    transfer.bytes = transfer.file.size;
    if (savedName) transfer.savedName = savedName;
    delete transfer.error;
    this.#emit(transfer);
  }

  fail(id: string, error: string): void {
    const transfer = this.#transfers.get(id);
    if (!transfer || transfer.status === 'completed') return;
    transfer.status = 'failed';
    transfer.error = error;
    this.#emit(transfer);
  }

  cancel(id: string): void {
    const transfer = this.#transfers.get(id);
    if (!transfer || transfer.status === 'completed') return;
    transfer.status = 'canceled';
    this.#emit(transfer);
  }

  setCancel(id: string, cancel: () => void): void {
    const transfer = this.#transfers.get(id);
    if (transfer) transfer.cancel = cancel;
  }

  clearCancel(id: string): void {
    const transfer = this.#transfers.get(id);
    if (transfer) delete transfer.cancel;
  }

  active(): TransferRecord[] {
    return [...this.#transfers.values()].filter(
      (transfer) =>
        transfer.status === 'offering' ||
        transfer.status === 'ready' ||
        transfer.status === 'sending' ||
        transfer.status === 'receiving',
    );
  }

  #emit(transfer: TransferRecord): void {
    this.events.broadcast('transfer', viewOf(transfer));
  }
}

export function viewOf(transfer: TransferRecord): TransferView {
  return {
    id: transfer.id,
    peerId: transfer.peerId,
    direction: transfer.direction as TransferDirection,
    file: { ...transfer.file },
    status: transfer.status as TransferStatus,
    bytes: transfer.bytes,
    createdAt: transfer.createdAt,
    savedName: transfer.savedName,
    error: transfer.error,
  };
}
