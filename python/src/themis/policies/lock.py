# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""DefaultLockPolicy — the T10 primitive (RFC v0 § 5.1).

Decision rule, first match wins:
  1. entity is None (create)                         → allow
  2. entity.agency_owner_id is None (self-serve)     → allow
  3. requestor.is_super_admin                        → allow
  4. requestor.role == 'agency'                      → allow
  5. requestor.id == entity.agency_owner_id          → allow
  6. action.area not set                             → allow
  7. entity.locks[area] is not True                  → allow
  8. otherwise                                       → deny
Bypass rules 3–5 MUST NOT be removed by implementations.
"""
from __future__ import annotations

from typing import Mapping, Sequence

from ..types import Allow, Decision, Deny, LockableEntity, PolicyContext


class DefaultLockPolicy:
    name = "lock"

    def evaluate(self, ctx: PolicyContext) -> Decision:
        entity = ctx.entity
        if entity is None or not isinstance(entity, LockableEntity):
            return Allow(policy=self.name)
        if entity.agency_owner_id is None:
            return Allow(policy=self.name)
        if ctx.requestor.is_super_admin is True:
            return Allow(policy=self.name)
        if ctx.requestor.role == "agency":
            return Allow(policy=self.name)
        if ctx.requestor.id == entity.agency_owner_id:
            return Allow(policy=self.name)
        area = ctx.action.area
        if not area:
            return Allow(policy=self.name)
        if entity.locks.get(area) is not True:
            return Allow(policy=self.name)
        return Deny(
            policy=self.name,
            reason="agency_lock",
            message=f"Area '{area}' is locked by the agency for this resource.",
            detail={"area": area, "entity_id": entity.id, "agency_owner_id": entity.agency_owner_id},
        )

    def describe(self, entity: LockableEntity, areas: Sequence[str]) -> dict[str, bool]:
        return {a: entity.locks.get(a) is True for a in areas}

    def apply(self, entity: LockableEntity, areas: Sequence[str], locked: bool) -> LockableEntity:
        nxt: dict[str, bool] = dict(entity.locks)
        for a in areas:
            nxt[a] = locked
        return LockableEntity(id=entity.id, tenant_id=entity.tenant_id, agency_owner_id=entity.agency_owner_id, locks=nxt)


__all__ = ["DefaultLockPolicy"]
