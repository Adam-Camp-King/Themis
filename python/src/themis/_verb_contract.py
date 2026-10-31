# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""Verb contract helpers (RFC v0.3 draft § 2.8, § 9.6) — mirrors
``packages/core/src/internal/verb_contract.ts`` rule for rule."""
from __future__ import annotations

from typing import Any, Mapping, Optional

from .registry import is_verb_id

_SNAPSHOT_STRINGS = ("id", "version", "summary", "side_effects", "reversibility", "provenance")
KNOWN_IMPACTS = frozenset({"money", "access", "outbound", "deletion", "data_export", "publish"})


def _is_str_list(v: Any) -> bool:
    return isinstance(v, (list, tuple)) and all(isinstance(x, str) for x in v)


def usable_contract(c: Any) -> Optional[Mapping[str, Any]]:
    """A contract the engine can use: a mapping with a str id."""
    return c if isinstance(c, Mapping) and isinstance(c.get("id"), str) else None


def read_impacts(c: Mapping[str, Any]) -> tuple[list[str], bool]:
    """(impacts, unknown). ``unknown`` when impacts is present but not a list of
    str, or lists a value that is neither well-known nor a namespaced extension."""
    v = c.get("impacts")
    if v is None:
        return [], False
    if not _is_str_list(v):
        return [], True
    impacts = list(v)
    return impacts, any(i not in KNOWN_IMPACTS and not is_verb_id(i) for i in impacts)


def impacts_of(c: Mapping[str, Any]) -> list[str]:
    return read_impacts(c)[0]


def contract_matches_verb(contract_id: str, verb: str, default_namespace: Optional[str] = None) -> bool:
    """A qualified verb must equal the id; an unqualified one must equal
    ``<default_namespace>:<verb>`` when given, else the name after the first ':'."""
    if ":" in verb:
        return contract_id == verb
    if default_namespace is not None:
        return contract_id == f"{default_namespace}:{verb}"
    _, sep, name = contract_id.partition(":")
    return bool(sep) and name == verb


def verb_name(verb: str) -> str:
    """The part of a qualified verb id after its first ':', or the verb itself."""
    return verb.partition(":")[2] if is_verb_id(verb) else verb


def recordable_contract(c: Any) -> Optional[dict[str, Any]]:
    """The snapshot an audit event records, or None when there is no usable contract.
    Each field is read on its own: one failing lookup loses that field, not the event."""
    contract = usable_contract(c)
    if contract is None:
        return None

    def read(k: str) -> Any:
        try:
            return contract.get(k)
        except Exception:  # noqa: BLE001
            return None

    out: dict[str, Any] = {}
    for k in _SNAPSHOT_STRINGS:
        v = read(k)
        if isinstance(v, str):
            out[k] = v
    impacts = read("impacts")
    if _is_str_list(impacts):
        out["impacts"] = list(impacts)
    consent = read("requires_consent")
    if isinstance(consent, bool):
        out["requires_consent"] = consent
    return out if isinstance(out.get("id"), str) else None


__all__ = ["KNOWN_IMPACTS", "usable_contract", "read_impacts", "impacts_of", "contract_matches_verb",
           "verb_name", "recordable_contract"]
