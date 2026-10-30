# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""DefaultVerbContractPolicy — decide from what a verb does, not what it is called
(RFC v0.3 draft § 5.8). Rules identical to ``themis-policy``; see the TS source or
spec/verb-contract.md."""
from __future__ import annotations

from typing import Iterable, Literal, Mapping

from .._verb_contract import contract_matches_verb, impacts_of, usable_contract
from ..types import Allow, Decision, Deny, PolicyContext, RequestorKind, RequireApproval

DEFAULT_APPROVAL_IMPACTS: tuple[str, ...] = ("money", "access", "deletion", "data_export")
_REVERSIBILITY = frozenset({"reversible", "compensable", "irreversible"})


class DefaultVerbContractPolicy:
    name = "verb_contract"

    def __init__(
        self,
        require_contract_for: Iterable[RequestorKind] = ("agent",),
        approval_impacts: Iterable[str] = DEFAULT_APPROVAL_IMPACTS,
        approve_irreversible: bool = True,
        declared_writes: Literal["require_approval", "trust"] = "require_approval",
    ) -> None:
        self._require_for = frozenset(require_contract_for)
        self._approval_impacts = tuple(approval_impacts)
        self._approve_irreversible = approve_irreversible
        self._declared_writes = declared_writes

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

        if not contract_matches_verb(cid, verb):  # rule 2
            return Deny(policy=self.name, reason="contract_mismatch",
                        message=f"The verb contract {cid} does not describe {verb}.",
                        detail={"verb": verb, "contract_id": cid})

        if contract.get("side_effects") == "read":  # rule 3
            return Allow(policy=self.name)

        meta = (ctx.policy_metadata or {}).get(self.name)
        if isinstance(meta, Mapping) and meta.get("approved") is True:  # rule 4
            return Allow(policy=self.name)

        reasons: list[str] = []  # rule 5
        if contract.get("requires_consent") is True:
            reasons.append("requires_consent")
        rev = contract.get("reversibility")
        if not isinstance(rev, str) or rev not in _REVERSIBILITY:
            reasons.append("reversibility_unknown")
        elif rev == "irreversible" and self._approve_irreversible:
            reasons.append("irreversible")
        impacts = set(impacts_of(contract))
        reasons.extend(f"impact:{i}" for i in self._approval_impacts if i in impacts)
        if self._declared_writes == "require_approval" and contract.get("provenance") != "curated":
            reasons.append("declared_write")

        if not reasons:  # rules 6–7
            return Allow(policy=self.name)
        ref = meta.get("approval_ref") if isinstance(meta, Mapping) else None
        return RequireApproval(policy=self.name, approval_ref=ref if isinstance(ref, str) else f"verb:{cid}",
                               message=f"Needs approval before {cid} runs: {', '.join(reasons)}.")


__all__ = ["DefaultVerbContractPolicy", "DEFAULT_APPROVAL_IMPACTS"]
