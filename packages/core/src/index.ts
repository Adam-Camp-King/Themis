// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * themis-policy — public API. RFC v0 primitives (lock, draft, scope, engine,
 * audit) plus the RFC v0.2 agent-firewall policies (quarantine, rate limit +
 * reputation, anomaly).
 *
 * Import types with `import type` to avoid runtime cost; import guards as
 * values.
 *
 *   import type { IPolicyDecision, IRequestor, IAction } from 'themis-policy';
 *   import { isDeny, isRedirect } from 'themis-policy';
 */

export * from './types.js';
export * from './guards.js';
export { PolicyEngine, buildAuditEvent, type EmitPolicy, type PolicyEngineOptions } from './engine.js';
export { DefaultLockPolicy } from './policies/lock.js';
export { DefaultScopePolicy } from './policies/scope.js';
export { DefaultDraftPolicy } from './policies/draft.js';
export { DefaultQuarantinePolicy } from './policies/quarantine.js';
export {
  DefaultRateLimitPolicy, MemoryRateLimiter, MemoryReputationStore, effectiveLimit,
  TIER_LIMITS_PER_MIN, DEDUCTIONS, REPUTATION_FLOOR, REPUTATION_CEILING, RECOVERY_PER_CLEAN_WRITE,
} from './policies/rate_limit.js';
export {
  DefaultAnomalyPolicy, scoreAction, isDeleteVerb, namespaceOf, escalationNamespaceOf,
  SOFT_BLOCK, HARD_BLOCK, BULK_DELETE_THRESHOLD, BURST_THRESHOLD, OFF_HOURS, PAYLOAD_SOFT_BYTES,
  MIN_BASELINE_SAMPLE, MIN_BASELINE_DAYS, BASELINE_MAX_AGE_MS, Z_TRIGGER, Z_MAX_CONTRIBUTION, ESCALATION_NAMESPACES,
} from './policies/anomaly.js';
export { ConsoleSink, NoOpSink, MultiSink } from './sinks.js';
