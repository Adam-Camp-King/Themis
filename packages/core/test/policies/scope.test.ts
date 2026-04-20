// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * DefaultScopePolicy — branch coverage tests.
 *
 * Ported from Solid# `tests/unit/test_cli_api_key.py` (has_scope) and the
 * scope-rule enforcement tests in `tests/unit/test_auth.py`.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IAction, IPolicyContext, IRequestor } from '../../src/index.js';
import { DefaultScopePolicy } from '../../src/policies/scope.js';

function makeRequestor(overrides: Partial<IRequestor> = {}): IRequestor {
  return {
    id: 1,
    kind: 'api_key',
    tenant_id: 7,
    scopes: ['pages:write'],
    ...overrides,
  };
}

function makeAction(overrides: Partial<IAction> = {}): IAction {
  return {
    verb: 'update',
    resource_type: 'page',
    tenant_id: 7,
    required_scope: 'pages:write',
    ...overrides,
  };
}

function makeCtx(
  requestor: IRequestor = makeRequestor(),
  action: IAction = makeAction(),
): IPolicyContext {
  return {
    requestor,
    action,
    entity: null,
    now: 0,
    correlation_id: 'c',
  };
}

// --- rule coverage ------------------------------------------------------

test('rule 1: super_admin bypasses even without the scope', async () => {
  const p = new DefaultScopePolicy();
  const ctx = makeCtx(makeRequestor({ scopes: [], is_super_admin: true }));
  assert.equal((await p.evaluate(ctx)).kind, 'allow');
});

test("rule 2: scopes includes '*' bypasses", async () => {
  const p = new DefaultScopePolicy();
  const ctx = makeCtx(makeRequestor({ scopes: ['*'] }));
  assert.equal((await p.evaluate(ctx)).kind, 'allow');
});

test("rule 3: session user (kind='user', scopes=[]) bypasses", async () => {
  const p = new DefaultScopePolicy();
  const ctx = makeCtx(makeRequestor({ kind: 'user', scopes: [] }));
  assert.equal((await p.evaluate(ctx)).kind, 'allow');
});

test("rule 3 does NOT apply to api_key with empty scopes", async () => {
  const p = new DefaultScopePolicy();
  const ctx = makeCtx(makeRequestor({ kind: 'api_key', scopes: [] }));
  const d = await p.evaluate(ctx);
  assert.equal(d.kind, 'deny');
});

test("rule 4: no required_scope on action, no rule matches -> allow", async () => {
  const p = new DefaultScopePolicy();
  const ctx = makeCtx(
    makeRequestor({ scopes: [] }),
    makeAction({ required_scope: undefined }),
  );
  assert.equal((await p.evaluate(ctx)).kind, 'allow');
});

test('rule 5: required scope held -> allow', async () => {
  const p = new DefaultScopePolicy();
  const ctx = makeCtx(makeRequestor({ scopes: ['pages:write', 'kb:read'] }));
  assert.equal((await p.evaluate(ctx)).kind, 'allow');
});

test('rule 6: required scope not held -> deny with structured detail', async () => {
  const p = new DefaultScopePolicy();
  const ctx = makeCtx(makeRequestor({ scopes: ['pages:read'] }));
  const d = await p.evaluate(ctx);
  assert.equal(d.kind, 'deny');
  if (d.kind !== 'deny') return;
  assert.equal(d.policy, 'scope');
  assert.equal(d.reason, 'missing_scope');
  assert.equal((d.detail as Record<string, unknown>).required, 'pages:write');
});

// --- flat membership (no hierarchy) -------------------------------------

test('flat membership: pages:write does NOT imply pages:read', async () => {
  const p = new DefaultScopePolicy();
  const ctx = makeCtx(
    makeRequestor({ scopes: ['pages:write'] }),
    makeAction({ required_scope: 'pages:read' }),
  );
  assert.equal((await p.evaluate(ctx)).kind, 'deny');
});

test('flat membership: pages:* does not match pages:write in core', async () => {
  const p = new DefaultScopePolicy();
  const ctx = makeCtx(
    makeRequestor({ scopes: ['pages:*'] }),
    makeAction({ required_scope: 'pages:write' }),
  );
  assert.equal((await p.evaluate(ctx)).kind, 'deny');
});

// --- rule matchers ------------------------------------------------------

test('addRule (path + method) resolves required_scope when action omits it', async () => {
  const p = new DefaultScopePolicy();
  p.addRule({ method: 'POST', path_pattern: '/api/v1/cms/pages' }, 'pages:write');
  const ctx = makeCtx(
    makeRequestor({ scopes: ['pages:write'] }),
    makeAction({
      required_scope: undefined,
      metadata: { method: 'POST', path: '/api/v1/cms/pages' },
    }),
  );
  assert.equal((await p.evaluate(ctx)).kind, 'allow');
});

test('addRule (path + method) method is case-insensitive', async () => {
  const p = new DefaultScopePolicy();
  p.addRule({ method: 'post', path_pattern: '/pages' }, 'pages:write');
  const ctx = makeCtx(
    makeRequestor({ scopes: ['pages:write'] }),
    makeAction({
      required_scope: undefined,
      metadata: { method: 'POST', path: '/pages' },
    }),
  );
  assert.equal((await p.evaluate(ctx)).kind, 'allow');
});

test('addRule (regex pattern) matches path', async () => {
  const p = new DefaultScopePolicy();
  p.addRule(
    { method: 'DELETE', path_pattern: /^\/api\/v1\/cms\/pages\/\d+$/ },
    'pages:write',
  );
  const ctx = makeCtx(
    makeRequestor({ scopes: ['pages:write'] }),
    makeAction({
      required_scope: undefined,
      metadata: { method: 'DELETE', path: '/api/v1/cms/pages/42' },
    }),
  );
  assert.equal((await p.evaluate(ctx)).kind, 'allow');
});

test('addRule (predicate) matches when function returns true', async () => {
  const p = new DefaultScopePolicy();
  p.addRule((ctx) => ctx.action.verb === 'delete', 'admin:delete');
  const ctx = makeCtx(
    makeRequestor({ scopes: ['admin:delete'] }),
    makeAction({ verb: 'delete', required_scope: undefined }),
  );
  assert.equal((await p.evaluate(ctx)).kind, 'allow');
});

test('addRule (predicate) no match -> allow (no scope required)', async () => {
  const p = new DefaultScopePolicy();
  p.addRule((ctx) => ctx.action.verb === 'delete', 'admin:delete');
  const ctx = makeCtx(
    makeRequestor({ scopes: [] }),
    makeAction({ verb: 'update', required_scope: undefined }),
  );
  assert.equal((await p.evaluate(ctx)).kind, 'allow');
});

test('action.required_scope takes precedence over rule resolution', async () => {
  const p = new DefaultScopePolicy();
  p.addRule((_ctx) => true, 'rule:scope');
  // action.required_scope wins even though the rule would've said 'rule:scope'
  const ctx = makeCtx(
    makeRequestor({ scopes: ['explicit:scope'] }),
    makeAction({ required_scope: 'explicit:scope' }),
  );
  assert.equal((await p.evaluate(ctx)).kind, 'allow');
});

test('listScopes returns every distinct required_scope registered', () => {
  const p = new DefaultScopePolicy();
  p.addRule({ method: 'GET', path_pattern: '/a' }, 'a:read');
  p.addRule({ method: 'POST', path_pattern: '/a' }, 'a:write');
  p.addRule({ method: 'GET', path_pattern: '/b' }, 'a:read'); // duplicate
  const out = p.listScopes();
  assert.deepEqual(out.slice().sort(), ['a:read', 'a:write']);
});

test('policy.name is literally "scope"', () => {
  assert.equal(new DefaultScopePolicy().name, 'scope');
});
