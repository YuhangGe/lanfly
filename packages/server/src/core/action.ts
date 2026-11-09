import type { ActionResult } from '@lanfly/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';

import type { Application } from '../app';

export interface ActionContext {
  app: Application;
  request: IncomingMessage;
  response: ServerResponse;
}

export interface ServerAction {
  input?: z.ZodType;
  fn: (context: ActionContext, input?: unknown) => Promise<unknown>;
}

export interface ClientActionOptions {
  toastError?: boolean;
}

type ClientActionCall<O> = (options?: ClientActionOptions) => Promise<ActionResult<O>>;
type ClientActionCallWithInput<I extends z.ZodType, O> = (
  options: ClientActionOptions & {
    input: z.input<I>;
  },
) => Promise<ActionResult<O>>;

export function defineAction<O>(
  fn: (context: ActionContext) => Promise<O>,
): ClientActionCall<O> & ServerAction;
export function defineAction<I extends z.ZodType, O>(
  input: I,
  fn: (context: ActionContext, input: z.output<I>) => Promise<O>,
): ClientActionCallWithInput<I, O> & ServerAction;
export function defineAction(
  inputOrFn: z.ZodType | ((context: ActionContext) => Promise<unknown>),
  maybeFn?: (context: ActionContext, input: unknown) => Promise<unknown>,
): ServerAction {
  if (typeof inputOrFn === 'function') {
    return {
      fn: (context) => inputOrFn(context),
    };
  }
  if (!maybeFn) throw new Error('defineAction 缺少 action 函数');
  return {
    input: inputOrFn,
    fn: (context, input) => maybeFn(context, input),
  };
}
