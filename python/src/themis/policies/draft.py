# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""DefaultDraftPolicy — the T12 primitive (RFC v0 § 5.2, § 9.3).

Decision rule:
  1. entity is None (create)                → allow
  2. entity is not draftable                → allow  (inert)
  3. entity.is_published is not True        → allow
  4. action.payload['publish'] is True      → allow  (explicit live write)
  5. otherwise                              → redirect {target: 'draft', payload}

Preview token — byte-identical to ``@themis/core``:
  base64url( "v1.<entity_id>.<tenant_id>.<exp_ms>" + "." + hmac_sha256_hex )
Verify uses constant-time comparison, rejects expired/tampered/wrong-secret/
wrong-version tokens, and clamps TTL to 168 hours.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import math
import re
import time
from typing import Any, Mapping, Optional, Union

from ..types import Allow, Decision, DraftableEntity, Id, PolicyContext, Redirect

TOKEN_VERSION = "v1"
MAX_TTL_HOURS = 168
DEFAULT_TTL_HOURS = 24
_INT = re.compile(r"^-?\d+$")


def _b64url(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii").rstrip("=")


def _from_b64url(s: str) -> str:
    pad = (4 - len(s) % 4) % 4
    return base64.urlsafe_b64decode((s + "=" * pad).encode("ascii")).decode("utf-8")


def _hmac(secret: str, payload: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def _clamp_ttl(hours: float) -> int:
    if not isinstance(hours, (int, float)) or math.isnan(hours) or math.isinf(hours) or hours <= 0:
        return DEFAULT_TTL_HOURS
    if hours > MAX_TTL_HOURS:
        return MAX_TTL_HOURS
    return int(hours)


def _id_maybe_numeric(s: str) -> Id:
    if _INT.match(s):
        n = int(s)
        if -(2**53 - 1) <= n <= 2**53 - 1:
            return n
    return s


class DefaultDraftPolicy:
    name = "draft"

    def evaluate(self, ctx: PolicyContext) -> Decision:
        entity = ctx.entity
        if entity is None or not isinstance(entity, DraftableEntity):
            return Allow(policy=self.name)
        if entity.is_published is not True:
            return Allow(policy=self.name)
        payload = ctx.action.payload
        if isinstance(payload, Mapping) and payload.get("publish") is True:
            return Allow(policy=self.name)
        return Redirect(policy=self.name, target="draft", payload=payload if payload is not None else None)

    def merge(self, entity: DraftableEntity, draft_payload: Any) -> DraftableEntity:
        return DraftableEntity(
            id=entity.id, tenant_id=entity.tenant_id, is_published=True,
            has_pending_draft=False, draft_updated_at=None, draft_updated_by=None,
        )

    def clear(self, entity: DraftableEntity) -> DraftableEntity:
        return DraftableEntity(
            id=entity.id, tenant_id=entity.tenant_id, is_published=entity.is_published,
            has_pending_draft=False, draft_updated_at=None, draft_updated_by=None,
        )

    def sign_preview_token(self, entity_id: Id, tenant_id: Id, ttl_hours: float, secret: str) -> str:
        if not secret:
            raise ValueError("sign_preview_token: secret must be non-empty")
        exp_ms = int(time.time() * 1000) + _clamp_ttl(ttl_hours) * 3_600_000
        payload = f"{TOKEN_VERSION}.{entity_id}.{tenant_id}.{exp_ms}"
        return _b64url(f"{payload}.{_hmac(secret, payload)}")

    def verify_preview_token(self, token: str, secret: str) -> Optional[dict[str, Id]]:
        if not token or not secret:
            return None
        try:
            decoded = _from_b64url(token)
        except Exception:  # noqa: BLE001 — malformed token is a None, never a raise
            return None
        parts = decoded.split(".")
        if len(parts) != 5:
            return None
        version, entity_s, tenant_s, exp_s, mac = parts
        if version != TOKEN_VERSION:
            return None
        expected = _hmac(secret, f"{version}.{entity_s}.{tenant_s}.{exp_s}")
        if len(mac) != len(expected) or not hmac.compare_digest(mac, expected):
            return None
        try:
            exp_ms = int(exp_s)
        except ValueError:
            return None
        if exp_ms <= int(time.time() * 1000):
            return None
        return {"entity_id": _id_maybe_numeric(entity_s), "tenant_id": _id_maybe_numeric(tenant_s)}


__all__ = ["DefaultDraftPolicy"]
