# SPDX-License-Identifier: Apache-2.0
"""Intent (RFC v0.3 draft § 2.7, § 5.7, § 9.5) — mirrors packages/core/test/intent.test.ts."""
from __future__ import annotations

from themis import Action, Allow, DefaultIntentPolicy, Deny, MemorySink, PolicyContext, PolicyEngine, Requestor


def _ctx(intent=None) -> PolicyContext:
    return PolicyContext(
        requestor=Requestor(id=1, kind="agent", tenant_id=7, scopes=("*",)),
        action=Action(verb="invoice.send", resource_type="invoice", tenant_id=7, intent=intent),
        now=1_700_000_000_000,
        correlation_id="c-1",
    )


def test_audit_intent_is_detached() -> None:
    sink = MemorySink()
    intent = {"summary": "Send the March invoice", "attributes": {"step": 1, "tags": ["billing"]}}
    PolicyEngine(audit_sink=sink).evaluate(_ctx(intent))
    intent["summary"] = "something else"
    intent["attributes"]["step"] = 99
    intent["attributes"]["tags"].append("tampered")
    recorded = sink.events[0].intent
    assert recorded["summary"] == "Send the March invoice"
    assert recorded["attributes"] == {"step": 1, "tags": ["billing"]}


def test_non_serialisable_attributes_are_dropped_not_raised() -> None:
    sink = MemorySink()
    d = PolicyEngine(audit_sink=sink).evaluate(_ctx({"summary": "Reconcile", "attributes": {"when": object()}}))
    assert d == Allow()
    assert len(sink.events) == 1
    assert sink.events[0].intent == {"summary": "Reconcile"}


def test_no_intent_means_no_intent_key_on_the_wire() -> None:
    sink = MemorySink()
    PolicyEngine(audit_sink=sink).evaluate(_ctx(None))
    assert "intent" not in sink.events[0].to_dict()


def test_other_fields_alone_do_not_satisfy_the_policy() -> None:
    d = DefaultIntentPolicy().evaluate(_ctx({"source": "user_request", "tool_call_id": "toolu_9"}))
    assert isinstance(d, Deny) and d.reason == "intent_missing"


def test_empty_kinds_never_denies() -> None:
    assert DefaultIntentPolicy(kinds=()).evaluate(_ctx(None)) == Allow(policy="intent")
