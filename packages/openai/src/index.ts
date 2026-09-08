// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * themis-policy-openai — adapter for OpenAI function calling / tool calling.
 *
 * OpenAI's chat completions emit tool_calls blocks of the form:
 *   { id, type: 'function', function: { name, arguments: <JSON string> } }
 *
 * Applications execute the named function and return a tool message:
 *   { role: 'tool', tool_call_id: id, content: <JSON string> }
 *
 * This adapter intercepts a tool_call, runs Themis, and returns the
 * corresponding OpenAI tool message. The function arguments (JSON string
 * in OpenAI's format) are parsed for policy evaluation but passed back
 * through as-is to the underlying handler on `allow`.
 */

import type {
  IAction,
  IPolicyContext,
  IPolicyEngine,
  IRequestor,
} from 'themis-policy';
import { isAllow, isDeny, isRedirect, isRequireApproval } from 'themis-policy';

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    /** JSON-encoded string per the OpenAI API. */
    readonly arguments: string;
  };
}

export interface OpenAIToolMessage {
  readonly role: 'tool';
  readonly tool_call_id: string;
  readonly content: string;
}

export type OpenAIToolHandler = (args: unknown) => Promise<unknown> | unknown;

export interface GateOpenAIOptions {
  readonly engine: IPolicyEngine;
  readonly requestorFrom: (toolCall: OpenAIToolCall, parsedArgs: unknown) => IRequestor;
  readonly actionFrom: (toolCall: OpenAIToolCall, parsedArgs: unknown) => IAction;
  readonly entityFrom?: (toolCall: OpenAIToolCall, parsedArgs: unknown) =>
    | Promise<IPolicyContext['entity']>
    | IPolicyContext['entity'];
  readonly correlationIdFrom?: (toolCall: OpenAIToolCall) => string;
  readonly now?: () => number;
}

export interface GatedOpenAIHandlers {
  execute(toolCall: OpenAIToolCall): Promise<OpenAIToolMessage>;
}

export function gateToolCalls(
  handlers: Readonly<Record<string, OpenAIToolHandler>>,
  opts: GateOpenAIOptions,
): GatedOpenAIHandlers {
  const now = opts.now ?? Date.now;

  async function execute(toolCall: OpenAIToolCall): Promise<OpenAIToolMessage> {
    const handler = handlers[toolCall.function.name];
    if (!handler) {
      return toolMsg(toolCall.id, `[themis] unknown tool '${toolCall.function.name}'`);
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = toolCall.function.arguments
        ? JSON.parse(toolCall.function.arguments)
        : {};
    } catch (err) {
      return toolMsg(toolCall.id, `[themis] invalid JSON arguments: ${formatError(err)}`);
    }

    const requestor = opts.requestorFrom(toolCall, parsedArgs);
    const action = opts.actionFrom(toolCall, parsedArgs);
    const entity = opts.entityFrom ? await opts.entityFrom(toolCall, parsedArgs) : null;
    const correlation_id =
      opts.correlationIdFrom?.(toolCall) ?? toolCall.id;

    const ctx: IPolicyContext = {
      requestor,
      action,
      entity: entity ?? null,
      now: now(),
      correlation_id,
    };

    const decision = await opts.engine.evaluate(ctx);

    if (isAllow(decision)) {
      try {
        const result = await handler(parsedArgs);
        return toolMsg(toolCall.id, stringify(result));
      } catch (err) {
        return toolMsg(toolCall.id, `[error] ${formatError(err)}`);
      }
    }
    if (isDeny(decision)) {
      const msg = decision.message
        ? `[themis] ${decision.policy}: ${decision.message}`
        : `[themis] ${decision.policy}: ${decision.reason}`;
      return toolMsg(toolCall.id, msg);
    }
    if (isRedirect(decision)) {
      return toolMsg(
        toolCall.id,
        JSON.stringify({
          themis_redirect: true,
          policy: decision.policy,
          target: decision.target,
          payload: decision.payload,
        }),
      );
    }
    if (isRequireApproval(decision)) {
      return toolMsg(
        toolCall.id,
        JSON.stringify({
          themis_approval_pending: true,
          policy: decision.policy,
          approval_ref: decision.approval_ref,
          message: decision.message,
        }),
      );
    }
    return toolMsg(toolCall.id, '[themis] unknown policy decision kind');
  }

  return { execute };
}

function toolMsg(tool_call_id: string, content: string): OpenAIToolMessage {
  return { role: 'tool', tool_call_id, content };
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
