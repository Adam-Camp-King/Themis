// SPDX-License-Identifier: Apache-2.0
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { agent, buildEngine, buildGate } from './index.js';

function tu(name: string, input: unknown, id = 't') { return { type: 'tool_use' as const, id, name, input }; }

test('clean deletes pass; the tenth delete in the window is a hard block', async () => {
  const gate = buildGate(buildEngine(), agent);
  for (let i = 1; i <= 9; i++) {
    const r = await gate.execute(tu('delete_invoice', { id: i }, `t${i}`));
    assert.equal(r.is_error, undefined, `delete ${i} should pass: ${JSON.stringify(r)}`);
  }
  const r = await gate.execute(tu('delete_invoice', { id: 10 }, 't10'));
  assert.equal(r.is_error, true);
  assert.match(String(r.content), /anomaly_hard_block|bulk_delete/);
});

test('a custom-tier agent reaching for team.* needs owner approval', async () => {
  const r = await buildGate(buildEngine(), agent).execute(tu('update_role', { role: 'owner' }));
  // require_approval is not an error to Claude: the action is queued, not refused.
  assert.equal(r.is_error, undefined);
  assert.match(String(r.content), /themis_approval_pending/);
  assert.match(String(r.content), /scope_escalation:team/);
});

test('a quarantined identity is stopped before anything else runs', async () => {
  const r = await buildGate(buildEngine(), { ...agent, quarantined_at: Date.now() }).execute(tu('delete_invoice', { id: 1 }));
  assert.equal(r.is_error, true);
  assert.match(String(r.content), /\[themis\] quarantine: This agent is quarantined/);
});
