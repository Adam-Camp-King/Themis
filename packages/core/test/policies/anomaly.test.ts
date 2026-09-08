// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell
/**
 * scoreAction — runs spec/conformance/anomaly-scoring.json (the same file the
 * Python package runs) plus the memory stores' behaviour.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IAnomalyInput } from '../../src/index.js';
import { scoreAction, MemoryRateLimiter, MemoryReputationStore, effectiveLimit, DEDUCTIONS } from '../../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(join(here, '..', '..', '..', '..', 'spec', 'conformance', 'anomaly-scoring.json'), 'utf8')) as {
  cases: Array<{ name: string; input: IAnomalyInput; expect: unknown }>;
};

for (const c of doc.cases) {
  test(`anomaly-scoring.json › ${c.name}`, () => {
    const got = scoreAction(c.input);
    assert.deepEqual({ risk: got.risk, reasons: [...got.reasons], baseline_sample: got.baseline_sample, baseline_used: got.baseline_used }, c.expect);
  });
}

test('effectiveLimit scales by tier and reputation', () => {
  assert.equal(effectiveLimit('platform', 1), 1000);
  assert.equal(effectiveLimit('agency', 1), 200);
  assert.equal(effectiveLimit('custom', 1), 50);
  assert.equal(effectiveLimit('custom', 0.3), 15);
  assert.equal(effectiveLimit('custom', 0), 2);
});

test('MemoryRateLimiter: fixed minute window per (tenant, agent, verb)', async () => {
  const rl = new MemoryRateLimiter();
  const now = 1_700_000_000_000;
  for (let i = 1; i <= 50; i++) assert.equal((await rl.check(7, 'id:5', 'pages.update', 'custom', 1, now)).allowed, true);
  const over = await rl.check(7, 'id:5', 'pages.update', 'custom', 1, now);
  assert.equal(over.allowed, false); assert.equal(over.count, 51); assert.equal(over.limit, 50);
  assert.equal((await rl.check(7, 'id:5', 'pages.create', 'custom', 1, now)).allowed, true);
  assert.equal((await rl.check(7, 'id:5', 'pages.update', 'custom', 1, now + 60_000)).count, 1);
});

test('MemoryReputationStore: deduct by reason, recover slowly, clamp', async () => {
  const rep = new MemoryReputationStore();
  assert.equal(await rep.get(7, 'id:5'), 1);
  assert.equal(await rep.deduct(7, 'id:5', 't10_block'), 1 - DEDUCTIONS.t10_block!);
  for (let i = 0; i < 50; i++) await rep.deduct(7, 'id:5', 'quarantine');
  assert.equal(await rep.get(7, 'id:5'), 0.05);
  assert.equal(await rep.recover(7, 'id:5'), 0.052);
});
