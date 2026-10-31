// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/** DefaultVerbContractPolicy and the snapshot: what the JSON vectors cannot express. */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IAuditEvent, IPolicyContext } from '../src/index.js';
import { DefaultIntentPolicy, DefaultVerbContractPolicy, PolicyEngine } from '../src/index.js';

function ctx(verb_contract: unknown): IPolicyContext {
  return {
    requestor: { id: 1, kind: 'agent', tenant_id: 7, scopes: ['*'] },
    action: { verb: 'acme:x', resource_type: 'x', tenant_id: 7 },
    verb_contract: verb_contract as IPolicyContext['verb_contract'],
    now: 0,
    correlation_id: 'c',
  };
}

test('options must be lists, not strings that would split into characters', () => {
  assert.throws(() => new DefaultVerbContractPolicy({ requireContractFor: 'agent' as never }), TypeError);
  assert.throws(() => new DefaultVerbContractPolicy({ approvalImpacts: 'money' as never }), TypeError);
  assert.throws(() => new DefaultVerbContractPolicy({ declaredWrites: 'yes' as never }), TypeError);
  assert.throws(() => new DefaultVerbContractPolicy({ approveIrreversible: 'false' as never }), TypeError);
  assert.throws(() => new DefaultIntentPolicy({ kinds: 'agent' as never }), TypeError);
});

test('a hostile getter on one snapshot field loses that field, not the audit event', async () => {
  const events: IAuditEvent[] = [];
  const engine = new PolicyEngine({ auditSink: { emit: (e) => { events.push(e); } } });
  const contract = {
    id: 'acme:x', side_effects: 'read', provenance: 'curated',
    get version(): string { throw new Error('boom'); },
  };
  assert.deepEqual(await engine.evaluate(ctx(contract)), { kind: 'allow' });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.verb_contract, { id: 'acme:x', side_effects: 'read', provenance: 'curated' });
});

test('the snapshot is detached from the live contract', async () => {
  const events: IAuditEvent[] = [];
  const engine = new PolicyEngine({ auditSink: { emit: (e) => { events.push(e); } } });
  const impacts = ['money'];
  const contract = { id: 'acme:x', side_effects: 'write', reversibility: 'reversible', impacts, provenance: 'curated' };
  await engine.evaluate(ctx(contract));
  impacts.push('access');
  assert.deepEqual(events[0]!.verb_contract?.impacts, ['money']);
});

test('a class instance or array is not a usable contract', async () => {
  class C { id = 'acme:x'; side_effects = 'read'; provenance = 'curated'; }
  const p = new DefaultVerbContractPolicy();
  assert.equal((await p.evaluate(ctx(new C()))).kind, 'deny');
  assert.equal((await p.evaluate(ctx([{ id: 'acme:x' }]))).kind, 'deny');
});
