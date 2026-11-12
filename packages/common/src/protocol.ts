export const LOCAL_RPC_PREFIX = '/__rpc/';
export const SSE_PATH = '/events';
export const LOCAL_UPLOAD_PREFIX = '/api/v1/local/upload/';
export const PEER_API_PREFIX = '/api/v1/peer/';
export const PEER_INFO_PATH = '/api/v1/peer/info';
export const PEER_HELLO_PATH = '/api/v1/peer/hello';
export const PEER_MESSAGES_PATH = '/api/v1/peer/messages';
export const PEER_TRANSFERS_PATH = '/api/v1/peer/transfers';
export const PEER_DESKTOP_PREFIX = '/api/v1/peer/desktop/';
export const PEER_DESKTOP_DISPLAY_PATH = `${PEER_DESKTOP_PREFIX}display`;
export const PEER_DESKTOP_REQUEST_PATH = `${PEER_DESKTOP_PREFIX}request`;
export const PEER_DESKTOP_ACCEPT_PATH = `${PEER_DESKTOP_PREFIX}accept`;
export const PEER_DESKTOP_REJECT_PATH = `${PEER_DESKTOP_PREFIX}reject`;
export const PEER_DESKTOP_OFFER_PATH = `${PEER_DESKTOP_PREFIX}offer`;
export const PEER_DESKTOP_ICE_PATH = `${PEER_DESKTOP_PREFIX}ice`;
export const PEER_DESKTOP_STOP_PATH = `${PEER_DESKTOP_PREFIX}stop`;
export const PEER_DESKTOP_STATE_PATH = `${PEER_DESKTOP_PREFIX}state`;
export const PEER_DESKTOP_ERROR_PATH = `${PEER_DESKTOP_PREFIX}error`;
export const DESKTOP_TOKEN_HEADER = 'x-lanfly-desktop-token';

export function peerTransferPath(transferId: string) {
  return `${PEER_TRANSFERS_PATH}/${encodeURIComponent(transferId)}`;
}
