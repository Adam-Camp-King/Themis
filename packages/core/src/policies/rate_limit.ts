// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * DefaultRateLimitPolicy + reputation (RFC v0.2 § 5.5).
 *
 * An agent that misbehaves gets LESS of everything: a per-minute limit keyed
 * by (tenant, agent, verb), scaled by a reputation score that decays on
 * blocks and recovers slowly on clean writes. A stolen key cannot exfiltrate
 * at full speed because its reputation is already falling.
 *
 *   effective_limit = max(1, floor(base_limit(tier) × reputation))
 *
 * The policy is pure: the implementation runs its limiter and passes the
 * resulting IRateCheck on `policy_metadata.rate_limit`. Decision rule:
 * count > limit → deny `rate_limited`; otherwise allow.
 */

import type {
  IPolicy, IPolicyContext, IPolicyDecision, IRateCheck, IRateLimiter, IRateLimitMetadata,
  IReputationStore, TrustTier,
} from '../types.js';

export const TIER_LIMITS_PER_MIN: Readonly<Record<TrustTier, number>> = {
  platform: 1000,
  agency: 200,
  custom: 50,
};

export const REPUTATION_FLOOR = 0.05;
export const REPUTATION_CEILING = 1.0;
export const RECOVERY_PER_CLEAN_WRITE = 0.002;

export const DEDUCTIONS: Readonly<Record<string, number>> = {
  t10_block: 0.05,
  scope_violation: 0.1,
  anomaly_soft_block: 0.1,
  anomaly_hard_block: 0.25,
  quarantine: 0.4,
  rate_limited: 0.02,
};

export function effectiveLimit(tier: TrustTier, reputation: number): number {
  const base = TIER_LIMITS_PER_MIN[tier] ?? TIER_LIMITS_PER_MIN.platform;
  const rep = Math.max(REPUTATION_FLOOR, Math.min(1, reputation));
  return Math.max(1, Math.floor(base * rep));
}

export class DefaultRateLimitPolicy implements IPolicy {
  readonly name = 'rate_limit' as const;

  async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
    const c = ctx.policy_metadata?.[this.name] as IRateLimitMetadata | undefined;
    if (!c || c.allowed !== false) {
      return { kind: 'allow', policy: this.name };
    }
    return {
      kind: 'deny',
      policy: this.name,
      reason: 'rate_limited',
      message:
        `Rate limit: ${c.count}/${c.limit} calls this minute for '${ctx.action.verb}' ` +
        `(tier ${c.tier}, reputation ${c.reputation.toFixed(2)}). Slow down or ask the owner to review the agent.`,
      detail: { limit: c.limit, count: c.count, tier: c.tier, reputation: c.reputation },
    };
  }
}

/** Fixed one-minute window per (tenant, agent, verb). Counts the call it checks. */
export class MemoryRateLimiter implements IRateLimiter {
  private readonly counts = new Map<string, number>();

  async check(
    tenant_id: number | string, agent_key: string, verb: string, tier: TrustTier, reputation: number, now: number,
  ): Promise<IRateCheck> {
    const limit = effectiveLimit(tier, reputation);
    const window = Math.floor(now / 60_000);
    const key = `${tenant_id}:${agent_key}:${verb}:${window}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (this.counts.size > 10_000) {
      for (const k of this.counts.keys()) if (!k.endsWith(`:${window}`)) this.counts.delete(k);
    }
    return { allowed: count <= limit, limit, count, tier, reputation };
  }
}

/** In-memory reputation, keyed by (tenant, agent). Starts at 1.0. */
export class MemoryReputationStore implements IReputationStore {
  private readonly scores = new Map<string, number>();

  private key(tenant_id: number | string, agent_key: string): string {
    return `${tenant_id}:${agent_key}`;
  }

  async get(tenant_id: number | string, agent_key: string): Promise<number> {
    return this.scores.get(this.key(tenant_id, agent_key)) ?? REPUTATION_CEILING;
  }

  async deduct(tenant_id: number | string, agent_key: string, reason: string): Promise<number> {
    const amount = DEDUCTIONS[reason] ?? 0.05;
    const next = clamp((await this.get(tenant_id, agent_key)) - amount);
    this.scores.set(this.key(tenant_id, agent_key), next);
    return next;
  }

  async recover(tenant_id: number | string, agent_key: string): Promise<number> {
    const next = clamp((await this.get(tenant_id, agent_key)) + RECOVERY_PER_CLEAN_WRITE);
    this.scores.set(this.key(tenant_id, agent_key), next);
    return next;
  }
}

function clamp(v: number): number {
  return Math.max(REPUTATION_FLOOR, Math.min(REPUTATION_CEILING, Math.round(v * 10_000) / 10_000));
}
