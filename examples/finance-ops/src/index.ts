/**
 * examples/finance-ops — "don't wire money without approval."
 *
 * Demonstrates the full Bounded stack end-to-end:
 *   - @bounded/core            — PolicyEngine, DefaultScopePolicy, ConsoleSink
 *   - @bounded/anthropic       — gateToolHandlers for Claude tool_use blocks
 *   - A custom ThresholdApprovalPolicy — require approval on amounts > $10k
 *
 * This is not a production system. It exists to show:
 *   1. How the primitives compose.
 *   2. That a denial / redirect / require_approval is surfaced as a
 *      structured tool_result back to the model — not swallowed.
 *   3. That every evaluation produces one audit event.
 */

import type {
  IPolicy,
  IPolicyContext,
  IPolicyDecision,
  IRequestor,
} from '@bounded/core';
import {
  ConsoleSink,
  DefaultScopePolicy,
  PolicyEngine,
} from '@bounded/core';
import {
  gateToolHandlers,
  type ToolUseBlock,
} from '@bounded/anthropic';

// ----------------------------------------------------------------------------
// Domain — pretend wire-transfer handler
// ----------------------------------------------------------------------------

async function sendWireTransfer(
  input: unknown,
): Promise<{ wire_id: string; status: string; amount: number }> {
  const args = input as { amount: number; to: string };
  // In a real system this would call the treasury API. We simulate.
  return {
    wire_id: `wire-${Math.floor(Math.random() * 1_000_000)}`,
    status: 'sent',
    amount: args.amount,
  };
}

// ----------------------------------------------------------------------------
// Custom policy — require approval on large transfers
// ----------------------------------------------------------------------------

class ThresholdApprovalPolicy implements IPolicy {
  readonly name = 'threshold_approval';
  constructor(private readonly thresholdUsd: number) {}

  async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
    if (ctx.action.resource_type !== 'wire_transfer') {
      return { kind: 'allow', policy: this.name };
    }
    const payload = ctx.action.payload as { amount?: number } | undefined;
    const amount = payload?.amount ?? 0;
    if (amount <= this.thresholdUsd) {
      return { kind: 'allow', policy: this.name };
    }
    return {
      kind: 'require_approval',
      policy: this.name,
      approval_ref: `approval-${ctx.correlation_id}`,
      message: `Wire transfer of $${amount.toLocaleString()} exceeds the $${this.thresholdUsd.toLocaleString()} threshold.`,
    };
  }
}

// ----------------------------------------------------------------------------
// Wire it up
// ----------------------------------------------------------------------------

export function buildEngine(): PolicyEngine {
  const engine = new PolicyEngine({ auditSink: new ConsoleSink() });

  const scope = new DefaultScopePolicy();
  scope.addRule((ctx) => ctx.action.resource_type === 'wire_transfer', 'payments:write');

  engine.addPolicy(scope);
  engine.addPolicy(new ThresholdApprovalPolicy(10_000));

  return engine;
}

export function buildRequestor(scopes: readonly string[]): IRequestor {
  return {
    id: 'agent-cfo-bot',
    kind: 'agent',
    tenant_id: 'acme-corp',
    scopes,
  };
}

export function buildGate(engine: PolicyEngine, requestor: IRequestor) {
  return gateToolHandlers(
    { send_wire_transfer: sendWireTransfer },
    {
      engine,
      requestorFrom: (_tu) => requestor,
      actionFrom: (tu) => ({
        verb: 'invoke',
        resource_type: 'wire_transfer',
        tenant_id: 'acme-corp',
        payload: tu.input,
      }),
    },
  );
}

// ----------------------------------------------------------------------------
// Demo — run three scenarios
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const engine = buildEngine();

  // Scenario 1: agent without payments:write scope — DENIED
  const unscoped = buildRequestor([]);
  const gate1 = buildGate(engine, unscoped);
  const result1 = await gate1.execute({
    type: 'tool_use',
    id: 'tu-1',
    name: 'send_wire_transfer',
    input: { amount: 500, to: 'vendor-a' },
  } satisfies ToolUseBlock);
  console.log('Scenario 1 (no scope):', result1);

  // Scenario 2: scoped agent, small amount — ALLOWED
  const scoped = buildRequestor(['payments:write']);
  const gate2 = buildGate(engine, scoped);
  const result2 = await gate2.execute({
    type: 'tool_use',
    id: 'tu-2',
    name: 'send_wire_transfer',
    input: { amount: 500, to: 'vendor-a' },
  } satisfies ToolUseBlock);
  console.log('Scenario 2 (scoped, small):', result2);

  // Scenario 3: scoped agent, large amount — REQUIRES APPROVAL
  const result3 = await gate2.execute({
    type: 'tool_use',
    id: 'tu-3',
    name: 'send_wire_transfer',
    input: { amount: 500_000, to: 'vendor-a' },
  } satisfies ToolUseBlock);
  console.log('Scenario 3 (scoped, $500k):', result3);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
