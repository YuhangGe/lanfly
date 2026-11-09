export const LOCAL_RPC_PREFIX = '/__rpc/';
export const SSE_PATH = '/events';
export const LOCAL_UPLOAD_PREFIX = '/api/v1/local/upload/';
export const PEER_API_PREFIX = '/api/v1/peer/';
export const PEER_INFO_PATH = '/api/v1/peer/info';
export const PEER_HELLO_PATH = '/api/v1/peer/hello';
export const PEER_MESSAGES_PATH = '/api/v1/peer/messages';
export const PEER_TRANSFERS_PATH = '/api/v1/peer/transfers';

export function peerTransferPath(transferId: string) {
  return `${PEER_TRANSFERS_PATH}/${encodeURIComponent(transferId)}`;
}
