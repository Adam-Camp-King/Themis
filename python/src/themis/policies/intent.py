# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""DefaultIntentPolicy — an agent that will not say why does not act (RFC v0.3 draft § 5.7).

Decision rules (normative, identical to ``themis-policy``):

  1. ``requestor.kind`` is not one of the configured kinds → allow.
     Default kinds: ``("agent",)``.
  2. ``action.intent`` is a mapping whose ``summary`` is a ``str`` with at least
     one character outside Unicode White_Space ∪ {U+FEFF} → allow.
  3. Otherwise deny ``{reason: 'intent_missing'}``.

The policy checks that an intent was *stated*, not that it is true. Register it
first so even a refused action that stated nothing is recorded as such.
"""
from __future__ import annotations

from typing import Iterable, Mapping

from .._intent import is_blank_summary
from ..types import Allow, Decision, Deny, PolicyContext, RequestorKind


class DefaultIntentPolicy:
    name = "intent"

    def __init__(self, kinds: Iterable[RequestorKind] = ("agent",)) -> None:
        if isinstance(kinds, (str, bytes)):
            raise TypeError("DefaultIntentPolicy: kinds must be a list of strings")
        kinds = tuple(kinds)
        if not all(isinstance(k, str) for k in kinds):
            raise TypeError("DefaultIntentPolicy: kinds must be a list of strings")
        self._kinds = frozenset(kinds)

    def evaluate(self, ctx: PolicyContext) -> Decision:
        kind = ctx.requestor.kind
        if kind not in self._kinds:
            return Allow(policy=self.name)
        intent = ctx.action.intent
        summary = intent.get("summary") if isinstance(intent, Mapping) else None
        if not is_blank_summary(summary):
            return Allow(policy=self.name)
        return Deny(
            policy=self.name,
            reason="intent_missing",
            message=f"This {kind} action has no stated intent. Set action.intent.summary to say what it is for.",
            detail={"requestor_kind": kind},
        )


__all__ = ["DefaultIntentPolicy"]
