// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * @themis/core — public types.
 *
 * Twelve interfaces form the complete public API of this package:
 *   Cross-cutting (5) — IRequestor, IAction, IPolicyContext,
 *                        IPolicyDecision, IAuditEvent
 *   Policies (4)     — ILockPolicy, IDraftPolicy, IScopePolicy, IPolicyEngine
 *   Stores (3)       — ILockStore, IDraftStore, IAuditSink
 *
 * Companion entity shapes (ILockableEntity, IDraftableEntity) and helper
 * types (ScopeRuleMatcher, IPolicy, IPolicyConfig) are also exported.
 *
 * Conforms to Themis RFC v0.
 */

// ============================================================================
// 1 — IRequestor
// ============================================================================

/**
 * Identifies the actor attempting an action. Unifies users, API keys, agents,
 * and service tokens.
 *
 * Tenancy rule: a requestor acts on exactly one tenant at a time. The engine
 * enforces `requestor.tenant_id === action.tenant_id` before invoking policies.
 */
export interface IRequestor {
  readonly id: number | string;
  readonly kind: 'user' | 'api_key' | 'agent' | 'service';
  readonly tenant_id: number | string;
  readonly scopes: readonly string[];
  readonly role?: string;
  readonly is_super_admin?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 2 — IAction
// ============================================================================

/**
 * The operation a requestor is attempting. Independent of transport
 * (HTTP / CLI / MCP / scheduled job).
 */
export interface IAction {
  readonly verb: string;
  readonly resource_type: string;
  readonly resource_id?: number | string;
  readonly tenant_id: number | string;
  readonly area?: string;
  readonly required_scope?: string;
  readonly payload?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 3 — IPolicyContext
// ============================================================================

/**
 * Complete input to a policy evaluation. Constructed once per evaluation and
 * passed unchanged to each policy in order. Policies must treat it as
 * read-only.
 */
export interface IPolicyContext {
  readonly requestor: IRequestor;
  readonly action: IAction;
  readonly entity?: ILockableEntity | IDraftableEntity | null;
  readonly now: number;
  readonly correlation_id: string;
  readonly policy_metadata?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

// ============================================================================
// 4 — IPolicyDecision (discriminated union)
// ============================================================================

export type IPolicyDecision =
  | IAllowDecision
  | IDenyDecision
  | IRedirectDecision
  | IRequireApprovalDecision;

export interface IAllowDecision {
  readonly kind: 'allow';
  readonly policy?: string;
}

export interface IDenyDecision {
  readonly kind: 'deny';
  readonly policy: string;
  readonly reason: string;
  readonly message?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface IRedirectDecision {
  readonly kind: 'redirect';
  readonly policy: string;
  readonly target: 'draft';
  readonly payload: unknown;
}

export interface IRequireApprovalDecision {
  readonly kind: 'require_approval';
  readonly policy: string;
  readonly approval_ref: string;
  readonly message?: string;
}

// ============================================================================
// 5 — IAuditEvent
// ============================================================================

export interface IAuditEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly correlation_id: string;
  readonly tenant_id: number | string;
  readonly requestor: Readonly<{
    id: number | string;
    kind: IRequestor['kind'];
    scopes?: readonly string[];
    role?: string;
  }>;
  readonly action: Readonly<{
    verb: string;
    resource_type: string;
    resource_id?: number | string;
    area?: string;
    required_scope?: string;
  }>;
  readonly decision: IPolicyDecision;
  readonly policy_chain: readonly string[];
  readonly latency_ms: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 6 — ILockPolicy (+ ILockableEntity)
// ============================================================================

export interface ILockableEntity {
  readonly id: number | string;
  readonly tenant_id: number | string;
  readonly agency_owner_id: number | string | null;
  readonly locks: Readonly<Record<string, boolean>>;
}

export interface ILockPolicy extends IPolicy {
  readonly name: 'lock';
  evaluate(ctx: IPolicyContext): Promise<IPolicyDecision>;
  describe(entity: ILockableEntity, areas: readonly string[]): Record<string, boolean>;
  apply(
    entity: ILockableEntity,
    areas: readonly string[],
    locked: boolean,
  ): ILockableEntity;
}

// ============================================================================
// 7 — IDraftPolicy (+ IDraftableEntity)
// ============================================================================

export interface IDraftableEntity {
  readonly id: number | string;
  readonly tenant_id: number | string;
  readonly is_published: boolean;
  readonly has_pending_draft: boolean;
  readonly draft_updated_at: number | null;
  readonly draft_updated_by: number | string | null;
}

export interface IDraftPolicy extends IPolicy {
  readonly name: 'draft';
  evaluate(ctx: IPolicyContext): Promise<IPolicyDecision>;
  merge(entity: IDraftableEntity, draft_payload: unknown): IDraftableEntity;
  clear(entity: IDraftableEntity): IDraftableEntity;
  signPreviewToken(
    entity_id: number | string,
    tenant_id: number | string,
    ttl_hours: number,
    secret: string,
  ): string;
  verifyPreviewToken(
    token: string,
    secret: string,
  ): { entity_id: number | string; tenant_id: number | string } | null;
}

// ============================================================================
// 8 — IScopePolicy
// ============================================================================

export type ScopeRuleMatcher =
  | { method: string; path_pattern: string | RegExp }
  | ((ctx: IPolicyContext) => boolean);

export interface IScopePolicy extends IPolicy {
  readonly name: 'scope';
  evaluate(ctx: IPolicyContext): Promise<IPolicyDecision>;
  addRule(matcher: ScopeRuleMatcher, required_scope: string): void;
  listScopes(): readonly string[];
}

// ============================================================================
// 9 — IPolicyEngine (+ IPolicy, IPolicyConfig)
// ============================================================================

export interface IPolicy {
  readonly name: string;
  evaluate(ctx: IPolicyContext): Promise<IPolicyDecision>;
}

export interface IPolicyConfig {
  readonly [key: string]: unknown;
}

export interface IPolicyEngine {
  addPolicy(policy: IPolicy, config?: IPolicyConfig): void;
  evaluate(ctx: IPolicyContext): Promise<IPolicyDecision>;
  readonly auditSink: IAuditSink | null;
}

// ============================================================================
// 10 — ILockStore
// ============================================================================

export interface ILockStore {
  get(entity_id: number | string): Promise<ILockableEntity | null>;
  setLock(
    entity_id: number | string,
    areas: readonly string[],
    locked: boolean,
  ): Promise<ILockableEntity>;
  requestUnlock(
    entity_id: number | string,
    requestor_id: number | string,
    areas: readonly string[],
    reason: string,
  ): Promise<void>;
}

// ============================================================================
// 11 — IDraftStore
// ============================================================================

export interface IDraftStore {
  getEntity(entity_id: number | string): Promise<IDraftableEntity | null>;
  writeDraft(
    entity_id: number | string,
    draft_payload: unknown,
    updated_by: number | string,
  ): Promise<void>;
  writeLive(entity_id: number | string, payload: unknown): Promise<void>;
  listPendingDrafts(tenant_id: number | string): Promise<readonly IDraftableEntity[]>;
  publish(entity_id: number | string): Promise<IDraftableEntity>;
  discard(entity_id: number | string): Promise<IDraftableEntity>;
}

// ============================================================================
// 12 — IAuditSink
// ============================================================================

export interface IAuditSink {
  emit(event: IAuditEvent): void | Promise<void>;
  flush?(): Promise<void>;
}
