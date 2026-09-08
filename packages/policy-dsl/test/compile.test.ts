// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * themis-policy-dsl — compiler tests.
 *
 * Round-trip: YAML source → compiled engine → evaluate canonical scenarios
 * → assert decisions. Any mis-compilation silently corrupts production
 * policy, so branch coverage matters.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IAction, IPolicyContext, IRequestor } from 'themis-policy';
import { compilePolicyYaml, PolicyDslError } from '../src/index.js';

function mkRequestor(overrides: Partial<IRequestor> = {}): IRequestor {
  return { id: 1, kind: 'api_key', tenant_id: 7, scopes: [], ...overrides };
}
function mkAction(overrides: Partial<IAction> = {}): IAction {
  return { verb: 'update', resource_type: 'page', tenant_id: 7, ...overrides };
}
function mkCtx(r: IRequestor, a: IAction, entity: IPolicyContext['entity'] = null): IPolicyContext {
  return { requestor: r, action: a, entity, now: 0, correlation_id: 'corr' };
}

// --- bounded_version ---------------------------------------------------

test('rejects missing bounded_version', () => {
  assert.throws(() => compilePolicyYaml(''), PolicyDslError);
});

test('rejects wrong bounded_version', () => {
  assert.throws(() => compilePolicyYaml('bounded_version: "1"'), PolicyDslError);
});

test("accepts bounded_version: '0'", () => {
  const b = compilePolicyYaml('bounded_version: "0"');
  assert.ok(b.engine);
});

test('rejects non-mapping root', () => {
  assert.throws(() => compilePolicyYaml('- just a list'), PolicyDslError);
});

test('rejects invalid YAML', () => {
  assert.throws(() => compilePolicyYaml('{bad: [unclosed'), PolicyDslError);
});

// --- scopes ------------------------------------------------------------

test('scopes: verb+resource_type form compiles and enforces', async () => {
  const yaml = `
bounded_version: "0"
scopes:
  - verb: invoke
    resource_type: wire_transfer
    require: payments:write
`;
  const b = compilePolicyYaml(yaml);
  const r = mkRequestor({ scopes: ['payments:write'] });
  const a = mkAction({ verb: 'invoke', resource_type: 'wire_transfer' });
  assert.equal((await b.engine.evaluate(mkCtx(r, a))).kind, 'allow');

  const r2 = mkRequestor({ scopes: [] });
  const d = await b.engine.evaluate(mkCtx(r2, a));
  assert.equal(d.kind, 'deny');
});

test('scopes: path+method form compiles', async () => {
  const yaml = `
bounded_version: "0"
scopes:
  - method: POST
    path: /api/v1/cms/pages
    require: pages:write
`;
  const b = compilePolicyYaml(yaml);
  const r = mkRequestor({ scopes: ['pages:write'] });
  const a = mkAction({
    verb: 'create',
    resource_type: 'page',
    metadata: { method: 'POST', path: '/api/v1/cms/pages' },
  });
  assert.equal((await b.engine.evaluate(mkCtx(r, a))).kind, 'allow');
});

test('scopes: invalid shape (neither method+path nor verb+resource_type) rejected', () => {
  assert.throws(
    () => compilePolicyYaml('bounded_version: "0"\nscopes:\n  - require: x'),
    PolicyDslError,
  );
});

test('scopes: empty require rejected', () => {
  assert.throws(
    () =>
      compilePolicyYaml(
        'bounded_version: "0"\nscopes:\n  - verb: x\n    resource_type: y\n    require: ""',
      ),
    PolicyDslError,
  );
});

test('scopes: declared_scopes deduped', () => {
  const yaml = `
bounded_version: "0"
scopes:
  - verb: a
    resource_type: b
    require: x:read
  - verb: c
    resource_type: d
    require: x:read
  - verb: e
    resource_type: f
    require: x:write
`;
  const b = compilePolicyYaml(yaml);
  assert.deepEqual([...b.declared_scopes].sort(), ['x:read', 'x:write']);
});

// --- locks -------------------------------------------------------------

test('locks: declare_areas + defaults surface in bundle', () => {
  const yaml = `
bounded_version: "0"
locks:
  declare_areas: [pages, brand]
  defaults:
    - area: pages
      locked_by_default: true
    - area: brand
      locked_by_default: false
`;
  const b = compilePolicyYaml(yaml);
  assert.deepEqual([...b.declared_areas].sort(), ['brand', 'pages']);
  assert.deepEqual(b.lock_defaults, { pages: true, brand: false });
});

test('locks: area not in declare_areas rejected', () => {
  const yaml = `
bounded_version: "0"
locks:
  declare_areas: [pages]
  defaults:
    - area: unknown_area
      locked_by_default: true
`;
  assert.throws(() => compilePolicyYaml(yaml), PolicyDslError);
});

test('locks: default lock policy IS registered (pure T10 path still available)', async () => {
  const b = compilePolicyYaml('bounded_version: "0"');
  const r = mkRequestor({ id: 100 });
  const entity = {
    id: 1,
    tenant_id: 7,
    agency_owner_id: 999,
    locks: { pages: true },
  };
  const a = mkAction({ area: 'pages' });
  const d = await b.engine.evaluate(mkCtx(r, a, entity));
  assert.equal(d.kind, 'deny');
});

// --- drafts ------------------------------------------------------------

test('drafts: default policy is registered; redirects on published entity', async () => {
  const b = compilePolicyYaml('bounded_version: "0"');
  const entity = {
    id: 1,
    tenant_id: 7,
    is_published: true,
    has_pending_draft: false,
    draft_updated_at: null,
    draft_updated_by: null,
  };
  const d = await b.engine.evaluate(
    mkCtx(mkRequestor({ kind: 'user' }), mkAction({ payload: { title: 'x' } }), entity),
  );
  assert.equal(d.kind, 'redirect');
});

test('drafts: force_review forces redirect even on unpublished entity', async () => {
  const yaml = `
bounded_version: "0"
drafts:
  - verb: update
    resource_type: page
    force_review: true
`;
  const b = compilePolicyYaml(yaml);
  const entity = {
    id: 1,
    tenant_id: 7,
    is_published: false, // NOT published
    has_pending_draft: false,
    draft_updated_at: null,
    draft_updated_by: null,
  };
  const d = await b.engine.evaluate(
    mkCtx(mkRequestor({ kind: 'user' }), mkAction(), entity),
  );
  assert.equal(d.kind, 'redirect');
});

test('drafts: force_review does NOT affect unrelated verb/resource combos', async () => {
  const yaml = `
bounded_version: "0"
drafts:
  - verb: update
    resource_type: page
    force_review: true
`;
  const b = compilePolicyYaml(yaml);
  const entity = {
    id: 1,
    tenant_id: 7,
    is_published: false,
    has_pending_draft: false,
    draft_updated_at: null,
    draft_updated_by: null,
  };
  // Different verb — NOT forced
  const d = await b.engine.evaluate(
    mkCtx(mkRequestor({ kind: 'user' }), mkAction({ verb: 'read' }), entity),
  );
  assert.equal(d.kind, 'allow');
});

// --- approvals --------------------------------------------------------

test('approvals: unconditional require_approval on verb+resource match', async () => {
  const yaml = `
bounded_version: "0"
approvals:
  - verb: invoke
    resource_type: wire
`;
  const b = compilePolicyYaml(yaml);
  const d = await b.engine.evaluate(
    mkCtx(
      mkRequestor({ kind: 'user' }),
      mkAction({ verb: 'invoke', resource_type: 'wire' }),
    ),
  );
  assert.equal(d.kind, 'require_approval');
});

test('approvals: min_amount threshold gates', async () => {
  const yaml = `
bounded_version: "0"
approvals:
  - verb: invoke
    resource_type: wire
    min_amount: 10000
    amount_field: amount
    message: "Over 10k needs approval"
`;
  const b = compilePolicyYaml(yaml);
  // Below threshold -> allow
  const below = await b.engine.evaluate(
    mkCtx(
      mkRequestor({ kind: 'user' }),
      mkAction({ verb: 'invoke', resource_type: 'wire', payload: { amount: 500 } }),
    ),
  );
  assert.equal(below.kind, 'allow');
  // Above threshold -> require_approval
  const over = await b.engine.evaluate(
    mkCtx(
      mkRequestor({ kind: 'user' }),
      mkAction({ verb: 'invoke', resource_type: 'wire', payload: { amount: 50000 } }),
    ),
  );
  assert.equal(over.kind, 'require_approval');
});

test('approvals: does not gate unrelated actions', async () => {
  const yaml = `
bounded_version: "0"
approvals:
  - verb: invoke
    resource_type: wire
`;
  const b = compilePolicyYaml(yaml);
  const d = await b.engine.evaluate(
    mkCtx(mkRequestor({ kind: 'user' }), mkAction({ verb: 'read', resource_type: 'wire' })),
  );
  assert.equal(d.kind, 'allow');
});

test('approvals: min_amount without amount_field rejected', () => {
  const yaml = `
bounded_version: "0"
approvals:
  - verb: invoke
    resource_type: wire
    min_amount: 10000
`;
  assert.throws(() => compilePolicyYaml(yaml), PolicyDslError);
});

test('approvals: duplicate verb+resource merged with MIN threshold (deny-safer)', async () => {
  const yaml = `
bounded_version: "0"
approvals:
  - verb: invoke
    resource_type: wire
    min_amount: 50000
    amount_field: amount
  - verb: invoke
    resource_type: wire
    min_amount: 10000
    amount_field: amount
`;
  const b = compilePolicyYaml(yaml);
  // $20k exceeds 10k (merged min) -> require_approval
  const d = await b.engine.evaluate(
    mkCtx(
      mkRequestor({ kind: 'user' }),
      mkAction({ verb: 'invoke', resource_type: 'wire', payload: { amount: 20000 } }),
    ),
  );
  assert.equal(d.kind, 'require_approval');
});

// --- end-to-end worked example -----------------------------------------

test('worked example from spec: all four blocks compose correctly', async () => {
  const yaml = `
bounded_version: "0"
scopes:
  - verb: invoke
    resource_type: wire_transfer
    require: payments:write
approvals:
  - verb: invoke
    resource_type: wire_transfer
    min_amount: 10000
    amount_field: amount
    message: "Wire over $10k requires CFO approval."
`;
  const b = compilePolicyYaml(yaml);

  // Unscoped -> deny by scope
  const d1 = await b.engine.evaluate(
    mkCtx(
      mkRequestor({ scopes: [] }),
      mkAction({ verb: 'invoke', resource_type: 'wire_transfer', payload: { amount: 500 } }),
    ),
  );
  assert.equal(d1.kind, 'deny');

  // Scoped, small -> allow
  const d2 = await b.engine.evaluate(
    mkCtx(
      mkRequestor({ scopes: ['payments:write'] }),
      mkAction({ verb: 'invoke', resource_type: 'wire_transfer', payload: { amount: 500 } }),
    ),
  );
  assert.equal(d2.kind, 'allow');

  // Scoped, large -> require_approval
  const d3 = await b.engine.evaluate(
    mkCtx(
      mkRequestor({ scopes: ['payments:write'] }),
      mkAction({ verb: 'invoke', resource_type: 'wire_transfer', payload: { amount: 500000 } }),
    ),
  );
  assert.equal(d3.kind, 'require_approval');
});
