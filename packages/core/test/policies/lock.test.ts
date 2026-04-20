// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * DefaultLockPolicy — branch coverage tests.
 *
 * Every rule (1..8) in the decision table is exercised with at least one
 * table-driven case. Additional cases cover mutual exclusivity of bypass
 * rules and behavior of describe()/apply().
 *
 * Ported directly from Solid# `tests/unit/test_agency_lock.py` (19 cases).
 * This is the test corpus the sprint audit flagged as "the single biggest
 * gift to extraction" — it specifies behavior more reliably than any spec.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type {
  IAction,
  ILockableEntity,
  IPolicyContext,
  IRequestor,
} from '../../src/index.js';
import { DefaultLockPolicy } from '../../src/policies/lock.js';

const policy = new DefaultLockPolicy();

// --- shared fixtures ----------------------------------------------------

function makeRequestor(overrides: Partial<IRequestor> = {}): IRequestor {
  return {
    id: 100,
    kind: 'user',
    tenant_id: 7,
    scopes: [],
    ...overrides,
  };
}

function makeEntity(overrides: Partial<ILockableEntity> = {}): ILockableEntity {
  return {
    id: 42,
    tenant_id: 7,
    agency_owner_id: 999,
    locks: { pages: true, brand: false },
    ...overrides,
  };
}

function makeAction(overrides: Partial<IAction> = {}): IAction {
  return {
    verb: 'update',
    resource_type: 'page',
    resource_id: 42,
    tenant_id: 7,
    area: 'pages',
    ...overrides,
  };
}

function makeCtx(
  requestor: IRequestor,
  entity: ILockableEntity | null,
  action: IAction,
): IPolicyContext {
  return {
    requestor,
    action,
    entity,
    now: 1_700_000_000_000,
    correlation_id: 'test-corr',
  };
}

// --- evaluate(): rule-by-rule coverage ----------------------------------

test('rule 1: no entity (create op) -> allow', async () => {
  const d = await policy.evaluate(makeCtx(makeRequestor(), null, makeAction()));
  assert.equal(d.kind, 'allow');
});

test('rule 2: self-serve entity (agency_owner_id === null) -> allow', async () => {
  const entity = makeEntity({ agency_owner_id: null, locks: { pages: true } });
  const d = await policy.evaluate(makeCtx(makeRequestor(), entity, makeAction()));
  assert.equal(d.kind, 'allow');
});

test('rule 3: super admin bypasses even with area locked', async () => {
  const requestor = makeRequestor({ id: 100, is_super_admin: true });
  const entity = makeEntity({ locks: { pages: true } });
  const d = await policy.evaluate(makeCtx(requestor, entity, makeAction()));
  assert.equal(d.kind, 'allow');
});

test("rule 4: role === 'agency' bypasses even with area locked", async () => {
  const requestor = makeRequestor({ id: 100, role: 'agency' });
  const entity = makeEntity({ locks: { pages: true } });
  const d = await policy.evaluate(makeCtx(requestor, entity, makeAction()));
  assert.equal(d.kind, 'allow');
});

test('rule 5: exact agency_owner_id match bypasses', async () => {
  const requestor = makeRequestor({ id: 999 });
  const entity = makeEntity({ agency_owner_id: 999, locks: { pages: true } });
  const d = await policy.evaluate(makeCtx(requestor, entity, makeAction()));
  assert.equal(d.kind, 'allow');
});

test('rule 6: no area on action -> allow (nothing to check)', async () => {
  const action = makeAction({ area: undefined });
  const entity = makeEntity({ locks: { pages: true } });
  const d = await policy.evaluate(makeCtx(makeRequestor(), entity, action));
  assert.equal(d.kind, 'allow');
});

test('rule 7: area present but not locked -> allow', async () => {
  const entity = makeEntity({ locks: { pages: false, brand: true } });
  const d = await policy.evaluate(makeCtx(makeRequestor(), entity, makeAction()));
  assert.equal(d.kind, 'allow');
});

test('rule 7: area completely absent from lock map -> allow (defaults to false)', async () => {
  const entity = makeEntity({ locks: {} });
  const d = await policy.evaluate(makeCtx(makeRequestor(), entity, makeAction()));
  assert.equal(d.kind, 'allow');
});

test('rule 8: default case -> deny with structured detail', async () => {
  const requestor = makeRequestor({ id: 100 });
  const entity = makeEntity({ agency_owner_id: 999, locks: { pages: true } });
  const d = await policy.evaluate(makeCtx(requestor, entity, makeAction()));
  assert.equal(d.kind, 'deny');
  if (d.kind !== 'deny') return;
  assert.equal(d.policy, 'lock');
  assert.equal(d.reason, 'agency_lock');
  assert.equal((d.detail as Record<string, unknown>).area, 'pages');
  assert.equal((d.detail as Record<string, unknown>).entity_id, 42);
  assert.equal((d.detail as Record<string, unknown>).agency_owner_id, 999);
});

// --- evaluate(): mutual exclusivity / edge cases ------------------------

test('bypass rules 3–5 each short-circuit independently (table)', async () => {
  const entity = makeEntity({ agency_owner_id: 999, locks: { pages: true } });
  const cases: { label: string; requestor: IRequestor }[] = [
    { label: 'super_admin', requestor: makeRequestor({ id: 100, is_super_admin: true }) },
    { label: 'role=agency', requestor: makeRequestor({ id: 100, role: 'agency' }) },
    { label: 'owner_match', requestor: makeRequestor({ id: 999 }) },
  ];
  for (const { label, requestor } of cases) {
    const d = await policy.evaluate(makeCtx(requestor, entity, makeAction()));
    assert.equal(d.kind, 'allow', `bypass '${label}' did not allow`);
  }
});

test('every declared area is independently enforceable', async () => {
  const areas = ['pages', 'brand', 'domains', 'modules', 'design', 'billing_lock'];
  const requestor = makeRequestor({ id: 100 });
  for (const area of areas) {
    const entity = makeEntity({ locks: { [area]: true } });
    const action = makeAction({ area });
    const d = await policy.evaluate(makeCtx(requestor, entity, action));
    assert.equal(d.kind, 'deny', `area=${area} did not deny`);
  }
});

test('locked area X does not affect requests for unlocked area Y', async () => {
  const requestor = makeRequestor({ id: 100 });
  const entity = makeEntity({ locks: { pages: true, brand: false } });
  const action = makeAction({ area: 'brand' });
  const d = await policy.evaluate(makeCtx(requestor, entity, action));
  assert.equal(d.kind, 'allow');
});

test('non-lockable entity (draft-only shape) -> allow (policy inert)', async () => {
  const requestor = makeRequestor();
  // Simulating an IDraftableEntity without the lockable fields.
  const draftish = {
    id: 42,
    tenant_id: 7,
    is_published: true,
    has_pending_draft: false,
    draft_updated_at: null,
    draft_updated_by: null,
  };
  const ctx: IPolicyContext = {
    requestor,
    action: makeAction(),
    entity: draftish as unknown as IPolicyContext['entity'],
    now: 0,
    correlation_id: 'x',
  };
  const d = await policy.evaluate(ctx);
  assert.equal(d.kind, 'allow');
});

// --- describe() --------------------------------------------------------

test('describe(): fills every requested area with boolean', () => {
  const entity = makeEntity({ locks: { pages: true, brand: false } });
  const out = policy.describe(entity, ['pages', 'brand', 'domains']);
  assert.deepEqual(out, { pages: true, brand: false, domains: false });
});

test('describe(): empty areas list -> empty map', () => {
  const entity = makeEntity();
  assert.deepEqual(policy.describe(entity, []), {});
});

test('describe(): non-boolean lock value normalizes to false', () => {
  // Defensive — real data shouldn't have this, but be explicit.
  const entity: ILockableEntity = {
    id: 1,
    tenant_id: 7,
    agency_owner_id: 999,
    locks: { pages: 1 } as unknown as Record<string, boolean>,
  };
  const out = policy.describe(entity, ['pages']);
  assert.equal(out.pages, false);
});

// --- apply() -----------------------------------------------------------

test('apply(): sets multiple areas and preserves untouched keys', () => {
  const entity = makeEntity({ locks: { pages: false, brand: false, domains: true } });
  const next = policy.apply(entity, ['pages', 'brand'], true);
  assert.deepEqual(next.locks, { pages: true, brand: true, domains: true });
});

test('apply(): unlocking clears only named areas', () => {
  const entity = makeEntity({ locks: { pages: true, brand: true, domains: true } });
  const next = policy.apply(entity, ['pages'], false);
  assert.deepEqual(next.locks, { pages: false, brand: true, domains: true });
});

test('apply(): does not mutate input (purity)', () => {
  const entity = makeEntity({ locks: { pages: false } });
  const before = JSON.stringify(entity);
  policy.apply(entity, ['pages'], true);
  assert.equal(JSON.stringify(entity), before, 'apply() mutated its input');
});

test('apply(): preserves id / tenant_id / agency_owner_id', () => {
  const entity = makeEntity({ id: 42, tenant_id: 7, agency_owner_id: 999 });
  const next = policy.apply(entity, ['pages'], true);
  assert.equal(next.id, 42);
  assert.equal(next.tenant_id, 7);
  assert.equal(next.agency_owner_id, 999);
});

test('policy.name is literally "lock"', () => {
  assert.equal(policy.name, 'lock');
});
