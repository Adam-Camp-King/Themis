// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * Intent (RFC v0.3 draft § 2.7, § 5.7, § 9.5) — behaviour the JSON vectors
 * cannot express: the audit copy is detached from the live action, and
 * attributes that cannot be serialised never fail an evaluation.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IAuditEvent, IAuditSink, IPolicyContext } from '../src/index.js';
import { DefaultIntentPolicy, PolicyEngine } from '../src/index.js';

class Sink implements IAuditSink {
  events: IAuditEvent[] = [];
  emit(e: IAuditEvent): void { this.events.push(e); }
}

function ctx(intent: Record<string, unknown> | undefined): IPolicyContext {
  return {
    requestor: { id: 1, kind: 'agent', tenant_id: 7, scopes: ['*'] },
    action: { verb: 'invoice.send', resource_type: 'invoice', tenant_id: 7, ...(intent ? { intent } : {}) },
    now: 1_700_000_000_000,
    correlation_id: 'c-1',
  };
}

test('audit intent is a detached copy: later mutation of the action does not change the record', async () => {
  const sink = new Sink();
  const engine = new PolicyEngine({ auditSink: sink });
  const intent = { summary: 'Send the March invoice', attributes: { step: 1, tags: ['billing'] } };
  await engine.evaluate(ctx(intent));

  intent.summary = 'something else';
  intent.attributes.step = 99;
  intent.attributes.tags.push('tampered');

  const recorded = sink.events[0]!.intent!;
  assert.equal(recorded.summary, 'Send the March invoice');
  assert.deepEqual(recorded.attributes, { step: 1, tags: ['billing'] });
});

test('non-serialisable attributes are dropped, the evaluation still succeeds and is audited', async () => {
  const sink = new Sink();
  const engine = new PolicyEngine({ auditSink: sink });
  const decision = await engine.evaluate(ctx({ summary: 'Reconcile', attributes: { big: 10n } }));
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(sink.events.length, 1);
  assert.deepEqual(sink.events[0]!.intent, { summary: 'Reconcile' });
});

test('an action without intent produces an event with no intent key', async () => {
  const sink = new Sink();
  await new PolicyEngine({ auditSink: sink }).evaluate(ctx(undefined));
  assert.equal('intent' in sink.events[0]!, false);
});

test('intent policy reads only intent.summary; other fields alone do not satisfy it', async () => {
  const p = new DefaultIntentPolicy();
  const d = await p.evaluate(ctx({ source: 'user_request', tool_call_id: 'toolu_9' }));
  assert.equal(d.kind, 'deny');
});

test('intent policy with an empty kinds list never denies', async () => {
  const p = new DefaultIntentPolicy({ kinds: [] });
  assert.equal((await p.evaluate(ctx(undefined))).kind, 'allow');
});

test('non-finite numbers and Dates drop the whole attributes field (never coerced to null or a string)', async () => {
  for (const attributes of [{ n: Number.NaN }, { n: Infinity }, { when: new Date(0) }, { m: new Map() }, { deep: [1, { x: -Infinity }] }]) {
    const sink = new Sink();
    await new PolicyEngine({ auditSink: sink }).evaluate(ctx({ summary: 'Reconcile', attributes }));
    assert.deepEqual(sink.events[0]!.intent, { summary: 'Reconcile' });
  }
});

test('pathologically deep attributes are dropped without recursion errors', async () => {
  let deep: Record<string, unknown> = {};
  for (let i = 0; i < 200_000; i++) deep = { a: deep };
  const sink = new Sink();
  const d = await new PolicyEngine({ auditSink: sink }).evaluate(ctx({ summary: 'Reconcile', attributes: deep }));
  assert.deepEqual(d, { kind: 'allow' });
  assert.deepEqual(sink.events[0]!.intent, { summary: 'Reconcile' });
});

test('a throwing getter on intent skips the audit event but never fails the evaluation (RFC § 9.4)', async () => {
  const sink = new Sink();
  const intent = { summary: 'Reconcile', get source(): string { throw new Error('boom'); } };
  const d = await new PolicyEngine({ auditSink: sink }).evaluate(ctx(intent as unknown as Record<string, unknown>));
  assert.deepEqual(d, { kind: 'allow' });
  assert.equal(sink.events.length, 0);
});

test('no Web Crypto available: the evaluation still returns its decision (RFC § 9.4)', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    const d = await new PolicyEngine({ auditSink: new Sink() }).evaluate(ctx({ summary: 'Reconcile' }));
    assert.deepEqual(d, { kind: 'allow' });
  } finally {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved);
  }
});
