import type { ChatMessage, FileMeta, MessageStatus, PeerMessagePayload } from '@lanfly/common';

import { randomUUID } from 'node:crypto';

import type { EventHub } from './events';

const MAX_MESSAGES = 4000;

export class MessageStore {
  #messages: ChatMessage[] = [];
  #byId = new Map<string, ChatMessage>();
  #byTransfer = new Map<string, string>();

  constructor(private readonly events: EventHub) {}

  list(): ChatMessage[] {
    return this.#messages.map((message) => ({ ...message }));
  }

  get(id: string): ChatMessage | undefined {
    return this.#byId.get(id);
  }

  addOutgoingText(peerId: string, text: string): ChatMessage {
    return this.#add({
      id: randomUUID(),
      peerId,
      direction: 'out',
      kind: 'text',
      text,
      createdAt: Date.now(),
      status: 'sending',
    });
  }

  addOutgoingFile(peerId: string, file: FileMeta, transferId: string): ChatMessage {
    return this.#add({
      id: randomUUID(),
      peerId,
      direction: 'out',
      kind: 'file',
      file,
      transferId,
      createdAt: Date.now(),
      status: 'sending',
    });
  }

  addIncomingText(peerId: string, payload: PeerMessagePayload): ChatMessage | null {
    if (this.#byId.has(payload.id)) return null;
    return this.#add({
      id: payload.id,
      peerId,
      direction: 'in',
      kind: 'text',
      text: payload.text,
      createdAt: payload.sentAt || Date.now(),
      status: 'sent',
    });
  }

  addIncomingFile(peerId: string, file: FileMeta, transferId: string): ChatMessage {
    return this.#add({
      id: randomUUID(),
      peerId,
      direction: 'in',
      kind: 'file',
      file,
      transferId,
      createdAt: Date.now(),
      status: 'sent',
    });
  }

  setStatus(id: string, status: MessageStatus, error?: string): ChatMessage | undefined {
    const message = this.#byId.get(id);
    if (!message) return undefined;
    message.status = status;
    if (error) message.error = error;
    else if (status !== 'failed') delete message.error;
    this.events.broadcast('message-status', { id, status, error: message.error });
    return { ...message };
  }

  setFileStatusByTransfer(transferId: string, status: MessageStatus, error?: string): void {
    const id = this.#byTransfer.get(transferId);
    if (id) this.setStatus(id, status, error);
  }

  #add(message: ChatMessage): ChatMessage {
    this.#messages.push(message);
    this.#byId.set(message.id, message);
    if (message.transferId) this.#byTransfer.set(message.transferId, message.id);
    if (this.#messages.length > MAX_MESSAGES) {
      const removed = this.#messages.splice(0, this.#messages.length - MAX_MESSAGES);
      for (const item of removed) {
        this.#byId.delete(item.id);
        if (item.transferId) this.#byTransfer.delete(item.transferId);
      }
    }
    this.events.broadcast('message', { ...message });
    return { ...message };
  }
}
