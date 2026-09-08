# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""DefaultScopePolicy — flat-membership scope authorization (RFC v0 § 5.3).

Decision rule, first match wins:
  1. requestor.is_super_admin                    → allow
  2. '*' in requestor.scopes                     → allow
  3. requestor.kind == 'user' and no scopes      → allow  (session user)
  4. required scope resolves to None             → allow
  5. required scope in requestor.scopes          → allow
  6. otherwise                                   → deny
``required_scope`` comes from the action first, else from the registered rule
table (method + path string/regex, or a predicate). Flat membership: no
implied hierarchy; wildcards beyond '*' are extensions, not core.
"""
from __future__ import annotations

import re
from typing import Callable, Optional, Pattern, Union

from ..types import Allow, Decision, Deny, PolicyContext

Matcher = Union[tuple[str, Union[str, Pattern[str]]], Callable[[PolicyContext], bool]]


class DefaultScopePolicy:
    name = "scope"

    def __init__(self) -> None:
        self._rules: list[tuple[Matcher, str]] = []

    def evaluate(self, ctx: PolicyContext) -> Decision:
        r = ctx.requestor
        if r.is_super_admin is True:
            return Allow(policy=self.name)
        if "*" in r.scopes:
            return Allow(policy=self.name)
        if r.kind == "user" and len(r.scopes) == 0:
            return Allow(policy=self.name)
        required = ctx.action.required_scope or self._resolve_required(ctx)
        if not required:
            return Allow(policy=self.name)
        if required in r.scopes:
            return Allow(policy=self.name)
        return Deny(
            policy=self.name,
            reason="missing_scope",
            message=f"Missing required scope '{required}'.",
            detail={"required": required, "held": list(r.scopes)},
        )

    def add_rule(self, matcher: Matcher, required_scope: str) -> None:
        self._rules.append((matcher, required_scope))

    def list_scopes(self) -> list[str]:
        seen: dict[str, None] = {}
        for _, s in self._rules:
            seen.setdefault(s, None)
        return list(seen)

    def _resolve_required(self, ctx: PolicyContext) -> Optional[str]:
        meta = ctx.action.metadata or {}
        method = str(meta.get("method", "") or "")
        path = str(meta.get("path", "") or "")
        for matcher, scope in self._rules:
            if callable(matcher):
                if matcher(ctx):
                    return scope
                continue
            m_method, m_path = matcher
            if method.upper() != m_method.upper():
                continue
            if isinstance(m_path, str):
                if path == m_path:
                    return scope
            elif m_path.search(path):
                return scope
        return None


__all__ = ["DefaultScopePolicy"]
