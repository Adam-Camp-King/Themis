// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * themis-policy-anthropic — adapter that gates Claude's tool_use blocks through
 * Themis.
 *
 * Pattern: the Claude SDK emits tool_use blocks; applications run the named
 * handler; a tool_result block is returned to Claude. This adapter wraps
 * that pipeline with a Themis policy engine.
 *
 * Shape compatibility: we do NOT import the Anthropic SDK. We accept the
 * public tool_use shape (`type: 'tool_use'`, `id`, `name`, `input`) and
 * return the public tool_result shape (`type: 'tool_result'`, `tool_use_id`,
 * `content`, optional `is_error`). Any SDK that speaks these shapes works.
 *
 * Primary usage:
 *
 *   import Anthropic from '@anthropic-ai/sdk';
 *   import { gateToolHandlers } from 'themis-policy-anthropic';
 *
 *   const gated = gateToolHandlers(
 *     {
 *       send_invoice: async (input) => sendInvoice(input),
 *       delete_record: async (input) => deleteRecord(input),
 *     },
 *     {
 *       engine,
 *       requestorFrom: () => currentAgentAsRequestor,
 *       actionFrom: (tu) => ({
 *         verb: 'invoke',
 *         resource_type: tu.name,
 *         tenant_id: currentTenant,
 *         required_scope: scopesByTool[tu.name],
 *         payload: tu.input,
 *       }),
 *     },
 *   );
 *
 *   // Inside your Claude tool-loop:
 *   for (const block of response.content) {
 *     if (block.type === 'tool_use') {
 *       const result = await gated.execute(block);
 *       // Feed `result` back to Claude
 *     }
 *   }
 */

import type {
  IAction,
  IPolicyContext,
  IPolicyEngine,
  IRequestor,
} from 'themis-policy';
import { isAllow, isDeny, isRedirect, isRequireApproval } from 'themis-policy';

// ----------------------------------------------------------------------------
// Public types — mirror the public Anthropic tool-use shape without
// depending on the SDK.
// ----------------------------------------------------------------------------

export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string | readonly ToolResultContentBlock[];
  readonly is_error?: boolean;
}

/** Content blocks inside a tool_result are either text or image objects. */
export type ToolResultContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: unknown };

export type ToolHandler = (input: unknown) => Promise<unknown> | unknown;

export interface GateOptions {
  readonly engine: IPolicyEngine;
  readonly requestorFrom: (toolUse: ToolUseBlock) => IRequestor;
  readonly actionFrom: (toolUse: ToolUseBlock) => IAction;
  readonly entityFrom?: (toolUse: ToolUseBlock) =>
    | Promise<IPolicyContext['entity']>
    | IPolicyContext['entity'];
  readonly correlationIdFrom?: (toolUse: ToolUseBlock) => string;
  readonly now?: () => number;
}

export interface GatedHandlers {
  execute(toolUse: ToolUseBlock): Promise<ToolResultBlock>;
}

/**
 * Wrap a map of tool handlers with Themis policy evaluation. Returns an
 * object with `execute(toolUse)` that produces Anthropic-shaped
 * tool_result blocks.
 */
export function gateToolHandlers(
  handlers: Readonly<Record<string, ToolHandler>>,
  opts: GateOptions,
): GatedHandlers {
  const now = opts.now ?? Date.now;

  async function execute(toolUse: ToolUseBlock): Promise<ToolResultBlock> {
    // Unknown tool: tell Claude with an error tool_result so it doesn't
    // retry the call or crash the loop.
    const handler = handlers[toolUse.name];
    if (!handler) {
      return errorResult(toolUse.id, `[themis] unknown tool '${toolUse.name}'`);
    }

    const requestor = opts.requestorFrom(toolUse);
    const action = opts.actionFrom(toolUse);
    const entity = opts.entityFrom ? await opts.entityFrom(toolUse) : null;
    const correlation_id =
      opts.correlationIdFrom?.(toolUse) ?? toolUse.id; // default: use the tool_use id

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
        const result = await handler(toolUse.input);
        return okResult(toolUse.id, result);
      } catch (err) {
        // Wrap runtime failures in an error tool_result so Claude can see
        // the error message and reason about next steps.
        return errorResult(toolUse.id, formatError(err));
      }
    }

    if (isDeny(decision)) {
      const msg = decision.message
        ? `[themis] ${decision.policy}: ${decision.message}`
        : `[themis] ${decision.policy}: ${decision.reason}`;
      return errorResult(toolUse.id, msg);
    }

    if (isRedirect(decision)) {
      return okResult(toolUse.id, {
        themis_redirect: true as const,
        policy: decision.policy,
        target: decision.target,
        payload: decision.payload,
        message:
          'This action was redirected to the draft review queue. The change will not go live until approved.',
      });
    }

    if (isRequireApproval(decision)) {
      return okResult(toolUse.id, {
        themis_approval_pending: true as const,
        policy: decision.policy,
        approval_ref: decision.approval_ref,
        message:
          decision.message ??
          'This action requires human approval before it will execute. The request has been queued.',
      });
    }

    // Exhaustiveness guard
    return errorResult(toolUse.id, '[themis] unknown policy decision kind');
  }

  return { execute };
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function okResult(tool_use_id: string, result: unknown): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id,
    content: stringifyResult(result),
  };
}

function errorResult(tool_use_id: string, text: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id,
    content: text,
    is_error: true,
  };
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
