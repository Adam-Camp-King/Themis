# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""DefaultVerbContractPolicy — decide from what a verb does, not what it is called
(RFC v0.3 draft § 5.8). Rules identical to ``themis-policy``; see the TS source or
spec/verb-contract.md. A malformed contract never fails open."""
from __future__ import annotations

from typing import Any, Iterable, Literal, Mapping, Optional

from .._verb_contract import contract_matches_verb, read_impacts, usable_contract
from ..types import Allow, Decision, Deny, PolicyContext, RequestorKind, RequireApproval

DEFAULT_APPROVAL_IMPACTS: tuple[str, ...] = ("money", "access", "deletion", "data_export")
_REVERSIBILITY = frozenset({"reversible", "compensable", "irreversible"})
_CHOICES = ("require_approval", "trust")


def _str_list(name: str, v: Any) -> tuple[str, ...]:
    if isinstance(v, (str, bytes)) or not isinstance(v, Iterable):
        raise TypeError(f"DefaultVerbContractPolicy: {name} must be a list of strings")
    out = tuple(v)
    if not all(isinstance(x, str) for x in out):
        raise TypeError(f"DefaultVerbContractPolicy: {name} must be a list of strings")
    return out


class DefaultVerbContractPolicy:
    name = "verb_contract"

    def __init__(
        self,
        require_contract_for: Iterable[RequestorKind] = ("agent",),
        approval_impacts: Iterable[str] = DEFAULT_APPROVAL_IMPACTS,
        approve_irreversible: bool = True,
        declared_writes: Literal["require_approval", "trust"] = "require_approval",
        declared_reads: Literal["require_approval", "trust"] = "require_approval",
        default_namespace: Optional[str] = None,
    ) -> None:
        self._require_for = frozenset(_str_list("require_contract_for", require_contract_for))
        self._approval_impacts = _str_list("approval_impacts", approval_impacts)
        if not isinstance(approve_irreversible, bool):
            raise TypeError("DefaultVerbContractPolicy: approve_irreversible must be True or False")
        for n, v in (("declared_writes", declared_writes), ("declared_reads", declared_reads)):
            if v not in _CHOICES:
                raise TypeError(f"DefaultVerbContractPolicy: {n} must be one of {', '.join(_CHOICES)}")
        if default_namespace is not None and not isinstance(default_namespace, str):
            raise TypeError("DefaultVerbContractPolicy: default_namespace must be a string")
        self._approve_irreversible = approve_irreversible
        self._declared_writes = declared_writes
        self._declared_reads = declared_reads
        self._default_namespace = default_namespace

    def evaluate(self, ctx: PolicyContext) -> Decision:
        verb = ctx.action.verb
        contract = usable_contract(ctx.verb_contract)

        if contract is None:  # rule 1
            if ctx.requestor.kind not in self._require_for:
                return Allow(policy=self.name)
            return Deny(policy=self.name, reason="unknown_verb",
                        message=f"{verb} has no verb contract. Register one so Themis knows what it does.",
                        detail={"verb": verb})
        cid = contract["id"]

        if not contract_matches_verb(cid, verb, self._default_namespace):  # rule 2
            return Deny(policy=self.name, reason="contract_mismatch",
                        message=f"The verb contract {cid} does not describe {verb}.",
                        detail={"verb": verb, "contract_id": cid})

        meta = (ctx.policy_metadata or {}).get(self.name)
        if isinstance(meta, Mapping) and meta.get("approved") is True:  # rule 3
            return Allow(policy=self.name)

        reasons: list[str] = []  # rule 4
        se = contract.get("side_effects")
        is_read = se == "read" and isinstance(se, str)
        if contract.get("requires_consent") is True:
            reasons.append("requires_consent")
        if not is_read:
            if not (isinstance(se, str) and se in ("write", "mixed")):
                reasons.append("side_effects_unknown")
            rev = contract.get("reversibility")
            if not isinstance(rev, str) or rev not in _REVERSIBILITY:
                reasons.append("reversibility_unknown")
            elif rev == "irreversible" and self._approve_irreversible:
                reasons.append("irreversible")
        impacts, unknown = read_impacts(contract)
        if unknown:
            reasons.append("impacts_unknown")
        listed = set(impacts)
        reasons.extend(f"impact:{i}" for i in self._approval_impacts if i in listed)
        if contract.get("provenance") != "curated":
            if is_read and self._declared_reads == "require_approval":
                reasons.append("declared_read")
            if not is_read and self._declared_writes == "require_approval":
                reasons.append("declared_write")

        if not reasons:  # rule 5
            return Allow(policy=self.name)
        ref = meta.get("approval_ref") if isinstance(meta, Mapping) else None
        return RequireApproval(policy=self.name, approval_ref=ref if isinstance(ref, str) else f"verb:{cid}",
                               message=f"Needs approval before {cid} runs: {', '.join(reasons)}.")


__all__ = ["DefaultVerbContractPolicy", "DEFAULT_APPROVAL_IMPACTS"]
