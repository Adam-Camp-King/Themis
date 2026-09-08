# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""themis.engine — the Themis kernel (RFC v0 § 6).

Evaluation rules (normative, identical to ``themis-policy``):

  0. Tenancy gate — requestor.tenant_id != action.tenant_id → deny
     {policy: 'engine', reason: 'tenancy_mismatch'} before any policy runs.
  1. Iterate policies in registration order.
  2. ``deny`` short-circuits.
  3. ``require_approval`` short-circuits.
  4. ``redirect`` does NOT short-circuit; a later deny wins; otherwise the LAST
     redirect wins, with the full policy chain recorded.
  5. All ``allow`` → allow.
  6. Exactly one audit event per evaluation (when emit_policy != 'off').
     Sink failures never fail the evaluation (§ 9.4).

The engine is synchronous: every policy here is pure CPU. ``evaluate_async``
is provided for callers already inside an event loop.
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Literal, Mapping, Optional, Sequence

from .types import (
    Allow, AuditEvent, AuditSink, Decision, Deny, Policy, PolicyContext, Redirect, RequireApproval,
)

EmitPolicy = Literal["all", "denials_only", "off"]


def _now_ms() -> int:
    return int(time.time() * 1000)


def build_audit_event(
    ctx: PolicyContext, decision: Decision, policy_chain: Sequence[str], latency_ms: float,
) -> AuditEvent:
    """Denormalize requestor/action — an audit event must not carry live references."""
    requestor: dict[str, Any] = {
        "id": ctx.requestor.id,
        "kind": ctx.requestor.kind,
        "scopes": list(ctx.requestor.scopes) if ctx.requestor.scopes else None,
        "role": ctx.requestor.role,
    }
    action: dict[str, Any] = {
        "verb": ctx.action.verb,
        "resource_type": ctx.action.resource_type,
        "resource_id": ctx.action.resource_id,
        "area": ctx.action.area,
        "required_scope": ctx.action.required_scope,
    }
    return AuditEvent(
        id=str(uuid.uuid4()),
        timestamp=ctx.now or _now_ms(),
        correlation_id=ctx.correlation_id,
        tenant_id=ctx.action.tenant_id,
        requestor=requestor,
        action=action,
        decision=decision,
        policy_chain=tuple(policy_chain),
        latency_ms=latency_ms,
        metadata=ctx.action.metadata,
    )


class PolicyEngine:
    def __init__(self, audit_sink: Optional[AuditSink] = None, emit_policy: EmitPolicy = "all") -> None:
        self.audit_sink = audit_sink
        self._emit_policy: EmitPolicy = emit_policy
        self._registrations: list[tuple[Policy, Mapping[str, Any]]] = []

    def add_policy(self, policy: Policy, config: Optional[Mapping[str, Any]] = None) -> None:
        self._registrations.append((policy, dict(config or {})))

    @property
    def policies(self) -> tuple[Policy, ...]:
        return tuple(p for p, _ in self._registrations)

    def evaluate(self, ctx: PolicyContext) -> Decision:
        start = time.perf_counter()
        chain: list[str] = []

        # Rule 0 — tenancy gate
        if ctx.requestor.tenant_id != ctx.action.tenant_id:
            decision: Decision = Deny(
                policy="engine",
                reason="tenancy_mismatch",
                message="requestor and action belong to different tenants",
                detail={"requestor_tenant": ctx.requestor.tenant_id, "action_tenant": ctx.action.tenant_id},
            )
            self._emit_if_permitted(ctx, decision, chain, start)
            return decision

        current_redirect: Optional[Redirect] = None
        for policy, _config in self._registrations:
            d = policy.evaluate(ctx)
            chain.append(policy.name)
            if isinstance(d, (Deny, RequireApproval)):
                self._emit_if_permitted(ctx, d, chain, start)
                return d
            if isinstance(d, Redirect):
                current_redirect = d  # does not short-circuit
            # Allow → continue

        final: Decision = current_redirect if current_redirect is not None else Allow()
        self._emit_if_permitted(ctx, final, chain, start)
        return final

    async def evaluate_async(self, ctx: PolicyContext) -> Decision:
        return self.evaluate(ctx)

    def _emit_if_permitted(self, ctx: PolicyContext, decision: Decision, chain: list[str], start: float) -> None:
        if self.audit_sink is None or self._emit_policy == "off":
            return
        if self._emit_policy == "denials_only" and isinstance(decision, Allow):
            return
        latency_ms = (time.perf_counter() - start) * 1000.0
        event = build_audit_event(ctx, decision, chain, latency_ms)
        try:
            self.audit_sink.emit(event)
        except Exception:  # noqa: BLE001 — RFC § 9.4: audit failure never fails evaluation
            pass


__all__ = ["PolicyEngine", "EmitPolicy", "build_audit_event"]
