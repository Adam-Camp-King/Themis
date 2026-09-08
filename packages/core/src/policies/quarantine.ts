// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * DefaultQuarantinePolicy — the agent-firewall hard stop (RFC v0.2 § 5.4).
 *
 * A quarantined agent's actions are denied outright until an owner releases
 * it. The flag comes from either place an implementation may carry it:
 *
 *   1. requestor.metadata.quarantined === true          (identified agent)
 *   2. policy_metadata.quarantine.quarantined === true   (surface-level hold)
 *
 * Decision rule: quarantined → deny `agent_quarantined`; otherwise allow.
 * Pure — the store that set the flag is the implementation's business.
 */

import type { IPolicy, IPolicyContext, IPolicyDecision, IQuarantineMetadata } from '../types.js';

export class DefaultQuarantinePolicy implements IPolicy {
  readonly name = 'quarantine' as const;

  async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
    const meta = ctx.policy_metadata?.[this.name] as IQuarantineMetadata | undefined;
    const fromRequestor = ctx.requestor.metadata?.quarantined === true;
    const fromMeta = meta?.quarantined === true;
    if (!fromRequestor && !fromMeta) {
      return { kind: 'allow', policy: this.name };
    }
    const reason = (meta?.quarantine_reason ?? (ctx.requestor.metadata?.quarantine_reason as string | undefined)) ?? null;
    return {
      kind: 'deny',
      policy: this.name,
      reason: 'agent_quarantined',
      message: 'This agent is quarantined. An owner must release it before it can act again.',
      detail: { quarantine_reason: reason },
    };
  }
}
