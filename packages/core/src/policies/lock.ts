// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * DefaultLockPolicy — the T10 primitive.
 *
 * Decides whether a requestor may mutate a given area on an entity.
 *
 * Ported from Solid# `solid-backend/middleware/agency_lock.py:75-130`.
 * Conforms to Themis RFC v0 § 5.1.
 *
 * Decision rule (evaluated top-to-bottom; first match wins):
 *
 *   1. entity is null (create operations)                    -> allow
 *   2. entity.agency_owner_id is null (self-serve)           -> allow
 *   3. requestor.is_super_admin                              -> allow
 *   4. requestor.role === 'agency'                           -> allow
 *   5. requestor.id === entity.agency_owner_id (owner match) -> allow
 *   6. action.area is not set                                -> allow
 *   7. entity.locks[action.area] !== true                    -> allow
 *   8. otherwise                                             -> deny
 *
 * Bypass rules 3–5 MUST NOT be removed by implementations. Additional rules
 * MAY be added (e.g., time-windowed temporary unlocks).
 */

import type {
  ILockableEntity,
  ILockPolicy,
  IPolicyContext,
  IPolicyDecision,
} from '../types.js';

export class DefaultLockPolicy implements ILockPolicy {
  readonly name = 'lock' as const;

  async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
    // 1. No entity (e.g., create op) -> no lock state to check
    if (!ctx.entity) {
      return { kind: 'allow', policy: this.name };
    }

    // Lock policy only applies to entities shaped like ILockableEntity.
    // If the context carries a different entity (e.g., a pure IDraftableEntity),
    // there is nothing to evaluate — allow.
    if (!isLockableEntity(ctx.entity)) {
      return { kind: 'allow', policy: this.name };
    }

    const entity = ctx.entity;

    // 2. Self-serve: no agency owner => locks do not apply
    if (entity.agency_owner_id === null) {
      return { kind: 'allow', policy: this.name };
    }

    // 3. Super admin bypass
    if (ctx.requestor.is_super_admin === true) {
      return { kind: 'allow', policy: this.name };
    }

    // 4. Agency role bypass
    if (ctx.requestor.role === 'agency') {
      return { kind: 'allow', policy: this.name };
    }

    // 5. Exact agency-owner match bypass
    if (ctx.requestor.id === entity.agency_owner_id) {
      return { kind: 'allow', policy: this.name };
    }

    // 6. No area declared on the action -> nothing to check
    const area = ctx.action.area;
    if (!area) {
      return { kind: 'allow', policy: this.name };
    }

    // 7. Area not locked -> allow
    if (entity.locks[area] !== true) {
      return { kind: 'allow', policy: this.name };
    }

    // 8. Deny
    return {
      kind: 'deny',
      policy: this.name,
      reason: 'agency_lock',
      message: `Area '${area}' is locked by the agency for this resource.`,
      detail: {
        area,
        entity_id: entity.id,
        agency_owner_id: entity.agency_owner_id,
      },
    };
  }

  /**
   * Normalize a lock map so every known area appears as a boolean. Ports
   * `describe_lock` from `middleware/agency_lock.py:208-219`. Pure.
   */
  describe(
    entity: ILockableEntity,
    areas: readonly string[],
  ): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const area of areas) {
      out[area] = entity.locks[area] === true;
    }
    return out;
  }

  /**
   * Return a new entity with `areas` set to `locked`. Other lock keys are
   * preserved. Pure — does not persist.
   */
  apply(
    entity: ILockableEntity,
    areas: readonly string[],
    locked: boolean,
  ): ILockableEntity {
    const next: Record<string, boolean> = { ...entity.locks };
    for (const area of areas) {
      next[area] = locked;
    }
    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      agency_owner_id: entity.agency_owner_id,
      locks: next,
    };
  }
}

/**
 * Runtime check: does `entity` carry the fields a lock evaluation requires?
 * IPolicyContext.entity is a union of lockable and draftable shapes; this
 * narrows it safely.
 */
function isLockableEntity(entity: object): entity is ILockableEntity {
  return (
    'agency_owner_id' in entity &&
    'locks' in entity &&
    typeof (entity as ILockableEntity).locks === 'object' &&
    (entity as ILockableEntity).locks !== null
  );
}
