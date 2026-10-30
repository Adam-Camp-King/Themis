# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""Verb registries and the MCP mapping (RFC v0.3 draft § 2.8.1, § 2.8.4) —
mirrors ``packages/core/src/registry.ts``. Themis ships no catalog: implement
``VerbRegistry`` against yours, and chain registries in trust order."""
from __future__ import annotations

import inspect
import re
from typing import Any, Iterable, Mapping, Optional, Protocol, Sequence, runtime_checkable

# `<namespace>:<name>`; the name excludes C0/C1 controls, space, DEL, Unicode
# White_Space and U+FEFF. Spelled out because `\S` differs from JavaScript.
_VERB_ID = re.compile("[a-z0-9][a-z0-9._-]*:[^\x00-\x20\x7f-\x9f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")


def is_verb_id(s: Any) -> bool:
    return isinstance(s, str) and _VERB_ID.fullmatch(s) is not None


@runtime_checkable
class VerbRegistry(Protocol):
    def resolve(self, verb: str) -> Optional[Mapping[str, Any]]: ...


class StaticVerbRegistry:
    def __init__(self, contracts: Iterable[Mapping[str, Any]], default_namespace: Optional[str] = None) -> None:
        self._by_id: dict[str, Mapping[str, Any]] = {}
        for c in contracts:
            if c["id"] in self._by_id:
                raise ValueError(f"StaticVerbRegistry: duplicate verb id '{c['id']}'")
            self._by_id[c["id"]] = c
        self._default_ns = default_namespace

    def resolve(self, verb: str) -> Optional[Mapping[str, Any]]:
        hit = self._by_id.get(verb)
        if hit is not None:
            return hit
        if ":" not in verb and self._default_ns:
            return self._by_id.get(f"{self._default_ns}:{verb}")
        return None

    def contracts(self) -> list[Mapping[str, Any]]:
        return list(self._by_id.values())


class ChainVerbRegistry:
    """First registry to resolve the verb wins. Order them by trust."""

    def __init__(self, registries: Sequence[VerbRegistry]) -> None:
        self._registries = tuple(registries)

    def resolve(self, verb: str) -> Optional[Mapping[str, Any]]:
        for r in self._registries:
            c = r.resolve(verb)
            if inspect.isawaitable(c):
                if inspect.iscoroutine(c):
                    c.close()
                raise TypeError("ChainVerbRegistry.resolve is synchronous; use resolve_async with async registries")
            if c is not None:
                return c
        return None

    async def resolve_async(self, verb: str) -> Optional[Mapping[str, Any]]:
        for r in self._registries:
            c = r.resolve(verb)
            if inspect.isawaitable(c):
                c = await c
            if c is not None:
                return c
        return None


def contract_from_mcp_tool(server: str, tool: Mapping[str, Any]) -> dict[str, Any]:
    """Map an MCP ``tools/list`` entry to a *declared* contract. Non-bool hints fall
    back to MCP's defaults: readOnly False, destructive True, idempotent False, openWorld True."""
    name = tool.get("name")
    if not isinstance(name, str) or name == "":
        raise TypeError("contract_from_mcp_tool: the MCP tool has no name")
    a = tool.get("annotations")
    if not isinstance(a, Mapping):
        a = {}

    def hint(k: str, default: bool) -> bool:
        v = a.get(k)
        return v if isinstance(v, bool) else default

    desc, title = tool.get("description"), a.get("title")
    summary = desc if isinstance(desc, str) else title if isinstance(title, str) else None
    read_only = hint("readOnlyHint", False)
    out: dict[str, Any] = {"id": f"mcp:{server}/{name}"}
    if summary is not None:
        out["summary"] = summary
    out["side_effects"] = "read" if read_only else "write"
    if not read_only:
        out["reversibility"] = "irreversible" if hint("destructiveHint", True) else "reversible"
        if hint("openWorldHint", True):
            out["impacts"] = ["outbound"]
        out["idempotent"] = hint("idempotentHint", False)
    if isinstance(tool.get("inputSchema"), Mapping):
        out["input_schema"] = tool["inputSchema"]
    if isinstance(tool.get("outputSchema"), Mapping):
        out["output_schema"] = tool["outputSchema"]
    out["provenance"] = "declared"
    out["extensions"] = {"mcp": {"server": server, "tool": name}}
    return out


__all__ = ["is_verb_id", "VerbRegistry", "StaticVerbRegistry", "ChainVerbRegistry", "contract_from_mcp_tool"]
