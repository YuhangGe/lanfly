/** 设备公告和握手时交换的最小身份信息。 */
export interface PeerInfo {
  id: string;
  name: string;
  port: number;
  version: string;
  /** 该设备是否启用了 --secret 密码房间。 */
  secret: boolean;
  /** 浏览器设备通过所属主机转发。 */
  kind?: 'browser';
  gatewayId?: string;
}

export interface SelfInfo extends PeerInfo {
  /** 本机在局域网中的主 IPv4 地址，仅用于界面展示。 */
  host: string;
  /** 浏览器访问地址，通常是 http://127.0.0.1:端口。 */
  url: string;
  /** 收到的文件自动保存到的目录。 */
  downloadsDir: string;
}

export interface PeerView extends PeerInfo {
  host: string;
  lastSeen: number;
  online: boolean;
  /** 是否通过“添加 IP”手动建立，手动设备离线后会保留。 */
  manual: boolean;
}

export interface FileMeta {
  name: string;
  size: number;
  mime: string;
}

export type MessageDirection = 'in' | 'out';
export type MessageKind = 'text' | 'file';
export type MessageStatus = 'sending' | 'sent' | 'failed';

export interface ChatMessage {
  id: string;
  peerId: string;
  direction: MessageDirection;
  kind: MessageKind;
  text?: string;
  file?: FileMeta;
  transferId?: string;
  createdAt: number;
  status: MessageStatus;
  error?: string;
}

export type TransferDirection = 'in' | 'out';
export type TransferStatus =
  | 'offering'
  | 'ready'
  | 'sending'
  | 'receiving'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface TransferView {
  id: string;
  peerId: string;
  direction: TransferDirection;
  file: FileMeta;
  status: TransferStatus;
  bytes: number;
  createdAt: number;
  /** 接收完成后实际保存的文件名。 */
  savedName?: string;
  error?: string;
  downloadUrl?: string;
  expiresAt?: number;
  downloadedAt?: number;
  expired?: boolean;
}

export interface AppState {
  self: SelfInfo;
  peers: PeerView[];
  messages: ChatMessage[];
  transfers: TransferView[];
}

export interface SendFileResult {
  transferId: string;
  uploadUrl: string;
}

export interface ActionResultError {
  code: string | number;
}

export type ActionResult<T> = [ActionResultError | null, T?];
