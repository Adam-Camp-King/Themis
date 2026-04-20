// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * @bounded/mcp — withBounded() wrapper tests.
 *
 * The adapter is the interface between "what the LLM wants to do" and
 * "what the policy engine permits." Mis-mapping a decision here would be
 * how a denial silently turns into a successful tool execution.
 */

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
import type {
  BoundedApprovalEnvelope,
  BoundedRedirectEnvelope,
} from '../src/index.js';
import { MCPPolicyDenied, withBounded } from '../src/index.js';

// --- helpers ---------------------------------------------------------

function mkPolicy(
  name: string,
  decisionFor: (ctx: IPolicyContext) => IPolicyDecision,
): IPolicy {
  return { name, evaluate: async (ctx) => decisionFor(ctx) };
}

interface ToolInput {
  tenant_id: number;
  agent_id: number;
  args: { amount: number };
}

function mkRequestorFrom(input: ToolInput): IRequestor {
  return {
    id: input.agent_id,
    kind: 'agent',
    tenant_id: input.tenant_id,
    scopes: ['invoices:write'],
  };
}
function mkActionFrom(input: ToolInput): IAction {
  return {
    verb: 'invoke',
    resource_type: 'invoice',
    tenant_id: input.tenant_id,
    required_scope: 'invoices:write',
    payload: input.args,
  };
}

// --- allow -----------------------------------------------------------

test('allow decision: tool executes, result returned unchanged', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const inner = async (input: ToolInput) => ({ ok: true, amount: input.args.amount });
  const wrapped = withBounded(inner, {
    engine,
    requestorFrom: mkRequestorFrom,
    actionFrom: mkActionFrom,
  });
  const out = await wrapped({ tenant_id: 7, agent_id: 1, args: { amount: 100 } });
  assert.deepEqual(out, { ok: true, amount: 100 });
});

test('allow: inner tool is called exactly once with the original input', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const calls: ToolInput[] = [];
  const inner = async (input: ToolInput) => {
    calls.push(input);
    return 'ok';
  };
  const wrapped = withBounded(inner, {
    engine,
    requestorFrom: mkRequestorFrom,
    actionFrom: mkActionFrom,
  });
  const input = { tenant_id: 7, agent_id: 1, args: { amount: 50 } };
  await wrapped(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], input);
});

// --- deny -----------------------------------------------------------

test('deny decision: throws MCPPolicyDenied by default; inner tool NOT called', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(
    mkPolicy('scope', () => ({
      kind: 'deny',
      policy: 'scope',
      reason: 'missing_scope',
      detail: { required: 'invoices:write' },
    })),
  );
  let called = false;
  const inner = async () => {
    called = true;
    return 'should-not-run';
  };
  const wrapped = withBounded(inner, {
    engine,
    requestorFrom: mkRequestorFrom,
    actionFrom: mkActionFrom,
  });
  await assert.rejects(
    async () => wrapped({ tenant_id: 7, agent_id: 1, args: { amount: 1 } }),
    (err: unknown) => {
      assert.ok(err instanceof MCPPolicyDenied);
      const e = err as MCPPolicyDenied;
      assert.equal(e.policy, 'scope');
      assert.equal(e.reason, 'missing_scope');
      assert.equal((e.detail as Record<string, unknown>).required, 'invoices:write');
      return true;
    },
  );
  assert.equal(called, false);
});

test('deny: onDenial override returns custom value instead of throwing', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(
    mkPolicy('scope', () => ({
      kind: 'deny',
      policy: 'scope',
      reason: 'missing_scope',
    })),
  );
  const wrapped = withBounded(async () => 'executed', {
    engine,
    requestorFrom: mkRequestorFrom,
    actionFrom: mkActionFrom,
    onDenial: (reason) => ({ error: `denied: ${reason}` }),
  });
  const out = await wrapped({ tenant_id: 7, agent_id: 1, args: { amount: 1 } });
  assert.deepEqual(out, { error: 'denied: missing_scope' });
});

// --- redirect ------------------------------------------------------

test('redirect: returns BoundedRedirectEnvelope; inner tool NOT called', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(
    mkPolicy('draft', () => ({
      kind: 'redirect',
      policy: 'draft',
      target: 'draft',
      payload: { title: 'draft' },
    })),
  );
  let called = false;
  const inner = async () => {
    called = true;
    return 'executed';
  };
  const wrapped = withBounded(inner, {
    engine,
    requestorFrom: mkRequestorFrom,
    actionFrom: mkActionFrom,
  });
  const out = (await wrapped({
    tenant_id: 7,
    agent_id: 1,
    args: { amount: 1 },
  })) as BoundedRedirectEnvelope;
  assert.equal(called, false);
  assert.equal(out.bounded_redirect, true);
  assert.equal(out.policy, 'draft');
  assert.equal(out.target, 'draft');
  assert.deepEqual(out.payload, { title: 'draft' });
});

// --- require_approval ---------------------------------------------

test('require_approval: returns BoundedApprovalEnvelope; inner tool NOT called', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(
    mkPolicy('approval', () => ({
      kind: 'require_approval',
      policy: 'approval',
      approval_ref: 'pending-123',
      message: 'admin must approve',
    })),
  );
  let called = false;
  const inner = async () => {
    called = true;
    return 'executed';
  };
  const wrapped = withBounded(inner, {
    engine,
    requestorFrom: mkRequestorFrom,
    actionFrom: mkActionFrom,
  });
  const out = (await wrapped({
    tenant_id: 7,
    agent_id: 1,
    args: { amount: 1 },
  })) as BoundedApprovalEnvelope;
  assert.equal(called, false);
  assert.equal(out.bounded_approval_pending, true);
  assert.equal(out.approval_ref, 'pending-123');
  assert.equal(out.message, 'admin must approve');
});

// --- context construction -----------------------------------------

test('entityFrom is consulted when provided', async () => {
  const engine = new PolicyEngine();
  const seen: IPolicyContext[] = [];
  engine.addPolicy(
    mkPolicy('x', (ctx) => {
      seen.push(ctx);
      return { kind: 'allow' };
    }),
  );
  const wrapped = withBounded(async () => 'ok', {
    engine,
    requestorFrom: mkRequestorFrom,
    actionFrom: mkActionFrom,
    entityFrom: async () => ({
      id: 42,
      tenant_id: 7,
      is_published: true,
      has_pending_draft: false,
      draft_updated_at: null,
      draft_updated_by: null,
    }),
  });
  await wrapped({ tenant_id: 7, agent_id: 1, args: { amount: 1 } });
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.entity);
  assert.equal((seen[0]!.entity as { id: number }).id, 42);
});

test('correlationIdFrom override is passed into context', async () => {
  const engine = new PolicyEngine();
  const seen: string[] = [];
  engine.addPolicy(
    mkPolicy('x', (ctx) => {
      seen.push(ctx.correlation_id);
      return { kind: 'allow' };
    }),
  );
  const wrapped = withBounded(async () => 'ok', {
    engine,
    requestorFrom: mkRequestorFrom,
    actionFrom: mkActionFrom,
    correlationIdFrom: () => 'my-trace-id',
  });
  await wrapped({ tenant_id: 7, agent_id: 1, args: { amount: 1 } });
  assert.equal(seen[0], 'my-trace-id');
});

test('default correlation ID is a 32-char hex string', async () => {
  const engine = new PolicyEngine();
  const seen: string[] = [];
  engine.addPolicy(
    mkPolicy('x', (ctx) => {
      seen.push(ctx.correlation_id);
      return { kind: 'allow' };
    }),
  );
  const wrapped = withBounded(async () => 'ok', {
    engine,
    requestorFrom: mkRequestorFrom,
    actionFrom: mkActionFrom,
  });
  await wrapped({ tenant_id: 7, agent_id: 1, args: { amount: 1 } });
  const cid = seen[0]!;
  assert.match(cid, /^[0-9a-f]{32}$/);
});

test('now override is used for context.now', async () => {
  const engine = new PolicyEngine();
  const seen: number[] = [];
  engine.addPolicy(
    mkPolicy('x', (ctx) => {
      seen.push(ctx.now);
      return { kind: 'allow' };
    }),
  );
  const wrapped = withBounded(async () => 'ok', {
    engine,
    requestorFrom: mkRequestorFrom,
    actionFrom: mkActionFrom,
    now: () => 9999,
  });
  await wrapped({ tenant_id: 7, agent_id: 1, args: { amount: 1 } });
  assert.equal(seen[0], 9999);
});

// --- tenancy ----------------------------------------------------

test('tenancy mismatch between requestor and action is caught by engine', async () => {
  const engine = new PolicyEngine();
  // No policy registered — engine's own tenancy gate fires.
  const wrapped = withBounded(async () => 'ok', {
    engine,
    requestorFrom: () => ({ id: 1, kind: 'agent', tenant_id: 1, scopes: [] }),
    actionFrom: () => ({ verb: 'invoke', resource_type: 'x', tenant_id: 2 }),
  });
  await assert.rejects(
    async () => wrapped({ tenant_id: 7, agent_id: 1, args: { amount: 1 } }),
    (err: unknown) => {
      assert.ok(err instanceof MCPPolicyDenied);
      const e = err as MCPPolicyDenied;
      assert.equal(e.policy, 'engine');
      assert.equal(e.reason, 'tenancy_mismatch');
      return true;
    },
  );
});
