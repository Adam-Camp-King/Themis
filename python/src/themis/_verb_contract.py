# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""Verb contract helpers (RFC v0.3 draft § 2.8, § 9.6) — mirrors
``packages/core/src/internal/verb_contract.ts`` rule for rule."""
from __future__ import annotations

from typing import Any, Mapping, Optional

_SNAPSHOT_STRINGS = ("id", "version", "summary", "side_effects", "reversibility", "provenance")


def usable_contract(c: Any) -> Optional[Mapping[str, Any]]:
    """A contract the engine can use: a mapping with a str id."""
    return c if isinstance(c, Mapping) and isinstance(c.get("id"), str) else None


def impacts_of(c: Mapping[str, Any]) -> list[str]:
    """The impacts a contract lists, or [] unless ``impacts`` is a list of str."""
    v = c.get("impacts")
    return list(v) if isinstance(v, (list, tuple)) and all(isinstance(x, str) for x in v) else []


def contract_matches_verb(contract_id: str, verb: str) -> bool:
    """Qualified verbs match exactly; unqualified ones match the name after the first ':'."""
    if ":" in verb:
        return contract_id == verb
    ns, sep, name = contract_id.partition(":")
    return bool(sep) and name == verb


def recordable_contract(c: Any) -> Optional[dict[str, Any]]:
    """The snapshot an audit event records, or None when there is no usable contract."""
    contract = usable_contract(c)
    if contract is None:
        return None
    out: dict[str, Any] = {}
    for k in _SNAPSHOT_STRINGS:
        v = contract.get(k)
        if isinstance(v, str):
            out[k] = v
    impacts = contract.get("impacts")
    if isinstance(impacts, (list, tuple)) and all(isinstance(x, str) for x in impacts):
        out["impacts"] = list(impacts)
    if isinstance(contract.get("requires_consent"), bool):
        out["requires_consent"] = contract["requires_consent"]
    return out


__all__ = ["usable_contract", "impacts_of", "contract_matches_verb", "recordable_contract"]
