# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""DefaultQuarantinePolicy — the agent-firewall hard stop (RFC v0.2 § 5.4).

A quarantined agent's actions are denied outright until an owner releases it.
The flag may come from ``requestor.metadata["quarantined"]`` (an identified
agent) or ``policy_metadata["quarantine"]["quarantined"]`` (a surface-level
hold). Pure — the store that set the flag is the implementation's business.
"""
from __future__ import annotations

from ..types import Allow, Decision, Deny, PolicyContext


class DefaultQuarantinePolicy:
    name = "quarantine"

    def evaluate(self, ctx: PolicyContext) -> Decision:
        meta = (ctx.policy_metadata or {}).get(self.name) or {}
        rmeta = ctx.requestor.metadata or {}
        if rmeta.get("quarantined") is not True and meta.get("quarantined") is not True:
            return Allow(policy=self.name)
        reason = meta.get("quarantine_reason", rmeta.get("quarantine_reason"))
        return Deny(
            policy=self.name,
            reason="agent_quarantined",
            message="This agent is quarantined. An owner must release it before it can act again.",
            detail={"quarantine_reason": reason},
        )


__all__ = ["DefaultQuarantinePolicy"]
