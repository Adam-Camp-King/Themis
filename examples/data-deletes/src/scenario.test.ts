import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  agentRequestor,
  buildEngine,
  buildGate,
  ownerRequestor,
} from './index.js';

test('agent deleting a locked page -> tool_result is_error=true; reason=agency_lock', async () => {
  const engine = buildEngine();
  const gate = buildGate(engine, agentRequestor());
  const result = await gate.execute({
    type: 'tool_use',
    id: 'tu-1',
    name: 'delete_page',
    input: { page_id: 1 },
  });
  assert.equal(result.is_error, true);
  assert.match(result.content as string, /lock/);
});

test('agent deleting an unlocked page -> handler runs', async () => {
  const engine = buildEngine();
  const gate = buildGate(engine, agentRequestor());
  const result = await gate.execute({
    type: 'tool_use',
    id: 'tu-2',
    name: 'delete_page',
    input: { page_id: 2 },
  });
  assert.equal(result.is_error, undefined);
  const parsed = JSON.parse(result.content as string);
  assert.equal(parsed.status, 'deleted');
});

test('agency owner bypasses the lock on a locked page', async () => {
  const engine = buildEngine();
  const gate = buildGate(engine, ownerRequestor());
  const result = await gate.execute({
    type: 'tool_use',
    id: 'tu-3',
    name: 'delete_page',
    input: { page_id: 1 },
  });
  assert.equal(result.is_error, undefined);
  const parsed = JSON.parse(result.content as string);
  assert.equal(parsed.status, 'deleted');
});

test('agent with no scope is denied BEFORE the lock check (scope policy runs first)', async () => {
  const engine = buildEngine();
  const unscoped = { ...agentRequestor(), scopes: [] };
  const gate = buildGate(engine, unscoped);
  const result = await gate.execute({
    type: 'tool_use',
    id: 'tu-4',
    name: 'delete_page',
    input: { page_id: 2 }, // unlocked — but scope check fires first
  });
  assert.equal(result.is_error, true);
  // the denial reason is scope (not lock), proving the engine short-circuits
  // on the first policy in registration order
  assert.match(result.content as string, /scope/);
});
