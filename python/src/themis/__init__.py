# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""Themis — a policy kernel for bounded-autonomy LLM agents.

Python reference implementation of Themis RFC v0 (locks, drafts, scopes,
audit) and the RFC v0.2 agent firewall (agent identity, quarantine, rate
limit + reputation, anomaly) — composed by one engine into a single decision
per attempted action: allow, deny, redirect, or require_approval.

Conformance: ``spec/conformance/v0`` in the Themis repository holds the
cross-language vectors; this package and ``themis-policy`` pass the same set.
"""
from .types import (
    Action, Allow, AuditEvent, AuditSink, Decision, Deny, DraftableEntity, DraftStore, Entity, Id,
    LockableEntity, LockStore, Policy, PolicyContext, Redirect, RequireApproval, Requestor, RequestorKind,
    decision_from_dict,
    TrustTier, AgentIdentity, BehaviorBaseline, AnomalyInput, RiskScore, RateCheck,
    ReputationStore, RateLimiter, AgentIdentityStore,
)
from .engine import PolicyEngine, EmitPolicy, build_audit_event
from .guards import is_allow, is_deny, is_redirect, is_require_approval
from .sinks import ConsoleSink, MemorySink, MultiSink, NoOpSink
from .policies import (
    DefaultDraftPolicy, DefaultLockPolicy, DefaultScopePolicy,
    DefaultQuarantinePolicy, DefaultRateLimitPolicy, DefaultAnomalyPolicy,
    MemoryRateLimiter, MemoryReputationStore, effective_limit, score_action,
    TIER_LIMITS_PER_MIN, DEDUCTIONS, SOFT_BLOCK, HARD_BLOCK,
)

__version__ = "0.2.1"
__all__ = [
    "Action", "Allow", "AuditEvent", "AuditSink", "Decision", "Deny", "DraftableEntity", "DraftStore", "Entity",
    "Id", "LockableEntity", "LockStore", "Policy", "PolicyContext", "Redirect", "RequireApproval", "Requestor",
    "RequestorKind", "decision_from_dict", "PolicyEngine", "EmitPolicy", "build_audit_event",
    "is_allow", "is_deny", "is_redirect", "is_require_approval",
    "ConsoleSink", "MemorySink", "MultiSink", "NoOpSink",
    "DefaultDraftPolicy", "DefaultLockPolicy", "DefaultScopePolicy",
    "TrustTier", "AgentIdentity", "BehaviorBaseline", "AnomalyInput", "RiskScore", "RateCheck",
    "ReputationStore", "RateLimiter", "AgentIdentityStore",
    "DefaultQuarantinePolicy", "DefaultRateLimitPolicy", "DefaultAnomalyPolicy",
    "MemoryRateLimiter", "MemoryReputationStore", "effective_limit", "score_action",
    "TIER_LIMITS_PER_MIN", "DEDUCTIONS", "SOFT_BLOCK", "HARD_BLOCK", "__version__",
]
