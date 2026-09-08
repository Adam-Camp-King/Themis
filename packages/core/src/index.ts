// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * themis-policy — public API.
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
export { ConsoleSink, NoOpSink, MultiSink } from './sinks.js';
