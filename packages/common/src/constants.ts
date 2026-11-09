export const APP_NAME = 'lanfly';
export const PROTOCOL_VERSION = 1;

export const DEFAULT_PORT = 8087;
export const PORT_ATTEMPTS = 20;

/** 局域网发现使用的 IPv4 组播地址和端口。 */
export const DISCOVERY_GROUP = '239.255.77.87';
export const DISCOVERY_PORT = 53318;
export const ANNOUNCE_INTERVAL_MS = 2_000;
export const PEER_TTL_MS = 8_000;
export const PEER_FORGET_MS = 5 * 60_000;
export const MANUAL_HEARTBEAT_MS = 5_000;
export const ANNOUNCE_MAX_AGE_MS = 5 * 60_000;

export const MAX_NAME_LENGTH = 64;
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_FILE_NAME_LENGTH = 255;
export const MAX_FILE_SIZE = 100 * 1024 ** 3;
export const JSON_BODY_LIMIT = 2 * 1024 * 1024;
export const UPLOAD_TOKEN_TTL_MS = 10 * 60_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const SSE_HEARTBEAT_MS = 25_000;

export const DEFAULT_MIME = 'application/octet-stream';
