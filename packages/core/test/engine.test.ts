/**
 * PolicyEngine — orchestration tests.
 *
 * The engine is the kernel. A wrong decision here (wrong short-circuit,
 * missing audit, tenancy slip) would break EVERY Bounded deployment.
 * Covers all evaluation rules from RFC v0 § 6.2.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type {
  IAction,
  IAuditEvent,
  IAuditSink,
  IPolicy,
  IPolicyContext,
  IPolicyDecision,
  IRequestor,
} from '../src/index.js';
import { PolicyEngine } from '../src/index.js';

// --- test doubles ------------------------------------------------------

class FakeSink implements IAuditSink {
  events: IAuditEvent[] = [];
  emit(event: IAuditEvent): void {
    this.events.push(event);
  }
}

class ThrowingSink implements IAuditSink {
  emit(_event: IAuditEvent): void {
    throw new Error('sink exploded');
  }
}

function mkPolicy(
  name: string,
  decisionFor: (ctx: IPolicyContext) => IPolicyDecision,
): IPolicy {
  return {
    name,
    evaluate: async (ctx) => decisionFor(ctx),
  };
}

const allowP = (name: string): IPolicy =>
  mkPolicy(name, () => ({ kind: 'allow', policy: name }));
const denyP = (name: string, reason = 'denied'): IPolicy =>
  mkPolicy(name, () => ({ kind: 'deny', policy: name, reason }));
const redirectP = (name: string): IPolicy =>
  mkPolicy(name, () => ({
    kind: 'redirect',
    policy: name,
    target: 'draft',
    payload: { name },
  }));
const approvalP = (name: string): IPolicy =>
  mkPolicy(name, () => ({
    kind: 'require_approval',
    policy: name,
    approval_ref: 'ref-' + name,
  }));

function mkRequestor(overrides: Partial<IRequestor> = {}): IRequestor {
  return {
    id: 1,
    kind: 'api_key',
    tenant_id: 7,
    scopes: [],
    ...overrides,
  };
}
function mkAction(overrides: Partial<IAction> = {}): IAction {
  return {
    verb: 'update',
    resource_type: 'page',
    tenant_id: 7,
    ...overrides,
  };
}
function mkCtx(
  r: IRequestor = mkRequestor(),
  a: IAction = mkAction(),
): IPolicyContext {
  return { requestor: r, action: a, entity: null, now: 1000, correlation_id: 'c-1' };
}

// --- rule 0: tenancy gate ----------------------------------------------

test('tenancy gate: requestor.tenant_id !== action.tenant_id -> deny before any policy runs', async () => {
  const sink = new FakeSink();
  const engine = new PolicyEngine({ auditSink: sink });
  let policyRan = false;
  engine.addPolicy(mkPolicy('A', () => {
    policyRan = true;
    return { kind: 'allow', policy: 'A' };
  }));

  const d = await engine.evaluate(
    mkCtx(mkRequestor({ tenant_id: 1 }), mkAction({ tenant_id: 2 })),
  );
  assert.equal(d.kind, 'deny');
  if (d.kind !== 'deny') return;
  assert.equal(d.policy, 'engine');
  assert.equal(d.reason, 'tenancy_mismatch');
  assert.equal(policyRan, false, 'policy ran despite tenancy mismatch');
  assert.equal(sink.events.length, 1);
  assert.deepEqual(sink.events[0]!.policy_chain, []);
});

// --- registration order + short-circuit on deny -----------------------

test('policies run in registration order', async () => {
  const engine = new PolicyEngine();
  const order: string[] = [];
  engine.addPolicy(mkPolicy('first', (_ctx) => {
    order.push('first');
    return { kind: 'allow' };
  }));
  engine.addPolicy(mkPolicy('second', (_ctx) => {
    order.push('second');
    return { kind: 'allow' };
  }));
  engine.addPolicy(mkPolicy('third', (_ctx) => {
    order.push('third');
    return { kind: 'allow' };
  }));
  await engine.evaluate(mkCtx());
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('deny short-circuits evaluation', async () => {
  const engine = new PolicyEngine();
  const order: string[] = [];
  engine.addPolicy(mkPolicy('a', () => {
    order.push('a');
    return { kind: 'allow' };
  }));
  engine.addPolicy(mkPolicy('b', () => {
    order.push('b');
    return { kind: 'deny', policy: 'b', reason: 'stop' };
  }));
  engine.addPolicy(mkPolicy('c', () => {
    order.push('c');
    return { kind: 'allow' };
  }));
  const d = await engine.evaluate(mkCtx());
  assert.equal(d.kind, 'deny');
  assert.deepEqual(order, ['a', 'b']);
});

test('require_approval short-circuits evaluation', async () => {
  const engine = new PolicyEngine();
  const order: string[] = [];
  engine.addPolicy(mkPolicy('a', () => {
    order.push('a');
    return { kind: 'allow' };
  }));
  engine.addPolicy(mkPolicy('b', () => {
    order.push('b');
    return { kind: 'require_approval', policy: 'b', approval_ref: 'r' };
  }));
  engine.addPolicy(mkPolicy('c', () => {
    order.push('c');
    return { kind: 'allow' };
  }));
  const d = await engine.evaluate(mkCtx());
  assert.equal(d.kind, 'require_approval');
  assert.deepEqual(order, ['a', 'b']);
});

// --- redirect does NOT short-circuit -----------------------------------

test('redirect does NOT short-circuit; later allow still runs; redirect is returned', async () => {
  const engine = new PolicyEngine();
  const order: string[] = [];
  engine.addPolicy(mkPolicy('a', () => {
    order.push('a');
    return { kind: 'allow' };
  }));
  engine.addPolicy(mkPolicy('b', () => {
    order.push('b');
    return { kind: 'redirect', policy: 'b', target: 'draft', payload: 'x' };
  }));
  engine.addPolicy(mkPolicy('c', () => {
    order.push('c');
    return { kind: 'allow' };
  }));
  const d = await engine.evaluate(mkCtx());
  assert.equal(d.kind, 'redirect');
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('redirect followed by deny -> deny wins', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(redirectP('draft'));
  engine.addPolicy(denyP('lock'));
  const d = await engine.evaluate(mkCtx());
  assert.equal(d.kind, 'deny');
});

test('multiple redirects — LAST wins', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(
    mkPolicy('first_redirect', () => ({
      kind: 'redirect',
      policy: 'first_redirect',
      target: 'draft',
      payload: 'ONE',
    })),
  );
  engine.addPolicy(
    mkPolicy('second_redirect', () => ({
      kind: 'redirect',
      policy: 'second_redirect',
      target: 'draft',
      payload: 'TWO',
    })),
  );
  const d = await engine.evaluate(mkCtx());
  assert.equal(d.kind, 'redirect');
  if (d.kind !== 'redirect') return;
  assert.equal(d.payload, 'TWO');
});

// --- all allow -> allow -----------------------------------------------

test('all policies allow -> engine returns allow', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(allowP('a'));
  engine.addPolicy(allowP('b'));
  engine.addPolicy(allowP('c'));
  const d = await engine.evaluate(mkCtx());
  assert.equal(d.kind, 'allow');
});

test('no policies registered -> allow', async () => {
  const engine = new PolicyEngine();
  const d = await engine.evaluate(mkCtx());
  assert.equal(d.kind, 'allow');
});

// --- audit emission ---------------------------------------------------

test('exactly one audit event emitted per evaluation', async () => {
  const sink = new FakeSink();
  const engine = new PolicyEngine({ auditSink: sink });
  engine.addPolicy(allowP('a'));
  engine.addPolicy(allowP('b'));
  engine.addPolicy(allowP('c'));
  await engine.evaluate(mkCtx());
  assert.equal(sink.events.length, 1);
});

test('audit event captures policy_chain in evaluation order', async () => {
  const sink = new FakeSink();
  const engine = new PolicyEngine({ auditSink: sink });
  engine.addPolicy(allowP('first'));
  engine.addPolicy(denyP('second', 'nope'));
  engine.addPolicy(allowP('third'));
  await engine.evaluate(mkCtx());
  assert.deepEqual(sink.events[0]!.policy_chain, ['first', 'second']);
});

test('audit event captures final decision', async () => {
  const sink = new FakeSink();
  const engine = new PolicyEngine({ auditSink: sink });
  engine.addPolicy(denyP('lock', 'agency_lock'));
  await engine.evaluate(mkCtx());
  const d = sink.events[0]!.decision;
  assert.equal(d.kind, 'deny');
  if (d.kind !== 'deny') return;
  assert.equal(d.reason, 'agency_lock');
});

test('audit event denormalizes requestor/action — no live references', async () => {
  const sink = new FakeSink();
  const engine = new PolicyEngine({ auditSink: sink });
  engine.addPolicy(allowP('a'));
  const requestor = mkRequestor({ scopes: ['pages:write'], role: 'agency' });
  const action = mkAction({ verb: 'update', area: 'pages', required_scope: 'pages:write' });
  await engine.evaluate(mkCtx(requestor, action));
  const e = sink.events[0]!;
  assert.equal(e.requestor.id, requestor.id);
  assert.equal(e.requestor.role, 'agency');
  assert.deepEqual(e.requestor.scopes, ['pages:write']);
  assert.equal(e.action.verb, 'update');
  assert.equal(e.action.area, 'pages');
  assert.equal(e.action.required_scope, 'pages:write');
});

test('emit_policy=off disables audit entirely', async () => {
  const sink = new FakeSink();
  const engine = new PolicyEngine({ auditSink: sink, emit_policy: 'off' });
  engine.addPolicy(denyP('a'));
  await engine.evaluate(mkCtx());
  assert.equal(sink.events.length, 0);
});

test('emit_policy=denials_only emits deny/redirect/require_approval but skips allow', async () => {
  const sink = new FakeSink();
  const engine = new PolicyEngine({ auditSink: sink, emit_policy: 'denials_only' });
  engine.addPolicy(allowP('a'));
  await engine.evaluate(mkCtx());
  assert.equal(sink.events.length, 0, 'allow was emitted when denials_only');

  const engine2 = new PolicyEngine({ auditSink: sink, emit_policy: 'denials_only' });
  engine2.addPolicy(denyP('d'));
  await engine2.evaluate(mkCtx());
  assert.equal(sink.events.length, 1, 'deny was not emitted when denials_only');
});

test('audit event emits on tenancy-mismatch deny (before policies run)', async () => {
  const sink = new FakeSink();
  const engine = new PolicyEngine({ auditSink: sink });
  engine.addPolicy(allowP('a'));
  await engine.evaluate(
    mkCtx(mkRequestor({ tenant_id: 1 }), mkAction({ tenant_id: 2 })),
  );
  assert.equal(sink.events.length, 1);
  assert.deepEqual(sink.events[0]!.policy_chain, []);
});

test('audit sink failure does NOT fail evaluation (RFC §9.4)', async () => {
  const engine = new PolicyEngine({ auditSink: new ThrowingSink() });
  engine.addPolicy(allowP('a'));
  // Should not throw
  const d = await engine.evaluate(mkCtx());
  assert.equal(d.kind, 'allow');
});

// --- null sink --------------------------------------------------------

test('null auditSink: engine still evaluates', async () => {
  const engine = new PolicyEngine({ auditSink: null });
  engine.addPolicy(allowP('a'));
  const d = await engine.evaluate(mkCtx());
  assert.equal(d.kind, 'allow');
});

// --- audit event schema fields ---------------------------------------

test('audit event has required fields: id, timestamp, correlation_id, tenant_id, latency_ms', async () => {
  const sink = new FakeSink();
  const engine = new PolicyEngine({ auditSink: sink });
  engine.addPolicy(allowP('a'));
  await engine.evaluate(mkCtx());
  const e = sink.events[0]!;
  assert.ok(e.id);
  assert.equal(typeof e.id, 'string');
  assert.ok(e.timestamp > 0);
  assert.equal(e.correlation_id, 'c-1');
  assert.equal(e.tenant_id, 7);
  assert.equal(typeof e.latency_ms, 'number');
  assert.ok(e.latency_ms >= 0);
});

test('audit event IDs are unique across evaluations', async () => {
  const sink = new FakeSink();
  const engine = new PolicyEngine({ auditSink: sink });
  engine.addPolicy(allowP('a'));
  await engine.evaluate(mkCtx());
  await engine.evaluate(mkCtx());
  await engine.evaluate(mkCtx());
  const ids = sink.events.map((e) => e.id);
  assert.equal(new Set(ids).size, 3);
});
