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


def test_non_finite_and_non_json_values_drop_the_whole_attributes() -> None:
    import datetime
    for attributes in ({"n": float("nan")}, {"n": float("inf")}, {"when": datetime.datetime(2026, 1, 1)},
                       {"s": {1, 2}}, {1: "int key"}, {"deep": [1, {"x": float("-inf")}]}):
        sink = MemorySink()
        PolicyEngine(audit_sink=sink).evaluate(_ctx({"summary": "Reconcile", "attributes": attributes}))
        assert sink.events[0].intent == {"summary": "Reconcile"}, attributes


def test_tuples_record_as_lists() -> None:
    sink = MemorySink()
    PolicyEngine(audit_sink=sink).evaluate(_ctx({"summary": "Reconcile", "attributes": {"ids": (1, 2)}}))
    assert sink.events[0].intent == {"summary": "Reconcile", "attributes": {"ids": [1, 2]}}


def test_pathologically_deep_attributes_never_raise() -> None:
    deep: dict = {}
    for _ in range(200_000):
        deep = {"a": deep}
    sink = MemorySink()
    d = PolicyEngine(audit_sink=sink).evaluate(_ctx({"summary": "Reconcile", "attributes": deep}))
    assert d == Allow()
    assert sink.events[0].intent == {"summary": "Reconcile"}


def test_unknown_keys_are_not_recorded_and_not_shared() -> None:
    plan = {"k": 1}
    sink = MemorySink()
    PolicyEngine(audit_sink=sink).evaluate(_ctx({"summary": "s", "plan": plan}))
    plan["k"] = 2
    assert sink.events[0].intent == {"summary": "s"}


def test_a_failing_event_build_never_fails_the_evaluation() -> None:
    class Hostile(dict):
        def get(self, *a, **k):  # noqa: ANN002, ANN003
            raise RuntimeError("boom")
    sink = MemorySink()
    engine = PolicyEngine(audit_sink=sink)
    d = engine.evaluate(_ctx(Hostile(summary="s")))
    assert d == Allow()
    assert sink.events == []
