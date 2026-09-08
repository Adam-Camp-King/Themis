// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * themis-policy-langchain — adapter for LangChain Tools (and anything that
 * looks like one: a named object with an async call/invoke/func method).
 *
 * LangChain's Tool abstraction is duck-typed in practice — different
 * language-model frameworks have slight variations (`call`, `invoke`,
 * `func`, `_call`). We accept the minimum common interface: a function
 * that takes args and returns a result.
 *
 * Usage:
 *
 *   import { DynamicTool } from '@langchain/core/tools';
 *   import { gateTool } from 'themis-policy-langchain';
 *
 *   const raw = new DynamicTool({
 *     name: 'send_invoice',
 *     description: 'Sends an invoice',
 *     func: async (input) => sendInvoice(JSON.parse(input)),
 *   });
 *   const gated = gateTool(raw, {
 *     engine,
 *     requestorFrom: (args, toolName) => currentAgentAsRequestor,
 *     actionFrom: (args, toolName) => ({
 *       verb: 'invoke',
 *       resource_type: toolName,
 *       tenant_id: currentTenant,
 *       required_scope: scopesByTool[toolName],
 *       payload: args,
 *     }),
 *   });
 */

import type {
  IAction,
  IPolicyContext,
  IPolicyEngine,
  IRequestor,
} from 'themis-policy';
import { isAllow, isDeny, isRedirect, isRequireApproval } from 'themis-policy';

/**
 * Minimal LangChain-Tool-ish interface. We read `name` + `call` (or
 * fall back to `_call`, `invoke`, `func` in that order). Returns a new
 * object with the same `name`/`description` and a gated `call`.
 */
export interface LangChainToolLike {
  readonly name: string;
  readonly description?: string;
  call?: (args: unknown) => Promise<unknown> | unknown;
  _call?: (args: unknown) => Promise<unknown> | unknown;
  invoke?: (args: unknown) => Promise<unknown> | unknown;
  func?: (args: unknown) => Promise<unknown> | unknown;
}

export interface GateToolOptions {
  readonly engine: IPolicyEngine;
  readonly requestorFrom: (args: unknown, toolName: string) => IRequestor;
  readonly actionFrom: (args: unknown, toolName: string) => IAction;
  readonly entityFrom?: (args: unknown, toolName: string) =>
    | Promise<IPolicyContext['entity']>
    | IPolicyContext['entity'];
  readonly correlationIdFrom?: (args: unknown, toolName: string) => string;
  /**
   * RFC v0.2 agent firewall: per-call inputs for the pure firewall policies
   * (`quarantine`, `rate_limit`, `anomaly`), keyed by policy name. Compute
   * them from your own stores (limiter, reputation, baselines) and return
   * them here; the engine passes them on `IPolicyContext.policy_metadata`.
   */
  readonly policyMetadataFrom?: (args: unknown, toolName: string) =>
    | Promise<IPolicyContext['policy_metadata']>
    | IPolicyContext['policy_metadata'];
  readonly now?: () => number;
  /**
   * How to surface a denial. Default: throw. Callers may return a string
   * (becomes the tool output so the agent can see the reason).
   */
  readonly onDenial?: (reason: string, detail?: Readonly<Record<string, unknown>>) => unknown;
}

export class LangChainPolicyDenied extends Error {
  readonly policy: string;
  readonly reason: string;
  constructor(policy: string, reason: string) {
    super(`[themis] ${policy}: ${reason}`);
    this.name = 'LangChainPolicyDenied';
    this.policy = policy;
    this.reason = reason;
  }
}

/**
 * Wrap a LangChain tool with Themis policy gating. Preserves name +
 * description + any untouched methods; replaces the invocation method
 * with a gated version.
 */
export function gateTool<T extends LangChainToolLike>(
  tool: T,
  opts: GateToolOptions,
): T & { call: (args: unknown) => Promise<unknown> } {
  const invoke = pickInvoke(tool);
  if (!invoke) {
    throw new Error(
      `[themis] LangChain tool '${tool.name}' has no call/_call/invoke/func method`,
    );
  }
  const now = opts.now ?? Date.now;

  const gatedCall = async (args: unknown): Promise<unknown> => {
    const toolName = tool.name;
    const requestor = opts.requestorFrom(args, toolName);
    const action = opts.actionFrom(args, toolName);
    const entity = opts.entityFrom ? await opts.entityFrom(args, toolName) : null;
    const policy_metadata = opts.policyMetadataFrom ? await opts.policyMetadataFrom(args, toolName) : undefined;
    const correlation_id =
      opts.correlationIdFrom?.(args, toolName) ?? defaultCorrelationId();

    const ctx: IPolicyContext = {
      requestor,
      action,
      entity: entity ?? null,
      now: now(),
      correlation_id,
      ...(policy_metadata ? { policy_metadata } : {}),
    };

    const decision = await opts.engine.evaluate(ctx);

    if (isAllow(decision)) {
      return invoke.call(tool, args);
    }
    if (isDeny(decision)) {
      if (opts.onDenial) {
        return opts.onDenial(decision.reason, decision.detail);
      }
      throw new LangChainPolicyDenied(decision.policy, decision.reason);
    }
    if (isRedirect(decision)) {
      return {
        themis_redirect: true as const,
        policy: decision.policy,
        target: decision.target,
        payload: decision.payload,
      };
    }
    if (isRequireApproval(decision)) {
      return {
        themis_approval_pending: true as const,
        policy: decision.policy,
        approval_ref: decision.approval_ref,
        message: decision.message,
      };
    }
    throw new Error('[themis] unknown policy decision kind');
  };

  // Spread original, then force-override `call` with the gated one.
  return { ...tool, call: gatedCall };
}

function pickInvoke(
  tool: LangChainToolLike,
): ((args: unknown) => Promise<unknown> | unknown) | null {
  return tool.call ?? tool._call ?? tool.invoke ?? tool.func ?? null;
}

function defaultCorrelationId(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i++) out += hex[(Math.random() * 16) | 0];
  return out;
}
