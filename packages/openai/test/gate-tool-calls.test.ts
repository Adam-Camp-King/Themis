// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type {
  IAction,
  IPolicy,
  IPolicyContext,
  IPolicyDecision,
  IRequestor,
} from 'themis-policy';
import { PolicyEngine } from 'themis-policy';
import { gateToolCalls, type OpenAIToolCall } from '../src/index.js';

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
function mkToolCall(overrides: Partial<OpenAIToolCall> = {}): OpenAIToolCall {
  return {
    id: 'call_1',
    type: 'function',
    function: {
      name: 'send_invoice',
      arguments: JSON.stringify({ amount: 100 }),
    },
    ...overrides,
  };
}

test('allow: handler invoked with parsed args; tool message content is stringified result', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  let gotArgs: unknown = undefined;
  const gate = gateToolCalls(
    {
      send_invoice: async (args) => {
        gotArgs = args;
        return { status: 'sent', amount: (args as { amount: number }).amount };
      },
    },
    {
      engine,
      requestorFrom: mkRequestor,
      actionFrom: (tc) => mkAction(tc.function.name),
    },
  );
  const msg = await gate.execute(mkToolCall());
  assert.equal(msg.role, 'tool');
  assert.equal(msg.tool_call_id, 'call_1');
  assert.deepEqual(JSON.parse(msg.content), { status: 'sent', amount: 100 });
  assert.deepEqual(gotArgs, { amount: 100 });
});

test('allow: empty arguments string parses to {}', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  let gotArgs: unknown;
  const gate = gateToolCalls(
    {
      send_invoice: async (a) => {
        gotArgs = a;
        return 'ok';
      },
    },
    { engine, requestorFrom: mkRequestor, actionFrom: (tc) => mkAction(tc.function.name) },
  );
  await gate.execute({
    id: 'c1',
    type: 'function',
    function: { name: 'send_invoice', arguments: '' },
  });
  assert.deepEqual(gotArgs, {});
});

test('invalid JSON arguments: returns tool message with error text; handler NOT called', async () => {
  const engine = new PolicyEngine();
  let evaluated = false;
  engine.addPolicy(mkPolicy('a', () => {
    evaluated = true;
    return { kind: 'allow' };
  }));
  let called = false;
  const gate = gateToolCalls(
    {
      send_invoice: async () => {
        called = true;
        return 'ok';
      },
    },
    { engine, requestorFrom: mkRequestor, actionFrom: (tc) => mkAction(tc.function.name) },
  );
  const msg = await gate.execute({
    id: 'c1',
    type: 'function',
    function: { name: 'send_invoice', arguments: '{not json' },
  });
  assert.ok(msg.content.includes('invalid JSON'));
  assert.equal(called, false);
  assert.equal(evaluated, false);
});

test('deny: tool message contains reason; handler NOT called', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('scope', () => ({
    kind: 'deny',
    policy: 'scope',
    reason: 'missing_scope',
    message: 'need x:write',
  })));
  let called = false;
  const gate = gateToolCalls(
    {
      send_invoice: async () => {
        called = true;
        return 'ran';
      },
    },
    { engine, requestorFrom: mkRequestor, actionFrom: (tc) => mkAction(tc.function.name) },
  );
  const msg = await gate.execute(mkToolCall());
  assert.ok(msg.content.includes('need x:write'));
  assert.equal(called, false);
});

test('redirect: tool message content is JSON with themis_redirect=true', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('draft', () => ({
    kind: 'redirect',
    policy: 'draft',
    target: 'draft',
    payload: { amount: 100 },
  })));
  let called = false;
  const gate = gateToolCalls(
    {
      send_invoice: async () => {
        called = true;
        return 'ran';
      },
    },
    { engine, requestorFrom: mkRequestor, actionFrom: (tc) => mkAction(tc.function.name) },
  );
  const msg = await gate.execute(mkToolCall());
  const parsed = JSON.parse(msg.content);
  assert.equal(parsed.themis_redirect, true);
  assert.equal(parsed.target, 'draft');
  assert.deepEqual(parsed.payload, { amount: 100 });
  assert.equal(called, false);
});

test('require_approval: content is JSON with themis_approval_pending=true + approval_ref', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('approval', () => ({
    kind: 'require_approval',
    policy: 'approval',
    approval_ref: 'pending-xyz',
    message: 'admin must approve',
  })));
  const gate = gateToolCalls(
    { send_invoice: async () => 'ran' },
    { engine, requestorFrom: mkRequestor, actionFrom: (tc) => mkAction(tc.function.name) },
  );
  const msg = await gate.execute(mkToolCall());
  const parsed = JSON.parse(msg.content);
  assert.equal(parsed.themis_approval_pending, true);
  assert.equal(parsed.approval_ref, 'pending-xyz');
});

test('unknown tool: returns tool message with error; handler/engine NOT called', async () => {
  const engine = new PolicyEngine();
  let evaluated = false;
  engine.addPolicy(mkPolicy('a', () => {
    evaluated = true;
    return { kind: 'allow' };
  }));
  const gate = gateToolCalls(
    { known: async () => 'ok' },
    { engine, requestorFrom: mkRequestor, actionFrom: (tc) => mkAction(tc.function.name) },
  );
  const msg = await gate.execute(mkToolCall({
    function: { name: 'ghost', arguments: '{}' },
  }));
  assert.ok(msg.content.includes('unknown tool'));
  assert.equal(evaluated, false);
});

test('handler throwing: tool message content starts with [error] and carries message', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const gate = gateToolCalls(
    {
      send_invoice: async () => {
        throw new Error('boom');
      },
    },
    { engine, requestorFrom: mkRequestor, actionFrom: (tc) => mkAction(tc.function.name) },
  );
  const msg = await gate.execute(mkToolCall());
  assert.ok(msg.content.startsWith('[error]'));
  assert.ok(msg.content.includes('boom'));
});

test('default correlation_id equals tool_call.id', async () => {
  const engine = new PolicyEngine();
  const seen: string[] = [];
  engine.addPolicy(mkPolicy('a', (ctx) => {
    seen.push(ctx.correlation_id);
    return { kind: 'allow' };
  }));
  const gate = gateToolCalls(
    { send_invoice: async () => 'ok' },
    { engine, requestorFrom: mkRequestor, actionFrom: (tc) => mkAction(tc.function.name) },
  );
  await gate.execute(mkToolCall({ id: 'call-abc' }));
  assert.equal(seen[0], 'call-abc');
});
