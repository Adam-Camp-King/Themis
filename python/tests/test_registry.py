# SPDX-License-Identifier: Apache-2.0
"""Registries, the MCP mapping and the shipped examples (RFC v0.3 draft § 2.8).
Runs spec/conformance/mcp-mapping.json, the same file themis-policy runs, and
validates every example contract against spec/schema/verb-contract.schema.json."""
from __future__ import annotations

import asyncio
import json
import pathlib

import jsonschema
import pytest

from themis import ChainVerbRegistry, StaticVerbRegistry, contract_from_mcp_tool, is_verb_id

SPEC = pathlib.Path(__file__).resolve().parents[2] / "spec"
SCHEMA = json.loads((SPEC / "schema" / "verb-contract.schema.json").read_text())
EXAMPLES = sorted((SPEC / "examples" / "verbs").glob("*.json"))
MCP = json.loads((SPEC / "conformance" / "mcp-mapping.json").read_text())


@pytest.mark.parametrize("c", [pytest.param(c, id=c["name"]) for c in MCP["cases"]])
def test_mcp_mapping_vector(c: dict) -> None:
    if c.get("expect_error"):
        with pytest.raises(TypeError):
            contract_from_mcp_tool(c["server"], c["tool"])
    else:
        assert contract_from_mcp_tool(c["server"], c["tool"]) == c["expect"]


@pytest.mark.parametrize("c", [pytest.param(c, id=c["name"]) for c in MCP["cases"] if not c.get("expect_error")])
def test_mcp_mapping_output_is_schema_valid(c: dict) -> None:
    jsonschema.validate(c["expect"], SCHEMA)


def _example_contracts():
    for f in EXAMPLES:
        for c in json.loads(f.read_text())["contracts"]:
            yield pytest.param(c, id=f"{f.name} › {c['id']}")


@pytest.mark.parametrize("c", list(_example_contracts()))
def test_example_contracts_are_schema_valid(c: dict) -> None:
    jsonschema.validate(c, SCHEMA)
    assert is_verb_id(c["id"])


@pytest.mark.parametrize("bad", [
    {"id": "acme:x", "side_effects": "write", "provenance": "curated"},                                  # write needs reversibility
    {"id": "acme:x", "side_effects": "write", "reversibility": "irreversible", "undone_by": "acme:y", "provenance": "curated"},
    {"id": "Acme:x", "side_effects": "read", "provenance": "curated"},                                    # bad namespace
    {"id": "acme:x", "side_effects": "read", "provenance": "trusted"},
    {"id": "acme:x", "side_effects": "read", "provenance": "curated", "impacts": ["moneyy"]},
    {"id": "acme:x", "side_effects": "read", "provenance": "curated", "colour": "red"},
    {"id": "acme:x\n", "side_effects": "read", "provenance": "curated"},                                # trailing newline
    {"id": "a:x\ufeffy", "side_effects": "read", "provenance": "curated"},
    {"id": "acme:x", "side_effects": "read", "provenance": "curated", "input_schema": []},
    {"id": "acme:x", "side_effects": "read", "provenance": "curated", "acts_on": {"noun": "n", "party": 1}},
])
def test_schema_rejects_bad_contracts(bad: dict) -> None:
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(bad, SCHEMA)


PAY = {"id": "com.solidnumber:payment_link.send", "side_effects": "write", "reversibility": "irreversible", "provenance": "curated"}
NOTE = {"id": "acme:note.add", "side_effects": "write", "reversibility": "reversible", "provenance": "curated"}


def test_static_registry() -> None:
    r = StaticVerbRegistry([PAY, NOTE], default_namespace="com.solidnumber")
    assert r.resolve("com.solidnumber:payment_link.send") is PAY
    assert r.resolve("payment_link.send") is PAY
    assert r.resolve("note.add") is None
    assert r.resolve("acme:note.add") is NOTE
    with pytest.raises(ValueError):
        StaticVerbRegistry([PAY, PAY])


def test_chain_registry_curated_shadows_declared() -> None:
    declared = contract_from_mcp_tool("github", {"name": "create_issue"})
    curated = {**declared, "reversibility": "reversible", "provenance": "curated"}
    chain = ChainVerbRegistry([StaticVerbRegistry([curated]), StaticVerbRegistry([declared])])
    assert chain.resolve("mcp:github/create_issue")["provenance"] == "curated"
    assert chain.resolve("mcp:github/nope") is None

    class Async:
        async def resolve(self, verb):  # noqa: ANN001, ANN201
            return curated if verb == "mcp:github/create_issue" else None

    assert asyncio.run(ChainVerbRegistry([Async()]).resolve_async("mcp:github/create_issue")) is curated
    with pytest.raises(TypeError):
        ChainVerbRegistry([Async()]).resolve("x:y")


def test_verb_id_grammar_matches_typescript() -> None:
    for ok in ["com.solidnumber:payment_link.send", "acme:refund.issue", "mcp:github/create_issue", "skill:pdf-fill", "a:b:c"]:
        assert is_verb_id(ok), ok
    for bad in ["payment_link.send", "Acme:x", ":x", "acme:", "acme: x", "ac me:x", "", 42,
                "acme:x\n", "a:x\x1cy", "a:x\x85y", "a:x\ufeffy", "a:x\xa0y"]:
        assert not is_verb_id(bad), bad
