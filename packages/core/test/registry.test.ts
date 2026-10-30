// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * Registries and the MCP mapping (RFC v0.3 draft § 2.8). Runs
 * spec/conformance/mcp-mapping.json, the same file the Python package runs,
 * and checks the shipped examples pass the verb ID grammar.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IVerbContract } from '../src/index.js';
import { ChainVerbRegistry, StaticVerbRegistry, contractFromMcpTool, isVerbId } from '../src/index.js';

const SPEC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec');
const mapping = JSON.parse(readFileSync(join(SPEC, 'conformance', 'mcp-mapping.json'), 'utf8')) as {
  cases: Array<{ name: string; server: string; tool: Parameters<typeof contractFromMcpTool>[1]; expect?: unknown; expect_error?: boolean }>;
};

for (const c of mapping.cases) {
  test(`mcp-mapping.json › ${c.name}`, () => {
    if (c.expect_error) assert.throws(() => contractFromMcpTool(c.server, c.tool), TypeError);
    else assert.deepEqual(contractFromMcpTool(c.server, c.tool), c.expect);
  });
}

const pay: IVerbContract = { id: 'com.solidnumber:payment_link.send', side_effects: 'write', reversibility: 'irreversible', provenance: 'curated' };
const note: IVerbContract = { id: 'acme:note.add', side_effects: 'write', reversibility: 'reversible', provenance: 'curated' };

test('static registry: exact id, default namespace for unqualified names, null otherwise', () => {
  const r = new StaticVerbRegistry([pay, note], { defaultNamespace: 'com.solidnumber' });
  assert.equal(r.resolve('com.solidnumber:payment_link.send'), pay);
  assert.equal(r.resolve('payment_link.send'), pay);
  assert.equal(r.resolve('note.add'), null, 'unqualified names resolve only in the default namespace');
  assert.equal(r.resolve('acme:note.add'), note);
  assert.equal(r.resolve('other:payment_link.send'), null);
});

test('static registry refuses duplicate ids', () => {
  assert.throws(() => new StaticVerbRegistry([pay, pay]), /duplicate verb id/);
});

test('chain registry: first hit wins, so curated shadows declared', async () => {
  const declared = { ...contractFromMcpTool('github', { name: 'create_issue' }) };
  const curated: IVerbContract = { ...declared, reversibility: 'reversible', impacts: [], provenance: 'curated' };
  const chain = new ChainVerbRegistry([new StaticVerbRegistry([curated]), new StaticVerbRegistry([declared])]);
  assert.equal((await chain.resolve('mcp:github/create_issue'))?.provenance, 'curated');
  assert.equal(await chain.resolve('mcp:github/nope'), null);
});

test('verb id grammar', () => {
  for (const ok of ['com.solidnumber:payment_link.send', 'acme:refund.issue', 'mcp:github/create_issue', 'skill:pdf-fill', 'a:b:c'])
    assert.equal(isVerbId(ok), true, ok);
  for (const bad of ['payment_link.send', 'Acme:x', ':x', 'acme:', 'acme: x', 'ac me:x', '', 42, 'acme:x\n', 'a:x\u001cy', 'a:x\u0085y', 'a:x\ufeffy', 'a:x\u00a0y'])
    assert.equal(isVerbId(bad), false, String(bad));
});

test('every shipped example contract has a valid id and a unique one', () => {
  const seen = new Set<string>();
  for (const f of ['solidnumber.json', 'acme.json']) {
    const doc = JSON.parse(readFileSync(join(SPEC, 'examples', 'verbs', f), 'utf8')) as { contracts: IVerbContract[] };
    for (const c of doc.contracts) {
      assert.equal(isVerbId(c.id), true, c.id);
      assert.equal(seen.has(c.id), false, c.id);
      seen.add(c.id);
    }
  }
});
