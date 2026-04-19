import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type {
  IAction,
  IPolicy,
  IPolicyContext,
  IPolicyDecision,
  IRequestor,
} from '@bounded/core';
import { PolicyEngine } from '@bounded/core';
import { gateTool, LangChainPolicyDenied, type LangChainToolLike } from '../src/index.js';

function mkPolicy(
  name: string,
  decisionFor: (ctx: IPolicyContext) => IPolicyDecision,
): IPolicy {
  return { name, evaluate: async (ctx) => decisionFor(ctx) };
}
function mkRequestor(): IRequestor {
  return { id: 1, kind: 'agent', tenant_id: 7, scopes: ['x:write'] };
}
function mkAction(name: string): IAction {
  return {
    verb: 'invoke',
    resource_type: name,
    tenant_id: 7,
    required_scope: 'x:write',
  };
}

test('allow: gated call invokes underlying tool.call', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  let got: unknown = undefined;
  const raw: LangChainToolLike = {
    name: 'send_invoice',
    call: async (args) => {
      got = args;
      return 'ok';
    },
  };
  const gated = gateTool(raw, {
    engine,
    requestorFrom: mkRequestor,
    actionFrom: (_a, n) => mkAction(n),
  });
  const out = await gated.call({ amount: 100 });
  assert.equal(out, 'ok');
  assert.deepEqual(got, { amount: 100 });
});

test('allow: falls back to _call when call is absent', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const raw: LangChainToolLike = {
    name: 'x',
    _call: async () => '_called',
  };
  const gated = gateTool(raw, {
    engine,
    requestorFrom: mkRequestor,
    actionFrom: (_a, n) => mkAction(n),
  });
  const out = await gated.call({});
  assert.equal(out, '_called');
});

test('allow: falls back to invoke', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const raw: LangChainToolLike = { name: 'x', invoke: async () => 'invoked' };
  const gated = gateTool(raw, {
    engine,
    requestorFrom: mkRequestor,
    actionFrom: (_a, n) => mkAction(n),
  });
  assert.equal(await gated.call({}), 'invoked');
});

test('allow: falls back to func', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const raw: LangChainToolLike = { name: 'x', func: async () => 'funced' };
  const gated = gateTool(raw, {
    engine,
    requestorFrom: mkRequestor,
    actionFrom: (_a, n) => mkAction(n),
  });
  assert.equal(await gated.call({}), 'funced');
});

test('tool with no invoke method: gateTool throws', () => {
  const engine = new PolicyEngine();
  const raw: LangChainToolLike = { name: 'x' };
  assert.throws(() =>
    gateTool(raw, {
      engine,
      requestorFrom: mkRequestor,
      actionFrom: (_a, n) => mkAction(n),
    }),
  );
});

test('deny: throws LangChainPolicyDenied; tool NOT invoked', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(
    mkPolicy('scope', () => ({
      kind: 'deny',
      policy: 'scope',
      reason: 'missing_scope',
    })),
  );
  let called = false;
  const raw: LangChainToolLike = {
    name: 'x',
    call: async () => {
      called = true;
      return 'ran';
    },
  };
  const gated = gateTool(raw, {
    engine,
    requestorFrom: mkRequestor,
    actionFrom: (_a, n) => mkAction(n),
  });
  await assert.rejects(async () => gated.call({}), LangChainPolicyDenied);
  assert.equal(called, false);
});

test('deny: onDenial returns string instead of throwing', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('scope', () => ({ kind: 'deny', policy: 'scope', reason: 'missing_scope' })));
  const raw: LangChainToolLike = { name: 'x', call: async () => 'ran' };
  const gated = gateTool(raw, {
    engine,
    requestorFrom: mkRequestor,
    actionFrom: (_a, n) => mkAction(n),
    onDenial: (reason) => `Denied: ${reason}`,
  });
  assert.equal(await gated.call({}), 'Denied: missing_scope');
});

test('redirect: returns envelope; tool NOT invoked', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('draft', () => ({
    kind: 'redirect',
    policy: 'draft',
    target: 'draft',
    payload: 'p',
  })));
  let called = false;
  const raw: LangChainToolLike = {
    name: 'x',
    call: async () => {
      called = true;
      return 'ran';
    },
  };
  const gated = gateTool(raw, {
    engine,
    requestorFrom: mkRequestor,
    actionFrom: (_a, n) => mkAction(n),
  });
  const out = (await gated.call({})) as { bounded_redirect: boolean };
  assert.equal(called, false);
  assert.equal(out.bounded_redirect, true);
});

test('require_approval: returns envelope; tool NOT invoked', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('approval', () => ({
    kind: 'require_approval',
    policy: 'approval',
    approval_ref: 'ref-abc',
  })));
  const raw: LangChainToolLike = { name: 'x', call: async () => 'ran' };
  const gated = gateTool(raw, {
    engine,
    requestorFrom: mkRequestor,
    actionFrom: (_a, n) => mkAction(n),
  });
  const out = (await gated.call({})) as { bounded_approval_pending: boolean; approval_ref: string };
  assert.equal(out.bounded_approval_pending, true);
  assert.equal(out.approval_ref, 'ref-abc');
});

test('tool.name and tool.description preserved on gated tool', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const raw: LangChainToolLike = {
    name: 'send_invoice',
    description: 'Sends an invoice to a customer',
    call: async () => 'ok',
  };
  const gated = gateTool(raw, {
    engine,
    requestorFrom: mkRequestor,
    actionFrom: (_a, n) => mkAction(n),
  });
  assert.equal(gated.name, 'send_invoice');
  assert.equal(gated.description, 'Sends an invoice to a customer');
});
