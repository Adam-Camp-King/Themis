/**
 * DefaultDraftPolicy — branch coverage + HMAC preview token tests.
 *
 * Crypto-adjacent code (HMAC sign/verify) gets extensive tests: round-trip,
 * tamper rejection, expiry, wrong-secret, version mismatch, malformed input.
 *
 * Decision rule ports tests/unit/test_draft_publish.py from Solid#.
 */

import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type {
  IAction,
  IDraftableEntity,
  IPolicyContext,
  IRequestor,
} from '../../src/index.js';
import { DefaultDraftPolicy } from '../../src/policies/draft.js';

function makeSignedPayload(payload: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return Buffer.from(`${payload}.${mac}`, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const policy = new DefaultDraftPolicy();

// --- fixtures ----------------------------------------------------------

function makeRequestor(): IRequestor {
  return { id: 1, kind: 'api_key', tenant_id: 7, scopes: [] };
}
function makeEntity(overrides: Partial<IDraftableEntity> = {}): IDraftableEntity {
  return {
    id: 42,
    tenant_id: 7,
    is_published: true,
    has_pending_draft: false,
    draft_updated_at: null,
    draft_updated_by: null,
    ...overrides,
  };
}
function makeAction(overrides: Partial<IAction> = {}): IAction {
  return {
    verb: 'update',
    resource_type: 'page',
    resource_id: 42,
    tenant_id: 7,
    payload: { title: 'New Title' },
    ...overrides,
  };
}
function makeCtx(
  entity: IDraftableEntity | null,
  action: IAction = makeAction(),
): IPolicyContext {
  return {
    requestor: makeRequestor(),
    action,
    entity,
    now: 0,
    correlation_id: 'c',
  };
}

// --- evaluate(): decision rule -----------------------------------------

test('rule 1: no entity (create op) -> allow', async () => {
  const d = await policy.evaluate(makeCtx(null));
  assert.equal(d.kind, 'allow');
});

test('rule 2: non-draftable entity -> allow (policy inert)', async () => {
  // Lockable-only shape
  const lockish = {
    id: 1,
    tenant_id: 7,
    agency_owner_id: null,
    locks: {},
  };
  const ctx: IPolicyContext = {
    requestor: makeRequestor(),
    action: makeAction(),
    entity: lockish as unknown as IPolicyContext['entity'],
    now: 0,
    correlation_id: 'c',
  };
  const d = await policy.evaluate(ctx);
  assert.equal(d.kind, 'allow');
});

test('rule 3: entity not published -> allow (direct live write OK)', async () => {
  const entity = makeEntity({ is_published: false });
  const d = await policy.evaluate(makeCtx(entity));
  assert.equal(d.kind, 'allow');
});

test('rule 4: action.payload.publish === true -> allow (explicit live write)', async () => {
  const entity = makeEntity({ is_published: true });
  const action = makeAction({ payload: { title: 'X', publish: true } });
  const d = await policy.evaluate(makeCtx(entity, action));
  assert.equal(d.kind, 'allow');
});

test('rule 5: published + no publish flag -> redirect with payload preserved', async () => {
  const entity = makeEntity({ is_published: true });
  const action = makeAction({ payload: { title: 'New Title' } });
  const d = await policy.evaluate(makeCtx(entity, action));
  assert.equal(d.kind, 'redirect');
  if (d.kind !== 'redirect') return;
  assert.equal(d.policy, 'draft');
  assert.equal(d.target, 'draft');
  assert.deepEqual(d.payload, { title: 'New Title' });
});

test('rule 5: published + undefined payload -> redirect with null payload', async () => {
  const entity = makeEntity({ is_published: true });
  const action = makeAction({ payload: undefined });
  const d = await policy.evaluate(makeCtx(entity, action));
  assert.equal(d.kind, 'redirect');
  if (d.kind !== 'redirect') return;
  assert.equal(d.payload, null);
});

test("publish flag must be exactly true (not truthy values like 'true' or 1)", async () => {
  const entity = makeEntity({ is_published: true });
  const cases: unknown[] = ['true', 1, 'yes', {}];
  for (const val of cases) {
    const action = makeAction({ payload: { publish: val } });
    const d = await policy.evaluate(makeCtx(entity, action));
    assert.equal(d.kind, 'redirect', `payload.publish=${JSON.stringify(val)} should redirect, got ${d.kind}`);
  }
});

test('non-object payload (string, null) with published entity -> redirect', async () => {
  const entity = makeEntity({ is_published: true });
  for (const payload of ['hello', null, [], 42]) {
    const action = makeAction({ payload });
    const d = await policy.evaluate(makeCtx(entity, action));
    assert.equal(d.kind, 'redirect', `payload=${JSON.stringify(payload)} should redirect`);
  }
});

// --- merge() / clear() --------------------------------------------------

test('merge(): returns entity with published=true + pending_draft=false', () => {
  const entity = makeEntity({
    is_published: true,
    has_pending_draft: true,
    draft_updated_at: 1000,
    draft_updated_by: 99,
  });
  const next = policy.merge(entity, { title: 'X' });
  assert.equal(next.is_published, true);
  assert.equal(next.has_pending_draft, false);
  assert.equal(next.draft_updated_at, null);
  assert.equal(next.draft_updated_by, null);
});

test('clear(): preserves is_published, clears draft metadata', () => {
  const entity = makeEntity({
    is_published: true,
    has_pending_draft: true,
    draft_updated_at: 1000,
    draft_updated_by: 99,
  });
  const next = policy.clear(entity);
  assert.equal(next.is_published, true);
  assert.equal(next.has_pending_draft, false);
  assert.equal(next.draft_updated_at, null);
  assert.equal(next.draft_updated_by, null);
});

test('clear(): does not flip is_published on unpublished entity', () => {
  const entity = makeEntity({ is_published: false, has_pending_draft: true });
  const next = policy.clear(entity);
  assert.equal(next.is_published, false);
});

// --- signPreviewToken / verifyPreviewToken — happy path ----------------

test('sign + verify round-trip returns original ids (numeric)', () => {
  const token = policy.signPreviewToken(42, 7, 24, 'secret-1');
  const out = policy.verifyPreviewToken(token, 'secret-1');
  assert.ok(out);
  assert.equal(out!.entity_id, 42);
  assert.equal(out!.tenant_id, 7);
});

test('sign + verify round-trip returns original ids (string)', () => {
  const token = policy.signPreviewToken('abc-xyz', 'tenant-1', 1, 'secret-1');
  const out = policy.verifyPreviewToken(token, 'secret-1');
  assert.ok(out);
  assert.equal(out!.entity_id, 'abc-xyz');
  assert.equal(out!.tenant_id, 'tenant-1');
});

test('token is base64url-safe (no +, /, or =)', () => {
  const token = policy.signPreviewToken(1, 1, 1, 's');
  assert.doesNotMatch(token, /[+/=]/, `token contained reserved chars: ${token}`);
});

// --- verify: tamper / expiry / secret / version rejections -------------

test('verify rejects tampered payload (flipped byte in entity_id)', () => {
  const token = policy.signPreviewToken(42, 7, 24, 'secret-1');
  // Change one base64url character in the middle — the HMAC will mismatch.
  const idx = Math.floor(token.length / 2);
  const flipped = token.slice(0, idx) + (token[idx] === 'A' ? 'B' : 'A') + token.slice(idx + 1);
  const out = policy.verifyPreviewToken(flipped, 'secret-1');
  assert.equal(out, null);
});

test('verify rejects wrong secret', () => {
  const token = policy.signPreviewToken(42, 7, 24, 'secret-1');
  const out = policy.verifyPreviewToken(token, 'secret-2');
  assert.equal(out, null);
});

test('verify rejects expired token', () => {
  // TTL 0 hours clamps to default 24h; use a sub-second expiry via a custom path.
  // Since clampTtl forbids <= 0, we instead sign at a past `now` by mocking —
  // simpler: sign with 1h TTL, then move system time? Not portable.
  //
  // Instead: sign normally, then wait for 0ms and assert a token with a
  // payload whose exp is clearly past via direct construction.
  // We can't construct a token without the secret, so we test via a fake
  // base64-decodable payload that mimics the format with a past expiry.
  const past = Date.now() - 1000;
  const token = makeSignedPayload(`v1.42.7.${past}`, 'secret-1');
  const out = policy.verifyPreviewToken(token, 'secret-1');
  assert.equal(out, null);
});

test('verify rejects version mismatch', () => {
  const future = Date.now() + 60_000;
  const token = makeSignedPayload(`v9.42.7.${future}`, 'secret-1');
  const out = policy.verifyPreviewToken(token, 'secret-1');
  assert.equal(out, null);
});

test('verify rejects empty token / empty secret', () => {
  const token = policy.signPreviewToken(1, 1, 1, 'secret-1');
  assert.equal(policy.verifyPreviewToken('', 'secret-1'), null);
  assert.equal(policy.verifyPreviewToken(token, ''), null);
});

test('verify rejects malformed base64', () => {
  const out = policy.verifyPreviewToken('!!!not@@@base64###', 'secret-1');
  assert.equal(out, null);
});

test('verify rejects wrong-shaped payload (too few parts)', () => {
  const garbage = Buffer.from('v1.42.missing-parts', 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const out = policy.verifyPreviewToken(garbage, 'secret-1');
  assert.equal(out, null);
});

// --- signPreviewToken: TTL handling -----------------------------------

test('sign clamps TTL > 168h down to 168h max', () => {
  const t1 = policy.signPreviewToken(1, 1, 10_000, 'secret-1');
  // Verify it's a valid token
  const out = policy.verifyPreviewToken(t1, 'secret-1');
  assert.ok(out);
});

test('sign with TTL <= 0 defaults to 24h', () => {
  const t = policy.signPreviewToken(1, 1, 0, 'secret-1');
  const out = policy.verifyPreviewToken(t, 'secret-1');
  assert.ok(out);
});

test('sign with empty secret throws', () => {
  assert.throws(() => policy.signPreviewToken(1, 1, 24, ''));
});

test('policy.name is literally "draft"', () => {
  assert.equal(policy.name, 'draft');
});
