import type { FileUploadRequest, SendFileResult } from '@lanfly/common';

/** Retain File references, not file contents. Re-read only when the receiver asks. */
export class DeferredFiles {
  #files = new Map<string, { file: File; timer: number }>();
  #requests = new Map<string, { request: FileUploadRequest; timer: number }>();
  #uploads = new Map<string, { transferId: string; xhr: XMLHttpRequest }>();
  constructor(readonly onError: (file: File) => void) {}
  hold(result: SendFileResult, file: File): void {
    const previous = this.#files.get(result.transferId);
    if (previous) clearTimeout(previous.timer);
    const timer = window.setTimeout(
      () => this.#files.delete(result.transferId),
      Math.max(0, (result.expiresAt ?? Date.now()) - Date.now()),
    );
    this.#files.set(result.transferId, { file, timer });
    for (const entry of this.#requests.values())
      if (entry.request.transferId === result.transferId) this.request(entry.request);
  }
  request(request: FileUploadRequest): void {
    if (this.#uploads.has(request.sessionId)) return;
    const held = this.#files.get(request.transferId);
    if (!held) {
      // SSE may arrive before the offer RPC returns. Other tabs of this device ignore the request.
      if (!this.#requests.has(request.sessionId))
        this.#requests.set(request.sessionId, {
          request,
          timer: window.setTimeout(() => this.#requests.delete(request.sessionId), 30_000),
        });
      return;
    }
    const waiting = this.#requests.get(request.sessionId);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.#requests.delete(request.sessionId);
    }
    const xhr = new XMLHttpRequest();
    this.#uploads.set(request.sessionId, { transferId: request.transferId, xhr });
    xhr.open('POST', request.uploadUrl, true);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.onload = () => {
      this.#uploads.delete(request.sessionId);
      if (xhr.status !== 200) this.onError(held.file);
    };
    xhr.onerror = () => {
      this.#uploads.delete(request.sessionId);
      this.onError(held.file);
    };
    xhr.onabort = () => this.#uploads.delete(request.sessionId);
    xhr.send(held.file);
  }
  cancel(sessionId: string): void {
    const waiting = this.#requests.get(sessionId);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.#requests.delete(sessionId);
    }
    this.#uploads.get(sessionId)?.xhr.abort();
    this.#uploads.delete(sessionId);
  }
  forget(transferId: string): void {
    const entry = this.#files.get(transferId);
    if (entry) clearTimeout(entry.timer);
    this.#files.delete(transferId);
    for (const [id, pending] of this.#requests)
      if (pending.request.transferId === transferId) this.cancel(id);
    for (const [id, upload] of this.#uploads) if (upload.transferId === transferId) this.cancel(id);
  }
  stop(): void {
    for (const id of this.#files.keys()) this.forget(id);
    for (const id of this.#requests.keys()) this.cancel(id);
    for (const id of this.#uploads.keys()) this.cancel(id);
  }
}
