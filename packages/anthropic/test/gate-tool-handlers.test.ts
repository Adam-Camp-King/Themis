// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * themis-policy-anthropic — gateToolHandlers() tests.
 *
 * Verifies Themis policy decisions map correctly onto Anthropic's
 * tool_result block shape. A wrong mapping here silently lets Claude
 * proceed as if a denial didn't happen.
 */

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
import { gateToolHandlers, type ToolUseBlock } from '../src/index.js';

function mkPolicy(
  name: string,
  decisionFor: (ctx: IPolicyContext) => IPolicyDecision,
): IPolicy {
  return { name, evaluate: async (ctx) => decisionFor(ctx) };
}

function mkRequestor(): IRequestor {
  return { id: 1, kind: 'agent', tenant_id: 7, scopes: ['invoices:write'] };
}
function mkAction(toolName: string): IAction {
  return {
    verb: 'invoke',
    resource_type: toolName,
    tenant_id: 7,
    required_scope: 'invoices:write',
  };
}
function mkToolUse(overrides: Partial<ToolUseBlock> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tu-1',
    name: 'send_invoice',
    input: { amount: 100 },
    ...overrides,
  };
}

// --- allow -----------------------------------------------------------

test('allow: handler runs; tool_result is a JSON-stringified return value', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const gate = gateToolHandlers(
    {
      send_invoice: async (input) => ({
        ok: true,
        amount: (input as { amount: number }).amount,
      }),
    },
    { engine, requestorFrom: mkRequestor, actionFrom: (tu) => mkAction(tu.name) },
  );
  const result = await gate.execute(mkToolUse());
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, 'tu-1');
  assert.equal(result.is_error, undefined);
  assert.equal(result.content, JSON.stringify({ ok: true, amount: 100 }));
});

test('allow: string handler return is passed through as content', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const gate = gateToolHandlers(
    { tool_x: async () => 'raw string' },
    {
      engine,
      requestorFrom: mkRequestor,
      actionFrom: (tu) => mkAction(tu.name),
    },
  );
  const result = await gate.execute(mkToolUse({ name: 'tool_x' }));
  assert.equal(result.content, 'raw string');
});

test('allow: undefined handler return yields empty content', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const gate = gateToolHandlers(
    { tool_x: async () => undefined },
    {
      engine,
      requestorFrom: mkRequestor,
      actionFrom: (tu) => mkAction(tu.name),
    },
  );
  const result = await gate.execute(mkToolUse({ name: 'tool_x' }));
  assert.equal(result.content, '');
});

// --- deny -----------------------------------------------------------

test('deny: handler NOT called; tool_result has is_error=true and reason text', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(
    mkPolicy('scope', () => ({
      kind: 'deny',
      policy: 'scope',
      reason: 'missing_scope',
      message: "credential lacks 'invoices:write'",
    })),
  );
  let called = false;
  const gate = gateToolHandlers(
    {
      send_invoice: async () => {
        called = true;
        return 'should-not-run';
      },
    },
    { engine, requestorFrom: mkRequestor, actionFrom: (tu) => mkAction(tu.name) },
  );
  const result = await gate.execute(mkToolUse());
  assert.equal(called, false);
  assert.equal(result.is_error, true);
  assert.ok(String(result.content).includes('scope'));
  assert.ok(String(result.content).includes("credential lacks 'invoices:write'"));
});

test('deny with no message falls back to the reason', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(
    mkPolicy('lock', () => ({
      kind: 'deny',
      policy: 'lock',
      reason: 'agency_lock',
    })),
  );
  const gate = gateToolHandlers(
    { send_invoice: async () => 'ok' },
    { engine, requestorFrom: mkRequestor, actionFrom: (tu) => mkAction(tu.name) },
  );
  const result = await gate.execute(mkToolUse());
  assert.equal(result.is_error, true);
  assert.ok(String(result.content).includes('agency_lock'));
});

// --- redirect -------------------------------------------------------

test('redirect: handler NOT called; tool_result carries themis_redirect envelope (is_error unset)', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(
    mkPolicy('draft', () => ({
      kind: 'redirect',
      policy: 'draft',
      target: 'draft',
      payload: { amount: 100 },
    })),
  );
  let called = false;
  const gate = gateToolHandlers(
    {
      send_invoice: async () => {
        called = true;
        return 'ran';
      },
    },
    { engine, requestorFrom: mkRequestor, actionFrom: (tu) => mkAction(tu.name) },
  );
  const result = await gate.execute(mkToolUse());
  assert.equal(called, false);
  assert.equal(result.is_error, undefined);
  const parsed = JSON.parse(result.content as string);
  assert.equal(parsed.themis_redirect, true);
  assert.equal(parsed.target, 'draft');
  assert.deepEqual(parsed.payload, { amount: 100 });
});

// --- require_approval ----------------------------------------------

test('require_approval: handler NOT called; tool_result carries approval_ref', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(
    mkPolicy('approval', () => ({
      kind: 'require_approval',
      policy: 'approval',
      approval_ref: 'pending-abc',
      message: 'admin must approve',
    })),
  );
  let called = false;
  const gate = gateToolHandlers(
    {
      send_invoice: async () => {
        called = true;
        return 'ran';
      },
    },
    { engine, requestorFrom: mkRequestor, actionFrom: (tu) => mkAction(tu.name) },
  );
  const result = await gate.execute(mkToolUse());
  assert.equal(called, false);
  const parsed = JSON.parse(result.content as string);
  assert.equal(parsed.themis_approval_pending, true);
  assert.equal(parsed.approval_ref, 'pending-abc');
  assert.equal(parsed.message, 'admin must approve');
});

// --- unknown tool -------------------------------------------------

test('unknown tool: returns is_error=true without invoking engine', async () => {
  const engine = new PolicyEngine();
  let evaluated = false;
  engine.addPolicy(
    mkPolicy('a', () => {
      evaluated = true;
      return { kind: 'allow' };
    }),
  );
  const gate = gateToolHandlers(
    { known_tool: async () => 'ok' },
    { engine, requestorFrom: mkRequestor, actionFrom: (tu) => mkAction(tu.name) },
  );
  const result = await gate.execute(mkToolUse({ name: 'ghost_tool' }));
  assert.equal(result.is_error, true);
  assert.ok(String(result.content).includes('unknown tool'));
  assert.equal(evaluated, false);
});

// --- handler runtime errors ---------------------------------------

test('handler throwing: result is error with the message', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const gate = gateToolHandlers(
    {
      send_invoice: async () => {
        throw new Error('boom');
      },
    },
    { engine, requestorFrom: mkRequestor, actionFrom: (tu) => mkAction(tu.name) },
  );
  const result = await gate.execute(mkToolUse());
  assert.equal(result.is_error, true);
  assert.equal(result.content, 'boom');
});

test('handler throwing non-Error: result content is String(err)', async () => {
  const engine = new PolicyEngine();
  engine.addPolicy(mkPolicy('a', () => ({ kind: 'allow' })));
  const gate = gateToolHandlers(
    {
      send_invoice: async () => {
        throw 'weird string error'; // eslint-disable-line no-throw-literal
      },
    },
    { engine, requestorFrom: mkRequestor, actionFrom: (tu) => mkAction(tu.name) },
  );
  const result = await gate.execute(mkToolUse());
  assert.equal(result.is_error, true);
  assert.equal(result.content, 'weird string error');
});

// --- correlation id default ----------------------------------------

test('default correlation_id is the tool_use id', async () => {
  const engine = new PolicyEngine();
  const seen: string[] = [];
  engine.addPolicy(
    mkPolicy('a', (ctx) => {
      seen.push(ctx.correlation_id);
      return { kind: 'allow' };
    }),
  );
  const gate = gateToolHandlers(
    { send_invoice: async () => 'ok' },
    { engine, requestorFrom: mkRequestor, actionFrom: (tu) => mkAction(tu.name) },
  );
  await gate.execute(mkToolUse({ id: 'tu-xyz' }));
  assert.equal(seen[0], 'tu-xyz');
});

test('correlationIdFrom override is used', async () => {
  const engine = new PolicyEngine();
  const seen: string[] = [];
  engine.addPolicy(
    mkPolicy('a', (ctx) => {
      seen.push(ctx.correlation_id);
      return { kind: 'allow' };
    }),
  );
  const gate = gateToolHandlers(
    { send_invoice: async () => 'ok' },
    {
      engine,
      requestorFrom: mkRequestor,
      actionFrom: (tu) => mkAction(tu.name),
      correlationIdFrom: () => 'trace-override',
    },
  );
  await gate.execute(mkToolUse());
  assert.equal(seen[0], 'trace-override');
});

// --- intent (RFC v0.3 § 2.7) --------------------------------------------

test('a stated intent is stamped with the tool_use id in the audit event', async () => {
  const events: Array<{ intent?: { tool_call_id?: string; summary?: string } }> = [];
  const engine = new PolicyEngine({ auditSink: { emit: (e) => { events.push(e); } } });
  const gate = gateToolHandlers(
    { send_invoice: () => 'ok' },
    {
      engine,
      requestorFrom: () => mkRequestor(),
      actionFrom: (tu) => ({ ...mkAction(tu.name), intent: { summary: 'Send the March invoice' } }),
    },
  );
  await gate.execute(mkToolUse({ id: 'toolu_42', name: 'send_invoice' }));
  assert.equal(events[0]?.intent?.tool_call_id, 'toolu_42');
  assert.equal(events[0]?.intent?.summary, 'Send the March invoice');
});

test('an action with no intent is not given one', async () => {
  const events: Array<{ intent?: unknown }> = [];
  const engine = new PolicyEngine({ auditSink: { emit: (e) => { events.push(e); } } });
  const gate = gateToolHandlers(
    { send_invoice: () => 'ok' },
    { engine, requestorFrom: () => mkRequestor(), actionFrom: (tu) => mkAction(tu.name) },
  );
  await gate.execute(mkToolUse({ id: 'toolu_43', name: 'send_invoice' }));
  assert.equal(events[0]?.intent, undefined);
});

test('an empty or non-object intent is not stamped', async () => {
  for (const intent of [{}, 'do it', ['a']]) {
    const events: Array<{ intent?: unknown }> = [];
    const engine = new PolicyEngine({ auditSink: { emit: (e) => { events.push(e); } } });
    const gate = gateToolHandlers(
      { send_invoice: () => 'ok' },
      { engine, requestorFrom: () => mkRequestor(), actionFrom: (tu) => ({ ...mkAction(tu.name), intent: intent as never }) },
    );
    await gate.execute(mkToolUse({ id: 'toolu_44', name: 'send_invoice' }));
    assert.equal(events[0]?.intent, undefined, JSON.stringify(intent));
  }
});

// --- verb contracts (RFC v0.3 § 2.8, § 9.6) -------------------------------

test('verbRegistry: the contract reaches the policy and the audit event; Claude sees the approval envelope', async () => {
  const { DefaultVerbContractPolicy, StaticVerbRegistry } = await import('themis-policy');
  const events: Array<{ verb_contract?: { id?: string; impacts?: readonly string[] } }> = [];
  const engine = new PolicyEngine({ auditSink: { emit: (e) => { events.push(e); } } });
  engine.addPolicy(new DefaultVerbContractPolicy());
  let ran = false;
  const gate = gateToolHandlers(
    { send_payment_link: () => { ran = true; return 'sent'; } },
    {
      engine,
      requestorFrom: () => mkRequestor(),
      actionFrom: () => ({ verb: 'payment_link.send', resource_type: 'payment_link', tenant_id: 7 }),
      verbRegistry: new StaticVerbRegistry(
        [{ id: 'com.solidnumber:payment_link.send', side_effects: 'write', reversibility: 'irreversible', impacts: ['money'], provenance: 'curated' }],
        { defaultNamespace: 'com.solidnumber' },
      ),
    },
  );
  const r = await gate.execute(mkToolUse({ id: 'toolu_50', name: 'send_payment_link' }));
  assert.equal(ran, false);
  assert.match(String(r.content), /themis_approval_pending/);
  assert.match(String(r.content), /irreversible, impact:money/);
  assert.equal(events[0]?.verb_contract?.id, 'com.solidnumber:payment_link.send');
  assert.deepEqual(events[0]?.verb_contract?.impacts, ['money']);
});

test('verbRegistry that throws resolves to no contract: an agent fails closed, the call does not crash', async () => {
  const { DefaultVerbContractPolicy } = await import('themis-policy');
  const engine = new PolicyEngine();
  engine.addPolicy(new DefaultVerbContractPolicy());
  const gate = gateToolHandlers(
    { send_invoice: () => 'ok' },
    {
      engine,
      requestorFrom: () => mkRequestor(),
      actionFrom: (tu) => mkAction(tu.name),
      verbRegistry: { resolve: () => { throw new Error('registry down'); } },
    },
  );
  const r = await gate.execute(mkToolUse({ id: 'toolu_51', name: 'send_invoice' }));
  assert.equal(r.is_error, true);
  assert.match(String(r.content), /unknown_verb|has no verb contract/);
});
