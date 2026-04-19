/**
 * PolicyEngine — the Bounded kernel.
 *
 * Orchestrates policies, enforces the tenancy gate, short-circuits on denial,
 * and emits one IAuditEvent per evaluation.
 *
 * Conforms to Bounded RFC v0 § 6.
 *
 * Evaluation rules (normative):
 *
 *   0. Tenancy gate — if requestor.tenant_id !== action.tenant_id,
 *      return deny { policy: 'engine', reason: 'tenancy_mismatch' } before
 *      any policy runs.
 *   1. Iterate policies in registration order.
 *   2. `deny` short-circuits; return the denial.
 *   3. `require_approval` short-circuits; return the decision.
 *   4. `redirect` does NOT short-circuit — subsequent policies still run.
 *      If any later policy denies, denial wins. If none deny, the LAST
 *      redirect returned wins (with full policy_chain recorded).
 *   5. If every policy returns `allow`, engine returns allow.
 *   6. Emit exactly one IAuditEvent per evaluation (when emit_policy != off).
 */

import { randomUUID } from 'node:crypto';
import type {
  IAuditEvent,
  IAuditSink,
  IPolicy,
  IPolicyConfig,
  IPolicyContext,
  IPolicyDecision,
  IPolicyEngine,
} from './types.js';

export type EmitPolicy = 'all' | 'denials_only' | 'off';

export interface PolicyEngineOptions {
  /** Where to emit IAuditEvents. Null disables audit. */
  auditSink?: IAuditSink | null;
  /** Which evaluations to audit. Default 'all'. */
  emit_policy?: EmitPolicy;
}

interface Registration {
  readonly policy: IPolicy;
  readonly config: IPolicyConfig;
}

export class PolicyEngine implements IPolicyEngine {
  readonly auditSink: IAuditSink | null;
  private readonly emit_policy: EmitPolicy;
  private readonly registrations: Registration[] = [];

  constructor(opts: PolicyEngineOptions = {}) {
    this.auditSink = opts.auditSink ?? null;
    this.emit_policy = opts.emit_policy ?? 'all';
  }

  addPolicy(policy: IPolicy, config: IPolicyConfig = {}): void {
    this.registrations.push({ policy, config });
  }

  async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
    const start = nowMs();
    const chain: string[] = [];

    // Rule 0 — Tenancy gate
    if (ctx.requestor.tenant_id !== ctx.action.tenant_id) {
      const decision: IPolicyDecision = {
        kind: 'deny',
        policy: 'engine',
        reason: 'tenancy_mismatch',
        message: 'requestor and action belong to different tenants',
        detail: {
          requestor_tenant: ctx.requestor.tenant_id,
          action_tenant: ctx.action.tenant_id,
        },
      };
      await this.emitIfPermitted(ctx, decision, chain, nowMs() - start);
      return decision;
    }

    // Run policies in order; collect the outcome
    let currentRedirect: IPolicyDecision | null = null;
    for (const { policy } of this.registrations) {
      const decision = await policy.evaluate(ctx);
      chain.push(policy.name);

      switch (decision.kind) {
        case 'deny':
        case 'require_approval': {
          await this.emitIfPermitted(ctx, decision, chain, nowMs() - start);
          return decision;
        }
        case 'redirect': {
          // Does NOT short-circuit. Remember and continue.
          currentRedirect = decision;
          break;
        }
        case 'allow':
        default:
          // Continue
          break;
      }
    }

    const final: IPolicyDecision =
      currentRedirect ?? { kind: 'allow' };
    await this.emitIfPermitted(ctx, final, chain, nowMs() - start);
    return final;
  }

  // --------------------------------------------------------------------
  // audit
  // --------------------------------------------------------------------

  private async emitIfPermitted(
    ctx: IPolicyContext,
    decision: IPolicyDecision,
    chain: string[],
    latency_ms: number,
  ): Promise<void> {
    if (!this.auditSink || this.emit_policy === 'off') return;
    if (this.emit_policy === 'denials_only' && decision.kind === 'allow') {
      return;
    }
    const event = buildAuditEvent(ctx, decision, chain, latency_ms);
    try {
      await this.auditSink.emit(event);
    } catch {
      // Audit failures MUST NOT fail the evaluation (RFC v0 § 9.4).
      // Swallow — the caller may choose to surface via metrics.
    }
  }
}

// ------------------------------------------------------------------------
// event construction — exported for adapters/tests that need to build
// events outside the engine (e.g., a custom transport that wraps evaluate).
// ------------------------------------------------------------------------

export function buildAuditEvent(
  ctx: IPolicyContext,
  decision: IPolicyDecision,
  policy_chain: readonly string[],
  latency_ms: number,
): IAuditEvent {
  // Denormalize requestor/action — audit must not carry live references
  const requestor: IAuditEvent['requestor'] = {
    id: ctx.requestor.id,
    kind: ctx.requestor.kind,
    scopes: ctx.requestor.scopes.length > 0 ? [...ctx.requestor.scopes] : undefined,
    role: ctx.requestor.role,
  };
  const action: IAuditEvent['action'] = {
    verb: ctx.action.verb,
    resource_type: ctx.action.resource_type,
    resource_id: ctx.action.resource_id,
    area: ctx.action.area,
    required_scope: ctx.action.required_scope,
  };
  return {
    id: randomUUID(),
    timestamp: ctx.now || nowMs(),
    correlation_id: ctx.correlation_id,
    tenant_id: ctx.action.tenant_id,
    requestor,
    action,
    decision,
    policy_chain: [...policy_chain],
    latency_ms,
    metadata: ctx.action.metadata,
  };
}

function nowMs(): number {
  return Date.now();
}
