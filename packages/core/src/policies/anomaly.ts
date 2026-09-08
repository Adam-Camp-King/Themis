// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * DefaultAnomalyPolicy + scoreAction (RFC v0.2 § 5.6).
 *
 * Notice when an agent does something it has never done before, or at a
 * suspicious rate, and contain it before it does damage. Two halves, summed
 * and clamped to 0–1:
 *
 * Hard heuristics — fire from day one, no history needed:
 *   bulk delete        recent_deletes + 1 ≥ BULK_DELETE_THRESHOLD           → 0.97
 *   scope escalation   custom-tier agent reaching for an owner namespace    → 0.90
 *   off-hours burst    recent_writes + 1 ≥ BURST_THRESHOLD in OFF_HOURS      → 0.85
 *   oversized payload  payload_bytes > PAYLOAD_SOFT_BYTES                   → +0.30
 *
 * Statistical — self-gating: a z-score of today's count against the
 * baseline's daily series, contributing nothing until the baseline has
 * ≥ MIN_BASELINE_SAMPLE actions over ≥ MIN_BASELINE_DAYS days and is fresher
 * than BASELINE_MAX_AGE_MS. A fresh tenant cannot quarantine anyone on noise.
 *
 * Reads always score 0. The policy is pure: the implementation calls
 * `scoreAction` (or its own scorer) and passes the IRiskScore on
 * `policy_metadata.anomaly`. Decision rule: risk > HARD_BLOCK → deny
 * `anomaly_hard_block`; risk > SOFT_BLOCK → require_approval; else allow.
 */

import type { IAnomalyInput, IAnomalyMetadata, IPolicy, IPolicyContext, IPolicyDecision, IRiskScore } from '../types.js';

export const SOFT_BLOCK = 0.8;
export const HARD_BLOCK = 0.95;

export const BULK_DELETE_THRESHOLD = 10;
export const BURST_THRESHOLD = 60;
export const OFF_HOURS: readonly [number, number] = [0, 5];
export const PAYLOAD_SOFT_BYTES = 200_000;

export const MIN_BASELINE_SAMPLE = 200;
export const MIN_BASELINE_DAYS = 7;
export const BASELINE_MAX_AGE_MS = 48 * 3600 * 1000;
export const Z_TRIGGER = 3.0;
export const Z_MAX_CONTRIBUTION = 0.6;

export const ESCALATION_NAMESPACES: ReadonlySet<string> = new Set([
  'team', 'gdpr', 'billing', 'subscription', 'security', 'audit', 'ai_employee',
]);
const DELETE_WORDS = ['delete', 'remove', 'purge', 'destroy'];

export function isDeleteVerb(verb: string): boolean {
  const v = verb.toLowerCase();
  return DELETE_WORDS.some((w) => v.includes(w));
}

export function namespaceOf(verb: string): string {
  if (verb.includes('.')) return verb.split('.', 1)[0] ?? verb;
  if (verb.includes('_')) return verb.split('_', 1)[0] ?? verb;
  return verb;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

export function scoreAction(input: IAnomalyInput): IRiskScore {
  let risk = 0;
  const reasons: string[] = [];
  const add = (amount: number, reason: string): void => {
    risk = Math.min(1, round4(risk + amount));
    reasons.push(reason);
  };
  let baselineSample = 0;
  let baselineUsed = false;

  if (input.side_effects !== 'write' && input.side_effects !== 'mixed') {
    return { risk: 0, reasons: [], baseline_sample: 0, baseline_used: false };
  }

  if (isDeleteVerb(input.verb) && input.recent_deletes + 1 >= BULK_DELETE_THRESHOLD) {
    add(0.97, `bulk_delete:${input.recent_deletes + 1}_in_10m`);
  }
  const ns = namespaceOf(input.verb);
  if (input.trust_tier === 'custom' && ESCALATION_NAMESPACES.has(ns)) {
    add(0.9, `scope_escalation:${ns}`);
  }
  if (input.local_hour >= OFF_HOURS[0] && input.local_hour < OFF_HOURS[1] && input.recent_writes + 1 >= BURST_THRESHOLD) {
    add(0.85, `off_hours_burst:${input.recent_writes + 1}_in_5m@${String(input.local_hour).padStart(2, '0')}h`);
  }
  if (input.payload_bytes > PAYLOAD_SOFT_BYTES) {
    add(0.3, `oversized_payload:${input.payload_bytes}b`);
  }

  const base = input.baseline ?? null;
  if (base) {
    baselineSample = base.total_actions;
    const daily = Object.values(base.daily_counts);
    const fresh = input.now - base.computed_at <= BASELINE_MAX_AGE_MS;
    if (
      base.total_actions >= MIN_BASELINE_SAMPLE && daily.length >= MIN_BASELINE_DAYS &&
      base.sample_days >= MIN_BASELINE_DAYS && fresh
    ) {
      baselineUsed = true;
      const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
      const variance = daily.reduce((a, b) => a + (b - mean) ** 2, 0) / daily.length;
      const std = Math.sqrt(variance) || 1;
      const today = input.today_count ?? 1;
      const z = (today - mean) / std;
      if (z > Z_TRIGGER) {
        add(Math.min(Z_MAX_CONTRIBUTION, round4((z - Z_TRIGGER) / 10)), `volume_z:${z.toFixed(1)}`);
      }
      const counts = base.action_counts;
      if (Object.keys(counts).length > 0 && !(`policy:${input.verb}` in counts) && !(input.verb in counts)) {
        add(0.15, 'never_seen_action');
      }
    }
  }
  return { risk, reasons, baseline_sample: baselineSample, baseline_used: baselineUsed };
}

export class DefaultAnomalyPolicy implements IPolicy {
  readonly name = 'anomaly' as const;

  async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
    const s = ctx.policy_metadata?.[this.name] as IAnomalyMetadata | undefined;
    if (!s || typeof s.risk !== 'number') {
      return { kind: 'allow', policy: this.name };
    }
    const reasons = [...(s.reasons ?? [])];
    if (s.risk > HARD_BLOCK) {
      return {
        kind: 'deny',
        policy: this.name,
        reason: 'anomaly_hard_block',
        message: `Blocked: risk ${s.risk.toFixed(2)} (${reasons.join(', ')}). The agent has been quarantined.`,
        detail: { risk: s.risk, reasons, baseline_sample: s.baseline_sample ?? 0, baseline_used: s.baseline_used ?? false },
      };
    }
    if (s.risk > SOFT_BLOCK) {
      return {
        kind: 'require_approval',
        policy: this.name,
        approval_ref: s.approval_ref ?? 'ask-owner',
        message: `Needs owner approval: risk ${s.risk.toFixed(2)} (${reasons.join(', ')}).`,
      };
    }
    return { kind: 'allow', policy: this.name };
  }
}
