import type { ChatMessage, TransferView } from '@lanfly/common';

export interface UiMessage extends ChatMessage {
  transfer?: TransferView;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}
