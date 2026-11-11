import type { ActionResult, ActionResultError } from '@lanfly/common';

import { t } from 'jinge';
import { parse, stringify } from 'superjson';

import { browserMode } from '../browser';

const cache = new Map<string, ServerActionFunction>();

const ErrorMessages: Record<string | number, string | (() => string)> = {
  400: () => t('请求参数不正确'),
  401: () => t('没有权限'),
  403: () => t('没有权限'),
  404: () => t('服务端接口不存在'),
  413: () => t('内容过大'),
  500: () => t('本地服务异常，请查看终端日志'),
  502: () => t('对方接收失败'),
  999: () => t('无法连接本地服务，请确认 lanfly 仍在运行'),
};

export function registerErrorMessages(messages: Record<string, string>) {
  // Re-registering after a locale change refreshes locale-dependent error text.
  Object.assign(ErrorMessages, messages);
}

export class ActionError {
  readonly code: string | number;

  constructor(error: ActionResultError | { code: number }) {
    this.code = error.code;
  }

  get message(): string {
    const value = ErrorMessages[this.code] ?? ErrorMessages[999];
    return typeof value === 'function' ? value() : (value ?? '');
  }
}

export interface ServerActionOptions {
  input?: unknown;
  toastError?: boolean;
}

type ServerActionFunction = (options?: ServerActionOptions) => Promise<ActionResult<unknown>>;

function serverError(status: number, toast: boolean) {
  const error = new ActionError({ code: status });
  if (toast) console.error(error.message);
  return error;
}

function actionError(error: ActionResultError, toast: boolean) {
  const result = new ActionError(error);
  if (toast) console.error(result.message);
  return result;
}

function getServerAction(action: string): ServerActionFunction {
  const cached = cache.get(action);
  if (cached) return cached;

  const fn: ServerActionFunction = async ({ input, toastError = true } = {}) => {
    try {
      const body = input === undefined ? undefined : stringify(input);
      const response = await fetch(`${browserMode ? '/api/v1/browser/rpc/' : '/__rpc/'}${action}`, {
        method: 'POST',
        body,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        credentials: 'include',
        cache: 'no-store',
      });
      if (response.status !== 200) {
        return [serverError(response.status, toastError)];
      }
      const text = await response.text();
      const result = parse<[ActionResultError | null, unknown]>(text);
      if (result[0]) return [actionError(result[0], toastError)];
      return [null, result[1]];
    } catch (error) {
      console.error(error);
      return [serverError(999, toastError)];
    }
  };
  cache.set(action, fn);
  return fn;
}

export const rootProxy = new Proxy(
  {},
  {
    get: (_target, property: string) => getServerAction(property),
    set: () => false,
  },
) as Record<string, ServerActionFunction>;
