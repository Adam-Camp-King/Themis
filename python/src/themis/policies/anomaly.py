# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""DefaultAnomalyPolicy + score_action (RFC v0.2 § 5.6).

Two halves, summed and clamped to 0–1. Hard heuristics fire from day one
(bulk delete 0.97, custom-tier scope escalation 0.90, off-hours burst 0.85,
oversized payload +0.30). The statistical half — a z-score of today's count
against the baseline's daily series — contributes nothing until the baseline
has ≥ MIN_BASELINE_SAMPLE actions over ≥ MIN_BASELINE_DAYS days and is
fresher than BASELINE_MAX_AGE_MS. Reads always score 0.

Pure: the implementation calls ``score_action`` and passes the ``RiskScore``
on ``policy_metadata["anomaly"]``. ``risk > HARD_BLOCK`` → deny
``anomaly_hard_block``; ``risk > SOFT_BLOCK`` → require_approval; else allow.
Mirrors ``packages/core/src/policies/anomaly.ts`` one-for-one.
"""
from __future__ import annotations

import math

from ..types import Allow, AnomalyInput, Decision, Deny, PolicyContext, RequireApproval, RiskScore

SOFT_BLOCK = 0.80
HARD_BLOCK = 0.95
BULK_DELETE_THRESHOLD = 10
BURST_THRESHOLD = 60
OFF_HOURS: tuple[int, int] = (0, 5)
PAYLOAD_SOFT_BYTES = 200_000
MIN_BASELINE_SAMPLE = 200
MIN_BASELINE_DAYS = 7
BASELINE_MAX_AGE_MS = 48 * 3600 * 1000
Z_TRIGGER = 3.0
Z_MAX_CONTRIBUTION = 0.60
ESCALATION_NAMESPACES = frozenset({
    "team", "gdpr", "billing", "subscription", "subscriptions", "security", "audit",
    "ai_employee", "ai_employees",
})
_DELETE_WORDS = ("delete", "remove", "purge", "destroy")


def is_delete_verb(verb: str) -> bool:
    v = verb.lower()
    return any(w in v for w in _DELETE_WORDS)


def namespace_of(verb: str) -> str:
    if "." in verb:
        return verb.split(".", 1)[0]
    if "_" in verb:
        return verb.split("_", 1)[0]
    return verb


def escalation_namespace_of(verb: str) -> str | None:
    """The escalation entry a verb falls under, or None. An entry matches when
    it IS the verb or precedes a ``.``/``_`` boundary — never mid-word, so a
    set entry that happens to prefix another namespace's name (``team`` vs the
    ``teams.*`` Teams-integration verbs) does not match. Longest entry wins.
    This exists because ``namespace_of`` cuts at the FIRST separator, which can
    never reach a multi-word entry: ``ai_employee_enable`` → ``ai``, not
    ``ai_employee``."""
    match: str | None = None
    for ns in ESCALATION_NAMESPACES:
        if verb != ns and not verb.startswith(ns + ".") and not verb.startswith(ns + "_"):
            continue
        if match is None or len(ns) > len(match):
            match = ns
    return match


def score_action(inp: AnomalyInput) -> RiskScore:
    if inp.side_effects not in ("write", "mixed"):
        return RiskScore()
    risk = 0.0
    reasons: list[str] = []

    def add(amount: float, reason: str) -> None:
        nonlocal risk
        risk = min(1.0, round(risk + amount, 4))
        reasons.append(reason)

    if is_delete_verb(inp.verb) and inp.recent_deletes + 1 >= BULK_DELETE_THRESHOLD:
        add(0.97, f"bulk_delete:{inp.recent_deletes + 1}_in_10m")
    ns = escalation_namespace_of(inp.verb)
    if inp.trust_tier == "custom" and ns is not None:
        add(0.90, f"scope_escalation:{ns}")
    if OFF_HOURS[0] <= inp.local_hour < OFF_HOURS[1] and inp.recent_writes + 1 >= BURST_THRESHOLD:
        add(0.85, f"off_hours_burst:{inp.recent_writes + 1}_in_5m@{inp.local_hour:02d}h")
    if inp.payload_bytes > PAYLOAD_SOFT_BYTES:
        add(0.30, f"oversized_payload:{inp.payload_bytes}b")

    sample = 0
    used = False
    base = inp.baseline
    if base is not None:
        sample = int(base.total_actions)
        daily = [float(v) for v in base.daily_counts.values()]
        fresh = (inp.now - base.computed_at) <= BASELINE_MAX_AGE_MS
        if base.total_actions >= MIN_BASELINE_SAMPLE and len(daily) >= MIN_BASELINE_DAYS and base.sample_days >= MIN_BASELINE_DAYS and fresh:
            used = True
            mean = sum(daily) / len(daily)
            variance = sum((d - mean) ** 2 for d in daily) / len(daily)
            std = math.sqrt(variance) or 1.0
            today = inp.today_count if inp.today_count is not None else 1
            z = (today - mean) / std
            if z > Z_TRIGGER:
                add(min(Z_MAX_CONTRIBUTION, round((z - Z_TRIGGER) / 10.0, 4)), f"volume_z:{z:.1f}")
            counts = base.action_counts
            if counts and f"policy:{inp.verb}" not in counts and inp.verb not in counts:
                add(0.15, "never_seen_action")
    return RiskScore(risk=risk, reasons=tuple(reasons), baseline_sample=sample, baseline_used=used)


class DefaultAnomalyPolicy:
    name = "anomaly"

    def evaluate(self, ctx: PolicyContext) -> Decision:
        s = (ctx.policy_metadata or {}).get(self.name)
        if not s or not isinstance(s.get("risk"), (int, float)):
            return Allow(policy=self.name)
        risk = float(s["risk"])
        reasons = list(s.get("reasons") or [])
        if risk > HARD_BLOCK:
            return Deny(
                policy=self.name,
                reason="anomaly_hard_block",
                message=f"Blocked: risk {risk:.2f} ({', '.join(reasons)}). The agent has been quarantined.",
                detail={"risk": risk, "reasons": reasons, "baseline_sample": int(s.get("baseline_sample") or 0),
                        "baseline_used": bool(s.get("baseline_used") or False)},
            )
        if risk > SOFT_BLOCK:
            return RequireApproval(
                policy=self.name,
                approval_ref=str(s.get("approval_ref") or "ask-owner"),
                message=f"Needs owner approval: risk {risk:.2f} ({', '.join(reasons)}).",
            )
        return Allow(policy=self.name)


__all__ = [
    "DefaultAnomalyPolicy", "score_action", "is_delete_verb", "namespace_of", "escalation_namespace_of",
    "SOFT_BLOCK", "HARD_BLOCK", "BULK_DELETE_THRESHOLD", "BURST_THRESHOLD", "OFF_HOURS", "PAYLOAD_SOFT_BYTES",
    "MIN_BASELINE_SAMPLE", "MIN_BASELINE_DAYS", "BASELINE_MAX_AGE_MS", "Z_TRIGGER", "Z_MAX_CONTRIBUTION",
    "ESCALATION_NAMESPACES",
]
