const ACTION_ERROR = Symbol('lanfly-action-error');

export interface ActionFailure {
  code: string;
}

export function throwActionError(code: string): never {
  throw {
    [ACTION_ERROR]: true,
    code,
  };
}

export function isActionFailure(error: unknown): error is ActionFailure {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, boolean>)[ACTION_ERROR] === true
  );
}

export function errorCode(error: unknown, fallback = 'INTERNAL_ERROR'): string {
  return isActionFailure(error) ? error.code : fallback;
}

export const ErrorCodes = {
  INVALID_INPUT: 'INVALID_INPUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  PEER_NOT_FOUND: 'PEER_NOT_FOUND',
  PEER_OFFLINE: 'PEER_OFFLINE',
  PEER_UNREACHABLE: 'PEER_UNREACHABLE',
  PEER_UNAUTHORIZED: 'PEER_UNAUTHORIZED',
  PEER_PROTOCOL: 'PEER_PROTOCOL',
  PEER_HTTP_ERROR: 'PEER_HTTP_ERROR',
  SECRET_MISMATCH: 'SECRET_MISMATCH',
  SELF_CONNECT: 'SELF_CONNECT',
  ADDRESS_INVALID: 'ADDRESS_INVALID',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  MESSAGE_NOT_RETRYABLE: 'MESSAGE_NOT_RETRYABLE',
  TRANSFER_NOT_FOUND: 'TRANSFER_NOT_FOUND',
  TRANSFER_STATE: 'TRANSFER_STATE',
  TRANSFER_DUPLICATE: 'TRANSFER_DUPLICATE',
  TRANSFER_TOKEN_INVALID: 'TRANSFER_TOKEN_INVALID',
  TRANSFER_CANCELED: 'TRANSFER_CANCELED',
  TRANSFER_UPLOAD_FAILED: 'TRANSFER_UPLOAD_FAILED',
  DOWNLOAD_DIR_ERROR: 'DOWNLOAD_DIR_ERROR',
  DISK_ERROR: 'DISK_ERROR',
} as const;
