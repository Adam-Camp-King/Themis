# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""DefaultRateLimitPolicy + reputation (RFC v0.2 § 5.5).

An agent that misbehaves gets LESS of everything: a per-minute limit keyed by
(tenant, agent, verb), scaled by a reputation score that decays on blocks and
recovers slowly on clean writes::

    effective_limit = max(1, floor(base_limit(tier) × reputation))

Pure: the implementation runs its limiter and passes the ``RateCheck`` on
``policy_metadata["rate_limit"]``. ``count > limit`` → deny ``rate_limited``.
"""
from __future__ import annotations

from typing import Mapping

from ..types import Allow, Decision, Deny, Id, PolicyContext, RateCheck

TIER_LIMITS_PER_MIN: Mapping[str, int] = {"platform": 1000, "agency": 200, "custom": 50}
REPUTATION_FLOOR = 0.05
REPUTATION_CEILING = 1.0
RECOVERY_PER_CLEAN_WRITE = 0.002
DEDUCTIONS: Mapping[str, float] = {
    "t10_block": 0.05,
    "scope_violation": 0.10,
    "anomaly_soft_block": 0.10,
    "anomaly_hard_block": 0.25,
    "quarantine": 0.40,
    "rate_limited": 0.02,
}


def effective_limit(tier: str, reputation: float) -> int:
    base = TIER_LIMITS_PER_MIN.get(tier, TIER_LIMITS_PER_MIN["platform"])
    rep = max(REPUTATION_FLOOR, min(1.0, reputation))
    return max(1, int(base * rep))


def _clamp(v: float) -> float:
    return max(REPUTATION_FLOOR, min(REPUTATION_CEILING, round(v, 4)))


class DefaultRateLimitPolicy:
    name = "rate_limit"

    def evaluate(self, ctx: PolicyContext) -> Decision:
        c = (ctx.policy_metadata or {}).get(self.name)
        if not c or c.get("allowed") is not False:
            return Allow(policy=self.name)
        count, limit, tier, rep = c["count"], c["limit"], c["tier"], float(c["reputation"])
        return Deny(
            policy=self.name,
            reason="rate_limited",
            message=(f"Rate limit: {count}/{limit} calls this minute for '{ctx.action.verb}' "
                     f"(tier {tier}, reputation {rep:.2f}). Slow down or ask the owner to review the agent."),
            detail={"limit": limit, "count": count, "tier": tier, "reputation": rep},
        )


class MemoryRateLimiter:
    """Fixed one-minute window per (tenant, agent, verb). Counts the call it checks."""

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}

    def check(self, tenant_id: Id, agent_key: str, verb: str, tier: str, reputation: float, now: int) -> RateCheck:
        limit = effective_limit(tier, reputation)
        window = int(now // 60_000)
        key = f"{tenant_id}:{agent_key}:{verb}:{window}"
        count = self._counts.get(key, 0) + 1
        self._counts[key] = count
        if len(self._counts) > 10_000:
            for k in [k for k in self._counts if not k.endswith(f":{window}")]:
                self._counts.pop(k, None)
        return RateCheck(allowed=count <= limit, limit=limit, count=count, tier=tier, reputation=reputation)


class MemoryReputationStore:
    """In-memory reputation keyed by (tenant, agent). Starts at 1.0."""

    def __init__(self) -> None:
        self._scores: dict[str, float] = {}

    def get(self, tenant_id: Id, agent_key: str) -> float:
        return self._scores.get(f"{tenant_id}:{agent_key}", REPUTATION_CEILING)

    def deduct(self, tenant_id: Id, agent_key: str, reason: str) -> float:
        nxt = _clamp(self.get(tenant_id, agent_key) - DEDUCTIONS.get(reason, 0.05))
        self._scores[f"{tenant_id}:{agent_key}"] = nxt
        return nxt

    def recover(self, tenant_id: Id, agent_key: str) -> float:
        nxt = _clamp(self.get(tenant_id, agent_key) + RECOVERY_PER_CLEAN_WRITE)
        self._scores[f"{tenant_id}:{agent_key}"] = nxt
        return nxt


__all__ = [
    "DefaultRateLimitPolicy", "MemoryRateLimiter", "MemoryReputationStore", "effective_limit",
    "TIER_LIMITS_PER_MIN", "DEDUCTIONS", "REPUTATION_FLOOR", "REPUTATION_CEILING", "RECOVERY_PER_CLEAN_WRITE",
]
