# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""Decision narrowing helpers — the Python twins of ``@themis/core`` guards."""
from __future__ import annotations

from typing import TypeGuard

from .types import Allow, Decision, Deny, Redirect, RequireApproval


def is_allow(d: Decision) -> TypeGuard[Allow]:
    return isinstance(d, Allow)


def is_deny(d: Decision) -> TypeGuard[Deny]:
    return isinstance(d, Deny)


def is_redirect(d: Decision) -> TypeGuard[Redirect]:
    return isinstance(d, Redirect)


def is_require_approval(d: Decision) -> TypeGuard[RequireApproval]:
    return isinstance(d, RequireApproval)


__all__ = ["is_allow", "is_deny", "is_redirect", "is_require_approval"]
