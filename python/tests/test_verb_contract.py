# SPDX-License-Identifier: Apache-2.0
"""DefaultVerbContractPolicy and the snapshot — mirrors packages/core/test/verb_contract.test.ts."""
from __future__ import annotations

from collections import UserDict

import pytest

from themis import (Action, Allow, DefaultIntentPolicy, DefaultVerbContractPolicy, MemorySink, PolicyContext,
                    PolicyEngine, Requestor)


def _ctx(contract) -> PolicyContext:  # noqa: ANN001
    return PolicyContext(requestor=Requestor(id=1, kind="agent", tenant_id=7, scopes=("*",)),
                         action=Action(verb="acme:x", resource_type="x", tenant_id=7),
                         now=0, correlation_id="c", verb_contract=contract)


def test_options_must_be_lists_not_strings() -> None:
    with pytest.raises(TypeError):
        DefaultVerbContractPolicy(require_contract_for="agent")
    with pytest.raises(TypeError):
        DefaultVerbContractPolicy(approval_impacts="money")
    with pytest.raises(TypeError):
        DefaultVerbContractPolicy(declared_writes="yes")  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        DefaultVerbContractPolicy(approve_irreversible=1)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        DefaultIntentPolicy(kinds="agent")


def test_hostile_lookup_loses_one_field_not_the_event() -> None:
    class Hostile(UserDict):
        def get(self, k, default=None):  # noqa: ANN001, ANN201
            if k == "version":
                raise RuntimeError("boom")
            return super().get(k, default)
    sink = MemorySink()
    d = PolicyEngine(audit_sink=sink).evaluate(_ctx(Hostile(id="acme:x", side_effects="read", provenance="curated")))
    assert d == Allow()
    assert sink.events[0].verb_contract == {"id": "acme:x", "side_effects": "read", "provenance": "curated"}


def test_snapshot_is_detached() -> None:
    impacts = ["money"]
    sink = MemorySink()
    PolicyEngine(audit_sink=sink).evaluate(_ctx({"id": "acme:x", "side_effects": "write", "reversibility": "reversible",
                                                 "impacts": impacts, "provenance": "curated"}))
    impacts.append("access")
    assert sink.events[0].verb_contract["impacts"] == ["money"]


def test_a_set_of_impacts_is_impacts_unknown_not_a_pass() -> None:
    d = DefaultVerbContractPolicy().evaluate(_ctx({"id": "acme:x", "side_effects": "write", "reversibility": "reversible",
                                                   "impacts": {"money"}, "provenance": "curated"}))
    assert d.kind == "require_approval" and "impacts_unknown" in (d.message or "")


def test_bool_is_not_a_string_and_one_is_not_true() -> None:
    p = DefaultVerbContractPolicy()
    d = p.evaluate(_ctx({"id": "acme:x", "side_effects": "read", "requires_consent": 1, "provenance": "curated"}))
    assert d == Allow(policy="verb_contract")
    meta_ctx = PolicyContext(requestor=Requestor(id=1, kind="agent", tenant_id=7), now=0, correlation_id="c",
                             action=Action(verb="acme:x", resource_type="x", tenant_id=7),
                             verb_contract={"id": "acme:x", "side_effects": "write", "reversibility": "irreversible", "provenance": "curated"},
                             policy_metadata={"verb_contract": {"approved": 1}})
    assert p.evaluate(meta_ctx).kind == "require_approval"
