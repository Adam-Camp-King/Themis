# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""themis.types — the public types of the Themis policy kernel.

Mirrors ``themis-policy`` ``types.ts`` one-for-one and conforms to Themis RFC v0.
Decisions are frozen dataclasses with a ``kind`` discriminator; ``to_dict()``
produces the exact wire shape the RFC specifies (keys with ``None`` omitted),
which is what the cross-language conformance vectors compare.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Optional, Protocol, Sequence, Union, runtime_checkable

Id = Union[int, str]
RequestorKind = Literal["user", "api_key", "agent", "service"]


def _drop_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


# ── 1 — Requestor ──────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Requestor:
    id: Id
    kind: RequestorKind
    tenant_id: Id
    scopes: tuple[str, ...] = ()
    role: Optional[str] = None
    is_super_admin: Optional[bool] = None
    metadata: Optional[Mapping[str, Any]] = None


# ── 2 — Action ─────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Action:
    verb: str
    resource_type: str
    tenant_id: Id
    resource_id: Optional[Id] = None
    area: Optional[str] = None
    required_scope: Optional[str] = None
    payload: Any = None
    metadata: Optional[Mapping[str, Any]] = None


# ── 6/7 — Entities ─────────────────────────────────────────────────────────
@dataclass(frozen=True)
class LockableEntity:
    id: Id
    tenant_id: Id
    agency_owner_id: Optional[Id]
    locks: Mapping[str, bool]


@dataclass(frozen=True)
class DraftableEntity:
    id: Id
    tenant_id: Id
    is_published: bool
    has_pending_draft: bool
    draft_updated_at: Optional[int]
    draft_updated_by: Optional[Id]


Entity = Union[LockableEntity, DraftableEntity]


# ── 3 — PolicyContext ──────────────────────────────────────────────────────
@dataclass(frozen=True)
class PolicyContext:
    requestor: Requestor
    action: Action
    now: int
    correlation_id: str
    entity: Optional[Entity] = None
    policy_metadata: Optional[Mapping[str, Mapping[str, Any]]] = None


# ── 4 — Decisions (discriminated union) ────────────────────────────────────
@dataclass(frozen=True)
class Allow:
    kind: Literal["allow"] = "allow"
    policy: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return _drop_none({"kind": self.kind, "policy": self.policy})


@dataclass(frozen=True)
class Deny:
    policy: str
    reason: str
    message: Optional[str] = None
    detail: Optional[Mapping[str, Any]] = None
    kind: Literal["deny"] = "deny"

    def to_dict(self) -> dict[str, Any]:
        return _drop_none({
            "kind": self.kind, "policy": self.policy, "reason": self.reason,
            "message": self.message, "detail": dict(self.detail) if self.detail is not None else None,
        })


@dataclass(frozen=True)
class Redirect:
    policy: str
    payload: Any
    target: Literal["draft"] = "draft"
    kind: Literal["redirect"] = "redirect"

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "policy": self.policy, "target": self.target, "payload": self.payload}


@dataclass(frozen=True)
class RequireApproval:
    policy: str
    approval_ref: str
    message: Optional[str] = None
    kind: Literal["require_approval"] = "require_approval"

    def to_dict(self) -> dict[str, Any]:
        return _drop_none({
            "kind": self.kind, "policy": self.policy,
            "approval_ref": self.approval_ref, "message": self.message,
        })


Decision = Union[Allow, Deny, Redirect, RequireApproval]


def decision_from_dict(d: Mapping[str, Any]) -> Decision:
    """Inverse of ``to_dict`` — used by adapters and the conformance harness."""
    kind = d.get("kind")
    if kind == "allow":
        return Allow(policy=d.get("policy"))
    if kind == "deny":
        return Deny(policy=d["policy"], reason=d["reason"], message=d.get("message"), detail=d.get("detail"))
    if kind == "redirect":
        return Redirect(policy=d["policy"], payload=d.get("payload"), target=d.get("target", "draft"))
    if kind == "require_approval":
        return RequireApproval(policy=d["policy"], approval_ref=d["approval_ref"], message=d.get("message"))
    raise ValueError(f"unknown decision kind: {kind!r}")


# ── 5 — AuditEvent ─────────────────────────────────────────────────────────
@dataclass(frozen=True)
class AuditEvent:
    id: str
    timestamp: int
    correlation_id: str
    tenant_id: Id
    requestor: Mapping[str, Any]
    action: Mapping[str, Any]
    decision: Decision
    policy_chain: tuple[str, ...]
    latency_ms: float
    metadata: Optional[Mapping[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        return _drop_none({
            "id": self.id,
            "timestamp": self.timestamp,
            "correlation_id": self.correlation_id,
            "tenant_id": self.tenant_id,
            "requestor": _drop_none(dict(self.requestor)),
            "action": _drop_none(dict(self.action)),
            "decision": self.decision.to_dict(),
            "policy_chain": list(self.policy_chain),
            "latency_ms": self.latency_ms,
            "metadata": dict(self.metadata) if self.metadata is not None else None,
        })


# ── 9/12 — Ports ───────────────────────────────────────────────────────────
@runtime_checkable
class Policy(Protocol):
    name: str

    def evaluate(self, ctx: PolicyContext) -> Decision: ...


@runtime_checkable
class AuditSink(Protocol):
    def emit(self, event: AuditEvent) -> None: ...


class LockStore(Protocol):
    def get(self, entity_id: Id) -> Optional[LockableEntity]: ...
    def set_lock(self, entity_id: Id, areas: Sequence[str], locked: bool) -> LockableEntity: ...
    def request_unlock(self, entity_id: Id, requestor_id: Id, areas: Sequence[str], reason: str) -> None: ...


class DraftStore(Protocol):
    def get_entity(self, entity_id: Id) -> Optional[DraftableEntity]: ...
    def write_draft(self, entity_id: Id, draft_payload: Any, updated_by: Id) -> None: ...
    def write_live(self, entity_id: Id, payload: Any) -> None: ...
    def list_pending_drafts(self, tenant_id: Id) -> Sequence[DraftableEntity]: ...
    def publish(self, entity_id: Id) -> DraftableEntity: ...
    def discard(self, entity_id: Id) -> DraftableEntity: ...


# ── 13–16 — Agent firewall (RFC v0.2 § 4.6, § 5.4–5.6) ────────────────────
TrustTier = Literal["platform", "agency", "custom"]


@dataclass(frozen=True)
class AgentIdentity:
    """A revocable identity for an AGENT, distinct from the session it runs under.
    Carried on ``Requestor.metadata`` as ``agent_identity_id`` / ``agent_type`` /
    ``trust_tier`` / ``reputation`` / ``quarantined`` (and ``kind`` becomes ``agent``)."""
    id: Id
    tenant_id: Id
    agent_type: str
    trust_tier: str = "custom"
    reputation: float = 1.0
    revoked_at: Optional[int] = None
    quarantined_at: Optional[int] = None
    quarantine_reason: Optional[str] = None


@dataclass(frozen=True)
class BehaviorBaseline:
    """Rolling per-agent counters rebuilt periodically from the audit stream."""
    agent_key: str
    window: str
    total_actions: int
    sample_days: int
    action_counts: Mapping[str, int]
    daily_counts: Mapping[str, int]
    computed_at: int  # epoch ms


@dataclass(frozen=True)
class AnomalyInput:
    verb: str
    side_effects: str
    trust_tier: str
    recent_deletes: int
    recent_writes: int
    local_hour: int
    payload_bytes: int
    now: int  # epoch ms
    baseline: Optional[BehaviorBaseline] = None
    today_count: Optional[int] = None


@dataclass(frozen=True)
class RiskScore:
    risk: float = 0.0
    reasons: tuple[str, ...] = ()
    baseline_sample: int = 0
    baseline_used: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"risk": self.risk, "reasons": list(self.reasons),
                "baseline_sample": self.baseline_sample, "baseline_used": self.baseline_used}


@dataclass(frozen=True)
class RateCheck:
    allowed: bool
    limit: int
    count: int
    tier: str
    reputation: float

    def to_dict(self) -> dict[str, Any]:
        return {"allowed": self.allowed, "limit": self.limit, "count": self.count,
                "tier": self.tier, "reputation": self.reputation}


class ReputationStore(Protocol):
    def get(self, tenant_id: Id, agent_key: str) -> float: ...
    def deduct(self, tenant_id: Id, agent_key: str, reason: str) -> float: ...
    def recover(self, tenant_id: Id, agent_key: str) -> float: ...


class RateLimiter(Protocol):
    def check(self, tenant_id: Id, agent_key: str, verb: str, tier: str, reputation: float, now: int) -> RateCheck: ...


class AgentIdentityStore(Protocol):
    def resolve(self, tenant_id: Id, raw_key: str) -> Optional[AgentIdentity]: ...
    def revoke(self, tenant_id: Id, identity_id: Id) -> Optional[AgentIdentity]: ...
    def quarantine(self, tenant_id: Id, identity_id: Id, reason: str) -> Optional[AgentIdentity]: ...
    def release(self, tenant_id: Id, identity_id: Id) -> Optional[AgentIdentity]: ...


__all__ = [
    "Id", "RequestorKind", "Requestor", "Action", "LockableEntity", "DraftableEntity", "Entity",
    "PolicyContext", "Allow", "Deny", "Redirect", "RequireApproval", "Decision", "decision_from_dict",
    "AuditEvent", "Policy", "AuditSink", "LockStore", "DraftStore",
    "TrustTier", "AgentIdentity", "BehaviorBaseline", "AnomalyInput", "RiskScore", "RateCheck",
    "ReputationStore", "RateLimiter", "AgentIdentityStore",
]
