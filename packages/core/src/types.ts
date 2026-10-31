// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * themis-policy — public types.
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
  /** Why the requestor says it is acting (RFC v0.3 § 2.7). Copied into the audit event. */
  readonly intent?: IIntent;
}

// ============================================================================
// 2a — IIntent (RFC v0.3 draft § 2.7)
// ============================================================================

/**
 * The requestor's own statement of what an action is for.
 *
 * Intent is declared, not verified: it records what the agent *said* it was
 * doing next to what the engine *let* it do. That pairing is the governance
 * record — an approved action whose intent does not match its verb is the
 * signal an auditor or an anomaly model looks for.
 *
 * The engine never reads intent. It is copied, verbatim and detached, into
 * the one IAuditEvent of the evaluation, whatever the decision. Policies may
 * read it (see DefaultIntentPolicy). Every field must be JSON-serialisable.
 */
export interface IIntent {
  /** One line, in the agent's words: what this action is for. */
  readonly summary?: string;
  /** Where the goal came from. Well-known values are listed; others are allowed. */
  readonly source?: 'user_request' | 'agent_plan' | 'schedule' | 'system' | (string & {});
  /** The request that started this work: a message id, ticket, conversation turn. */
  readonly request_ref?: string;
  /** The model's tool call that produced this action, e.g. a Claude `tool_use` id. */
  readonly tool_call_id?: string;
  /** Anything else worth keeping with the decision (plan step, confidence, ...). */
  readonly attributes?: Readonly<Record<string, unknown>>;
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
  /** What `action.verb` does, resolved by the caller from a verb registry (RFC v0.3 § 2.8). */
  readonly verb_contract?: IVerbContract | null;
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
  /** A detached copy of `action.intent`, when the action stated one (RFC v0.3 § 9.5). */
  readonly intent?: IIntent;
  /** A snapshot of the verb contract at decision time (RFC v0.3 § 9.6). */
  readonly verb_contract?: IVerbContractSnapshot;
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

// ============================================================================
// 13 — Agent identity (RFC v0.2 § 4.6)
// ============================================================================

/**
 * A first-class, revocable identity for an AGENT — distinct from the user or
 * API key whose session it runs under. Carried on `IRequestor.metadata` as
 * `agent_identity_id`, `agent_type`, `trust_tier`, `reputation`, `quarantined`
 * (and the requestor's `kind` becomes `'agent'`).
 */
export type TrustTier = 'platform' | 'agency' | 'custom';

export interface IAgentIdentity {
  readonly id: number | string;
  readonly tenant_id: number | string;
  readonly agent_type: string;
  readonly trust_tier: TrustTier;
  /** 0.0–1.0, starts at 1.0. Scales the effective rate limit. */
  readonly reputation: number;
  readonly revoked_at?: number | null;
  readonly quarantined_at?: number | null;
  readonly quarantine_reason?: string | null;
}

export interface IAgentIdentityStore {
  resolve(tenant_id: number | string, raw_key: string): Promise<IAgentIdentity | null>;
  revoke(tenant_id: number | string, identity_id: number | string): Promise<IAgentIdentity | null>;
  quarantine(tenant_id: number | string, identity_id: number | string, reason: string): Promise<IAgentIdentity | null>;
  release(tenant_id: number | string, identity_id: number | string): Promise<IAgentIdentity | null>;
}

// ============================================================================
// 14 — Behavior baseline + anomaly (RFC v0.2 § 5.6)
// ============================================================================

/**
 * Rolling per-agent counters an implementation rebuilds periodically from its
 * audit stream. The anomaly scorer contributes nothing until the sample is
 * large and fresh enough (see DefaultAnomalyPolicy).
 */
export interface IBehaviorBaseline {
  readonly agent_key: string;
  readonly window: string;
  readonly total_actions: number;
  readonly sample_days: number;
  /** {action_type: count} over the window. */
  readonly action_counts: Readonly<Record<string, number>>;
  /** {"YYYY-MM-DD": count} — the series the z-score is taken over. */
  readonly daily_counts: Readonly<Record<string, number>>;
  /** epoch ms of the rebuild. */
  readonly computed_at: number;
}

export interface IAnomalyInput {
  readonly verb: string;
  readonly side_effects: 'read' | 'write' | 'mixed';
  readonly trust_tier: TrustTier;
  /** Deletes by this agent in the bulk-delete window, NOT counting this call. */
  readonly recent_deletes: number;
  /** Writes by this agent in the burst window, NOT counting this call. */
  readonly recent_writes: number;
  /** Hour of day (0–23) in the tenant's local time. */
  readonly local_hour: number;
  readonly payload_bytes: number;
  readonly baseline?: IBehaviorBaseline | null;
  /** Today's count of this action type, counting this call. */
  readonly today_count?: number;
  /** epoch ms — used only to judge baseline freshness. */
  readonly now: number;
  /**
   * The verb's contract, when known (RFC v0.3 § 5.8). With it, side effects,
   * deletion and escalation come from the contract instead of the verb name.
   */
  readonly contract?: IVerbContract | null;
}

export interface IRiskScore {
  readonly risk: number;
  readonly reasons: readonly string[];
  readonly baseline_sample: number;
  readonly baseline_used: boolean;
}

// ============================================================================
// 15 — Reputation + rate limit (RFC v0.2 § 5.5)
// ============================================================================

export interface IReputationStore {
  get(tenant_id: number | string, agent_key: string): Promise<number>;
  deduct(tenant_id: number | string, agent_key: string, reason: string): Promise<number>;
  recover(tenant_id: number | string, agent_key: string): Promise<number>;
}

export interface IRateCheck {
  readonly allowed: boolean;
  readonly limit: number;
  readonly count: number;
  readonly tier: TrustTier;
  readonly reputation: number;
}

export interface IRateLimiter {
  check(
    tenant_id: number | string,
    agent_key: string,
    verb: string,
    tier: TrustTier,
    reputation: number,
    now: number,
  ): Promise<IRateCheck>;
}

// ============================================================================
// 16 — Firewall policy metadata (RFC v0.2 § 5.4–5.6)
// ============================================================================

/**
 * The firewall policies are pure: an implementation computes these inputs
 * from its own stores and passes them on `IPolicyContext.policy_metadata`
 * under the policy's name. That is what keeps them conformance-testable.
 */
export interface IQuarantineMetadata {
  readonly quarantined: boolean;
  readonly quarantine_reason?: string | null;
}

export interface IRateLimitMetadata extends IRateCheck {}

export interface IAnomalyMetadata extends IRiskScore {
  readonly approval_ref?: string | null;
}

// ============================================================================
// Verb contracts (RFC v0.3 draft § 2.8)
// ============================================================================

/** Well-known impacts. Any value containing ':' is an owner-namespaced extension. */
export type VerbImpact =
  | 'money' | 'access' | 'outbound' | 'deletion' | 'data_export' | 'publish'
  | (string & {});

/**
 * What a verb does, declared once and read by policies instead of the verb's
 * name. IDs are `<namespace>:<name>`; Themis never interprets the name.
 * Schema: spec/schema/verb-contract.schema.json.
 */
export interface IVerbContract {
  readonly id: string;
  readonly version?: string;
  readonly summary?: string;
  readonly side_effects: 'read' | 'write' | 'mixed';
  readonly reversibility?: 'reversible' | 'compensable' | 'irreversible';
  readonly undone_by?: string;
  readonly impacts?: readonly VerbImpact[];
  readonly requires_consent?: boolean;
  readonly idempotent?: boolean;
  readonly required_scope?: string;
  readonly acts_on?: { readonly noun: string; readonly party?: string };
  readonly refuses?: readonly { readonly code: string; readonly when?: string }[];
  readonly input_schema?: Readonly<Record<string, unknown>>;
  readonly output_schema?: Readonly<Record<string, unknown>>;
  /** `curated`: the deployer's own fact. `declared`: the governed tool's own claim. */
  readonly provenance: 'curated' | 'declared';
  readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** The part of a contract an audit event records (RFC v0.3 § 9.6). */
export interface IVerbContractSnapshot {
  readonly id: string;
  readonly version?: string;
  readonly summary?: string;
  readonly side_effects?: string;
  readonly reversibility?: string;
  readonly impacts?: readonly string[];
  readonly requires_consent?: boolean;
  readonly provenance?: string;
}

/** Resolves a verb to its contract. Implement it against your own catalog. */
export interface IVerbRegistry {
  resolve(verb: string): IVerbContract | null | Promise<IVerbContract | null>;
}

/** policy_metadata['verb_contract'] — set by the deployer after verifying an approval. */
export interface IVerbContractMetadata {
  readonly approved?: boolean;
  readonly approval_ref?: string;
}
