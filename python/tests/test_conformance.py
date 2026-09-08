# SPDX-License-Identifier: Apache-2.0
"""Run spec/conformance/v0/*.json and preview-tokens.json through the Python kernel.

The same files are run by themis-policy. Passing them is what "conforms to
Themis RFC v0" means (RFC § 11).
"""
from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest

from themis import (
    Action, Allow, DefaultAnomalyPolicy, DefaultDraftPolicy, DefaultLockPolicy, DefaultQuarantinePolicy,
    DefaultRateLimitPolicy, DefaultScopePolicy, Deny, DraftableEntity, LockableEntity, MemorySink, PolicyContext,
    PolicyEngine, Redirect, RequireApproval, Requestor,
)

SPEC = pathlib.Path(__file__).resolve().parents[2] / "spec" / "conformance"
VECTOR_FILES = sorted((SPEC / "v0").glob("*.json"))


class _Stub:
    def __init__(self, spec: dict[str, Any]) -> None:
        self.name = spec["name"]
        self._spec = spec

    def evaluate(self, ctx: PolicyContext):
        s = self._spec
        kind = s["stub"]
        if kind == "allow":
            return Allow(policy=self.name)
        if kind == "deny":
            return Deny(policy=self.name, reason=str(s.get("reason", "stub")), message=s.get("message"))
        if kind == "redirect":
            return Redirect(policy=self.name, target="draft", payload=s.get("payload"))
        if kind == "require_approval":
            return RequireApproval(policy=self.name, approval_ref=str(s.get("approval_ref", "ref")), message=s.get("message"))
        raise ValueError(kind)


def _build(spec: Any):
    if spec == "lock":
        return DefaultLockPolicy()
    if spec == "draft":
        return DefaultDraftPolicy()
    if spec == "scope":
        return DefaultScopePolicy()
    if spec == "quarantine":
        return DefaultQuarantinePolicy()
    if spec == "rate_limit":
        return DefaultRateLimitPolicy()
    if spec == "anomaly":
        return DefaultAnomalyPolicy()
    if "stub" in spec:
        return _Stub(spec)
    p = DefaultScopePolicy()
    for r in spec.get("rules", []):
        p.add_rule((r["method"], r["path"]), r["required_scope"])
    return p


def _entity(e: Any):
    if e is None:
        return None
    if "locks" in e and "agency_owner_id" in e:
        return LockableEntity(id=e["id"], tenant_id=e["tenant_id"], agency_owner_id=e["agency_owner_id"], locks=dict(e["locks"]))
    return DraftableEntity(
        id=e["id"], tenant_id=e["tenant_id"], is_published=e["is_published"],
        has_pending_draft=e.get("has_pending_draft", False),
        draft_updated_at=e.get("draft_updated_at"), draft_updated_by=e.get("draft_updated_by"),
    )


def _canon(v: Any) -> Any:
    if isinstance(v, list):
        return [_canon(x) for x in v]
    if isinstance(v, dict):
        return {k: _canon(x) for k, x in v.items() if x is not None}
    return v


def _cases():
    for f in VECTOR_FILES:
        for c in json.loads(f.read_text())["cases"]:
            yield pytest.param(c, id=f"{f.name} › {c['name']}")


@pytest.mark.parametrize("c", list(_cases()))
def test_vector(c: dict[str, Any]) -> None:
    sink = MemorySink()
    engine = PolicyEngine(audit_sink=sink, emit_policy=c.get("emit_policy", "all"))
    for p in c.get("policies", []):
        engine.add_policy(_build(p))
    r, a = c["requestor"], c["action"]
    ctx = PolicyContext(
        requestor=Requestor(id=r["id"], kind=r["kind"], tenant_id=r["tenant_id"], scopes=tuple(r.get("scopes", [])),
                            role=r.get("role"), is_super_admin=r.get("is_super_admin"), metadata=r.get("metadata")),
        action=Action(verb=a["verb"], resource_type=a["resource_type"], tenant_id=a["tenant_id"], resource_id=a.get("resource_id"),
                      area=a.get("area"), required_scope=a.get("required_scope"), payload=a.get("payload"), metadata=a.get("metadata")),
        entity=_entity(c.get("entity")),
        now=1_700_000_000_000,
        correlation_id=f"conf-{c['name']}",
        policy_metadata=c.get("policy_metadata"),
    )
    decision = engine.evaluate(ctx)
    assert _canon(decision.to_dict()) == _canon(c["expect"]["decision"])
    audit = c["expect"].get("audit")
    if audit == "none":
        assert sink.events == []
        return
    assert len(sink.events) == 1, "exactly one audit event per evaluation"
    e = sink.events[0]
    assert list(e.policy_chain) == c["expect"]["policy_chain"]
    assert _canon(e.decision.to_dict()) == _canon(c["expect"]["decision"])
    assert e.tenant_id == a["tenant_id"]
    assert e.correlation_id == ctx.correlation_id
    if isinstance(audit, dict):
        got = _canon({"requestor": dict(e.requestor), "action": dict(e.action)})
        assert got == _canon(audit)


def test_preview_tokens() -> None:
    doc = json.loads((SPEC / "preview-tokens.json").read_text())
    p = DefaultDraftPolicy()
    for c in doc["cases"]:
        assert p.verify_preview_token(c["token"], doc["secret"]) == c["expect"], c["name"]


def test_sign_then_verify_roundtrip_and_ttl_clamp() -> None:
    p = DefaultDraftPolicy()
    tok = p.sign_preview_token(42, 7, 24, "s3cret")
    assert p.verify_preview_token(tok, "s3cret") == {"entity_id": 42, "tenant_id": 7}
    assert p.verify_preview_token(tok, "other") is None
    with pytest.raises(ValueError):
        p.sign_preview_token(1, 1, 1, "")


def test_audit_sink_failure_never_fails_evaluation() -> None:
    class Boom:
        def emit(self, event):  # noqa: ANN001
            raise RuntimeError("sink down")
    engine = PolicyEngine(audit_sink=Boom())
    r = Requestor(id=1, kind="user", tenant_id=1)
    assert engine.evaluate(PolicyContext(requestor=r, action=Action(verb="x", resource_type="y", tenant_id=1), now=0, correlation_id="c")) == Allow()
