// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * End-to-end scenario tests for the finance-ops example.
 *
 * Verifies the full Themis stack produces the expected tool_result
 * envelopes for the three canonical scenarios (no scope / small allowed /
 * large requires approval).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildEngine, buildGate, buildRequestor } from './index.js';

test('no scope -> tool_result is_error=true with deny reason', async () => {
  const engine = buildEngine();
  const requestor = buildRequestor([]); // empty scopes
  const gate = buildGate(engine, requestor);

  const result = await gate.execute({
    type: 'tool_use',
    id: 'tu-1',
    name: 'send_wire_transfer',
    input: { amount: 500, to: 'v' },
  });
  assert.equal(result.is_error, true);
  assert.ok(String(result.content).includes('scope'));
});

test('scoped + small amount -> tool_result with wire_id (handler ran)', async () => {
  const engine = buildEngine();
  const requestor = buildRequestor(['payments:write']);
  const gate = buildGate(engine, requestor);

  const result = await gate.execute({
    type: 'tool_use',
    id: 'tu-2',
    name: 'send_wire_transfer',
    input: { amount: 500, to: 'v' },
  });
  assert.equal(result.is_error, undefined);
  const parsed = JSON.parse(result.content as string);
  assert.equal(parsed.status, 'sent');
  assert.equal(parsed.amount, 500);
  assert.ok(parsed.wire_id.startsWith('wire-'));
});

test('scoped + $500k -> tool_result with themis_approval_pending (handler did NOT run)', async () => {
  const engine = buildEngine();
  const requestor = buildRequestor(['payments:write']);
  const gate = buildGate(engine, requestor);

  const result = await gate.execute({
    type: 'tool_use',
    id: 'tu-3',
    name: 'send_wire_transfer',
    input: { amount: 500_000, to: 'v' },
  });
  assert.equal(result.is_error, undefined);
  const parsed = JSON.parse(result.content as string);
  assert.equal(parsed.themis_approval_pending, true);
  assert.ok(parsed.approval_ref.startsWith('approval-'));
  assert.ok(String(parsed.message).includes('500,000'));
});

test('scoped + threshold-boundary ($10k) allowed; +$1 requires approval', async () => {
  const engine = buildEngine();
  const requestor = buildRequestor(['payments:write']);
  const gate = buildGate(engine, requestor);

  const at = await gate.execute({
    type: 'tool_use',
    id: 'tu-at',
    name: 'send_wire_transfer',
    input: { amount: 10_000, to: 'v' },
  });
  // allowed
  assert.equal(at.is_error, undefined);
  const atParsed = JSON.parse(at.content as string);
  assert.equal(atParsed.status, 'sent');

  const over = await gate.execute({
    type: 'tool_use',
    id: 'tu-over',
    name: 'send_wire_transfer',
    input: { amount: 10_001, to: 'v' },
  });
  const overParsed = JSON.parse(over.content as string);
  assert.equal(overParsed.themis_approval_pending, true);
});
