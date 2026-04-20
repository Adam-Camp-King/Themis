// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * @bounded/mcp — adapter that gates MCP tool invocations through Bounded.
 *
 * MCP (Model Context Protocol) tools are functions an LLM agent calls to
 * take action. This adapter wraps any MCP tool handler so every invocation
 * goes through a Bounded policy engine first.
 *
 * SDK-agnostic by design: works with the official @modelcontextprotocol/sdk,
 * Lastmile's mcp-agent, custom MCP servers, or any function-call interface
 * shaped like (args, context) -> result.
 *
 * Usage:
 *
 *   import { withBounded } from '@bounded/mcp';
 *
 *   const gatedTool = withBounded(sendInvoiceTool, {
 *     engine,
 *     requestorFrom: (mcpCall) => ({
 *       id: mcpCall.agent_id,
 *       kind: 'agent',
 *       tenant_id: mcpCall.tenant_id,
 *       scopes: mcpCall.token.scopes,
 *     }),
 *     actionFrom: (mcpCall) => ({
 *       verb: 'invoke',
 *       resource_type: 'invoice',
 *       tenant_id: mcpCall.tenant_id,
 *       required_scope: 'invoices:write',
 *       payload: mcpCall.args,
 *     }),
 *   });
 *
 * Decision mapping:
 *
 *   allow              -> tool executes, result returned
 *   deny               -> throws MCPPolicyDenied (or returns per `onDenial`)
 *   redirect           -> returns { bounded_redirect: true, target, payload }
 *                         without executing the tool (storage-agnostic; the
 *                         caller persists to drafts via IDraftStore)
 *   require_approval   -> returns { bounded_approval_pending: true, approval_ref }
 */

import type {
  IAction,
  IPolicyContext,
  IPolicyEngine,
  IRequestor,
} from '@bounded/core';
import { isAllow, isDeny, isRedirect, isRequireApproval } from '@bounded/core';

/**
 * Generic MCP tool shape. Input and output are opaque — adapters work with
 * whatever shape the caller's MCP server or SDK uses.
 */
export type MCPTool<Input, Output> = (input: Input) => Promise<Output> | Output;

export interface WithBoundedOptions<Input> {
  readonly engine: IPolicyEngine;

  /** Build an IRequestor from the tool invocation input. */
  readonly requestorFrom: (input: Input) => IRequestor;

  /** Build an IAction from the tool invocation input. */
  readonly actionFrom: (input: Input) => IAction;

  /**
   * Optional: resolve the current entity state (for lock/draft policies).
   * If omitted, policies that need entity state will receive `null`.
   */
  readonly entityFrom?: (input: Input) => Promise<IPolicyContext['entity']> | IPolicyContext['entity'];

  /** Optional: override correlation ID per invocation. */
  readonly correlationIdFrom?: (input: Input) => string;

  /** Optional: override the clock. Default Date.now. */
  readonly now?: () => number;

  /**
   * Optional: customize the denial outcome. Default throws MCPPolicyDenied.
   * Return a value to have the wrapped tool return it instead of throwing.
   */
  readonly onDenial?: (reason: string, detail?: Readonly<Record<string, unknown>>) => unknown;
}

export class MCPPolicyDenied extends Error {
  readonly policy: string;
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>> | undefined;
  constructor(
    policy: string,
    reason: string,
    detail?: Readonly<Record<string, unknown>>,
  ) {
    super(`[bounded] ${policy}: ${reason}`);
    this.name = 'MCPPolicyDenied';
    this.policy = policy;
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * The redirect envelope returned when a policy signals a draft-write. The
 * caller (MCP server framework) decides how to surface this — typically as
 * a tool result with a "would execute" shape.
 */
export interface BoundedRedirectEnvelope {
  readonly bounded_redirect: true;
  readonly policy: string;
  readonly target: 'draft';
  readonly payload: unknown;
}

/**
 * The approval-pending envelope returned when a policy signals a pending
 * approval. The caller passes `approval_ref` to the approval system and
 * retries once the approval lands.
 */
export interface BoundedApprovalEnvelope {
  readonly bounded_approval_pending: true;
  readonly policy: string;
  readonly approval_ref: string;
  readonly message?: string;
}

/**
 * Wrap an MCP tool with Bounded policy evaluation. The wrapped function has
 * the same signature as the original tool, but returns either the original
 * tool's output OR a Bounded envelope (redirect/approval).
 */
export function withBounded<Input, Output>(
  tool: MCPTool<Input, Output>,
  opts: WithBoundedOptions<Input>,
): MCPTool<Input, Output | BoundedRedirectEnvelope | BoundedApprovalEnvelope> {
  const now = opts.now ?? Date.now;
  return async (input: Input) => {
    const requestor = opts.requestorFrom(input);
    const action = opts.actionFrom(input);
    const entity = opts.entityFrom ? await opts.entityFrom(input) : null;
    const correlation_id =
      opts.correlationIdFrom?.(input) ?? defaultCorrelationId();

    const ctx: IPolicyContext = {
      requestor,
      action,
      entity: entity ?? null,
      now: now(),
      correlation_id,
    };

    const decision = await opts.engine.evaluate(ctx);

    if (isAllow(decision)) {
      return tool(input);
    }
    if (isDeny(decision)) {
      if (opts.onDenial) {
        return opts.onDenial(decision.reason, decision.detail) as Output;
      }
      throw new MCPPolicyDenied(decision.policy, decision.reason, decision.detail);
    }
    if (isRedirect(decision)) {
      const envelope: BoundedRedirectEnvelope = {
        bounded_redirect: true,
        policy: decision.policy,
        target: decision.target,
        payload: decision.payload,
      };
      return envelope;
    }
    if (isRequireApproval(decision)) {
      const envelope: BoundedApprovalEnvelope = {
        bounded_approval_pending: true,
        policy: decision.policy,
        approval_ref: decision.approval_ref,
        message: decision.message,
      };
      return envelope;
    }
    // Exhaustiveness: every variant handled. If we got here, something slipped.
    throw new Error('bounded: unknown policy decision kind');
  };
}

/** 16-byte hex correlation ID. Good enough; not a security claim. */
function defaultCorrelationId(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += hex[(Math.random() * 16) | 0];
  }
  return out;
}
