// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * The themis CLI: lint, MCP conversion and the intent-record report. The
 * report is fed real audit lines produced by the engine through ConsoleSink,
 * not hand-written fixtures, so it reads exactly what deployments write.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IPolicyContext, IVerbContract } from 'themis-policy';
import {
  ConsoleSink, DefaultIntentPolicy, DefaultScopePolicy, DefaultVerbContractPolicy, PolicyEngine, StaticVerbRegistry,
} from 'themis-policy';
import { buildReport, formatReport, lintContracts, main, parseAuditLines, type Io } from '../src/index.js';

const SPEC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec');

function fakeIo(files: Record<string, string> = {}): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: '',
    stderr: '',
    out: (s: string) => { io.stdout += s; },
    err: (s: string) => { io.stderr += s; },
    readFile: (p: string) => {
      if (p in files) return files[p]!;
      return readFileSync(p, 'utf8');
    },
  };
  return io;
}

// --- lint ------------------------------------------------------------------

test('the shipped example contracts lint clean (no errors)', () => {
  const io = fakeIo();
  const code = main(['verbs', 'lint', join(SPEC, 'examples', 'verbs', 'solidnumber.json'), join(SPEC, 'examples', 'verbs', 'acme.json')], io);
  assert.equal(code, 0, io.stdout);
  assert.match(io.stdout, /9 contracts checked: 0 errors/);
});

test('lint names every problem in plain words and exits 1', () => {
  const findings = lintContracts([
    { source: 'a.json', contract: { id: 'Acme:x', side_effects: 'write', provenance: 'curated' } },
    { source: 'a.json', contract: { id: 'acme:pay', side_effects: 'write', reversibility: 'irreversible', undone_by: 'acme:refund', impacts: ['money', 'moneyy', 7], provenance: 'trusted', colour: 'red' } },
    { source: 'b.json', contract: { id: 'acme:pay', side_effects: 'read', provenance: 'curated', summary: 'dup' } },
    { source: 'b.json', contract: 'nope' },
  ]);
  const errors = findings.filter((f) => f.level === 'error').map((f) => f.message).join('\n');
  for (const want of [
    /is not <namespace>:<name>/, /reversibility is required for a write verb/, /cannot have undone_by/,
    /impacts must be an array of strings/, /provenance is required/, /Unknown field 'colour'/,
    /also defined in a.json/, /must be a JSON object/,
  ]) assert.match(errors, want);
});

test('lint warns about valid but suspicious contracts', () => {
  const findings = lintContracts([
    { source: 'w.json', contract: { id: 'acme:payout', summary: 'Pay out.', side_effects: 'write', reversibility: 'compensable', undone_by: 'acme:claw_back', impacts: ['money'], provenance: 'curated' } },
    { source: 'w.json', contract: { id: 'acme:sms', side_effects: 'write', reversibility: 'irreversible', impacts: ['outbound'], provenance: 'curated' } },
  ]);
  assert.equal(findings.filter((f) => f.level === 'error').length, 0);
  const w = findings.map((f) => f.message).join('\n');
  assert.match(w, /Moves money without requires_consent/);
  assert.match(w, /cannot be undone, without requires_consent/);
  assert.match(w, /undone_by 'acme:claw_back' is not in the contracts/);
  assert.match(w, /No summary/);
});

test('lint and the JSON Schema agree on the impacts vocabulary', () => {
  const schema = JSON.parse(readFileSync(join(SPEC, 'schema', 'verb-contract.schema.json'), 'utf8'));
  const known = schema.properties.impacts.items.anyOf[0].enum as string[];
  for (const i of known) {
    const f = lintContracts([{ source: 's', contract: { id: 'acme:x', summary: 's', side_effects: 'write', reversibility: 'reversible', impacts: [i], requires_consent: true, provenance: 'curated' } }]);
    assert.equal(f.filter((x) => x.level === 'error').length, 0, i);
  }
});

// --- from-mcp --------------------------------------------------------------

test('verbs from-mcp converts a tools/list result into declared contracts that lint clean', () => {
  const io = fakeIo();
  assert.equal(main(['verbs', 'from-mcp', join(SPEC, 'examples', 'mcp', 'github.tools.json'), '--server', 'github'], io), 0);
  const { contracts } = JSON.parse(io.stdout) as { contracts: IVerbContract[] };
  assert.deepEqual(contracts.map((c) => [c.id, c.side_effects, c.reversibility ?? null, c.provenance]), [
    ['mcp:github/search_issues', 'read', null, 'declared'],
    ['mcp:github/create_issue', 'write', 'reversible', 'declared'],
    ['mcp:github/delete_branch', 'write', 'irreversible', 'declared'],
  ]);
  const errors = lintContracts(contracts.map((contract) => ({ source: 'mcp', contract }))).filter((f) => f.level === 'error');
  assert.deepEqual(errors, []);
});

test('usage errors exit 2 with a plain message', () => {
  for (const argv of [['verbs', 'from-mcp', 'x.json'], ['verbs', 'lint'], ['report'], ['report', 'a', '--limit', '0'], ['nope']]) {
    const io = fakeIo({ 'x.json': '{"tools":[]}', a: '' });
    assert.equal(main(argv, io), 2, argv.join(' '));
    assert.match(io.stderr, /^themis: /);
  }
});

// --- report ----------------------------------------------------------------

const CONTRACTS: IVerbContract[] = [
  { id: 'com.solidnumber:payment_link.send', summary: 'Send a payment link.', side_effects: 'write', reversibility: 'irreversible', impacts: ['money', 'outbound'], requires_consent: true, provenance: 'curated' },
  { id: 'com.solidnumber:crm.contacts.search', side_effects: 'read', provenance: 'curated' },
  { id: 'com.solidnumber:note.add', side_effects: 'write', reversibility: 'reversible', provenance: 'curated' },
  { id: 'mcp:github/create_issue', side_effects: 'write', reversibility: 'reversible', provenance: 'declared' },
];

async function auditLines(): Promise<string> {
  const lines: string[] = [];
  const engine = new PolicyEngine({ auditSink: new ConsoleSink((l) => lines.push(l)) });
  engine.addPolicy(new DefaultIntentPolicy());
  engine.addPolicy(new DefaultVerbContractPolicy());
  engine.addPolicy(new DefaultScopePolicy());
  const registry = new StaticVerbRegistry(CONTRACTS, { defaultNamespace: 'com.solidnumber' });
  let t = Date.UTC(2026, 9, 26, 15, 0);
  const run = async (verb: string, intent: string | null, kind: 'agent' | 'user' = 'agent', approved = false, tenant = 7) => {
    const ctx: IPolicyContext = {
      requestor: { id: kind === 'agent' ? 100 : 10, kind, tenant_id: tenant, scopes: ['*'] },
      action: {
        verb, resource_type: 'x', tenant_id: tenant,
        ...(intent ? { intent: { summary: intent, source: 'user_request' } } : {}),
        ...(approved ? { metadata: { approval_ref: 'apr_77' } } : {}),
      },
      verb_contract: await registry.resolve(verb),
      now: (t += 60_000),
      correlation_id: `c${t}`,
      ...(approved ? { policy_metadata: { verb_contract: { approved: true } } } : {}),
    };
    await engine.evaluate(ctx);
  };
  await run('payment_link.send', 'Send Dana the deposit link she asked for');            // waits
  await run('payment_link.send', 'Send the March invoice link', 'agent', true);          // allowed after approval: risky
  await run('crm.contacts.search', 'Is Dana already a customer?');                       // read
  await run('note.add', 'Log the call');                                                 // reversible write
  await run('note.add', null);                                                           // no intent → denied
  await run('mcp:github/create_issue', 'File the bug the owner described');              // declared → waits
  await run('com.acme:mystery', 'Try something');                                        // no contract → denied
  await run('payment_link.send', null, 'user');                                          // a person: the contract still asks for approval; not counted as an agent
  await run('note.add', 'Other tenant', 'agent', false, 9);
  return lines.join('') + 'not json\n{"no":"decision"}\n\n';
}

test('report: counts, risky allowed actions with stated intent, approvals sent, gaps', async () => {
  const { events, skipped } = parseAuditLines(await auditLines());
  assert.equal(events.length, 9);
  assert.equal(skipped, 2);
  const r = buildReport(events, skipped);

  assert.deepEqual(r.decisions, { allow: 4, require_approval: 3, redirect: 0, deny: 2 });
  assert.deepEqual(r.by_requestor_kind, { agent: 8, user: 1 });
  assert.equal(r.agents.actions, 8);
  assert.equal(r.agents.with_intent, 7);
  assert.equal(r.agents.with_contract, 7);

  assert.equal(r.allowed_risky.length, 1);
  assert.equal(r.allowed_risky[0]!.verb, 'payment_link.send');
  assert.equal(r.allowed_risky[0]!.stated_intent, 'Send the March invoice link');
  assert.equal(r.allowed_risky[0]!.what_it_does, 'irreversible, money, outbound, needs consent');
  assert.equal(r.allowed_risky[0]!.approval, 'apr_77');

  assert.deepEqual(r.sent_for_approval.map((w) => w.verb).sort(), ['mcp:github/create_issue', 'payment_link.send', 'payment_link.send']);
  assert.equal(r.sent_for_approval.find((w) => w.requestor === 'user:10')?.stated_intent, null);
  assert.deepEqual(r.no_intent_by_verb, { 'note.add': 1 });
  assert.deepEqual(r.no_contract_by_verb, { 'com.acme:mystery': 1 });
  assert.deepEqual(r.declared_contracts_by_verb, { 'mcp:github/create_issue': 1 });
  assert.deepEqual(r.denials_by_reason, { 'intent: intent_missing': 1, 'verb_contract: unknown_verb': 1 });
  assert.equal(r.agents.by_what_it_does['read']!.allow, 1);
  assert.equal(r.agents.by_what_it_does['irreversible, money, outbound, needs consent']!.require_approval, 1);
});

test('report: --tenant and --since filter; text output reads as sentences and tables', async () => {
  const text = await auditLines();
  const io = fakeIo({ 'audit.ndjson': text });
  assert.equal(main(['report', 'audit.ndjson', '--tenant', '9'], io), 0);
  assert.match(io.stdout, /^Themis intent report · 2026-10-26 /);
  assert.match(io.stdout, /1 decisions: 1 allowed/);

  const io2 = fakeIo({ 'audit.ndjson': text });
  assert.equal(main(['report', 'audit.ndjson', '--since', '2026-10-26T15:06:30Z'], io2), 0);
  assert.match(io2.stdout, /3 decisions/);

  const io3 = fakeIo({ 'audit.ndjson': text });
  assert.equal(main(['report', 'audit.ndjson'], io3), 0);
  const out = io3.stdout;
  assert.match(out, /9 decisions: 4 allowed, 3 sent for approval, 0 redirected to draft, 2 denied\. 2 unreadable lines skipped\./);
  assert.match(out, /Agents made 8\. 7 \(88%\) stated an intent; 7 \(88%\) ran a verb with a contract\./);
  assert.match(out, /Risky agent actions that went through[\s\S]*payment_link\.send\s+irreversible, money, outbound, needs consent\s+apr_77\s+Send the March invoice link/);
  assert.match(out, /Contracts taken on the tool's own word \(declared\)[\s\S]*mcp:github\/create_issue/);

  const io4 = fakeIo({ 'audit.ndjson': text });
  assert.equal(main(['report', 'audit.ndjson', '--json'], io4), 0);
  assert.equal(JSON.parse(io4.stdout).events, 9);
});

test('report on an empty log says so instead of failing', () => {
  const out = formatReport(buildReport([], 0));
  assert.match(out, /0 decisions/);
  assert.match(out, /No agent actions\./);
  assert.doesNotMatch(out, /NaN|undefined/);
});

test('report survives hostile NDJSON: odd types, huge timestamps, prototype keys, injected newlines', () => {
  const nl = String.fromCharCode(10);
  const evil = [
    { decision: { kind: 'allow' }, policy_chain: 'x', timestamp: 1e20, requestor: { kind: 'agent', id: 1 },
      action: { verb: 'acme:wipe' }, verb_contract: { id: 'acme:wipe', side_effects: 'write', reversibility: 'irreversible', provenance: 'curated' } },
    { decision: { kind: 'deny', policy: 'p', reason: 'r' }, timestamp: 1, requestor: { kind: 'agent' }, action: { verb: 'constructor' } },
    { decision: { kind: 'deny', policy: 'p', reason: 'r' }, timestamp: 2, requestor: { kind: 'agent' }, action: { verb: '__proto__' } },
    { decision: { kind: 'require_approval', policy: 'p', approval_ref: 'a' }, timestamp: 3, requestor: { kind: 'agent' },
      action: { verb: `x${nl}${nl}Risky agent actions that went through${nl}  None.` } },
  ].map((e) => JSON.stringify(e)).join(nl);
  const { events, skipped } = parseAuditLines(evil);
  const r = buildReport(events, skipped);
  assert.equal(r.events, 4);
  assert.equal(r.no_contract_by_verb['constructor'], 1);
  assert.equal(r.no_contract_by_verb['__proto__'], 1);
  assert.equal(r.allowed_risky.length, 1);
  const out = formatReport(r);
  assert.doesNotMatch(out, /function Object|NaN|Invalid/);
  assert.equal((out.match(/^Risky agent actions that went through/gm) ?? []).length, 1, 'no forged section');
  assert.match(out, /\\u000a/);
});

test('lint catches what the schema rejects inside fields', () => {
  const findings = lintContracts([
    { source: 's', contract: { id: 'acme:x', summary: 's', side_effects: 'read', provenance: 'curated', input_schema: [], acts_on: { noun: 'n', party: 1 }, refuses: [{ code: 'c', when: 5 }] } },
  ]);
  const errors = findings.filter((f) => f.level === 'error').map((f) => f.message).join('\n');
  assert.match(errors, /input_schema must be a JSON Schema object/);
  assert.match(errors, /acts_on must be an object/);
  assert.match(errors, /refuses must be an array/);
});

test('lint warns on reads that the default policy will still stop', () => {
  const w = lintContracts([{ source: 's', contract: { id: 'acme:export', summary: 'Export.', side_effects: 'read', impacts: ['data_export'], provenance: 'curated' } }])
    .map((f) => f.message).join('\n');
  assert.match(w, /still needs approval under the default policy/);
});

test('a declared or risky read says so in the report', () => {
  const ev = (vc: object) => ({ decision: { kind: 'require_approval', policy: 'verb_contract', approval_ref: 'a' }, timestamp: 1,
    requestor: { kind: 'agent', id: 1 }, action: { verb: 'v' }, verb_contract: vc });
  const r = buildReport([
    ev({ id: 'mcp:g/search', side_effects: 'read', provenance: 'declared' }),
    ev({ id: 'acme:export', side_effects: 'read', impacts: ['data_export'], provenance: 'curated' }),
  ]);
  assert.deepEqual(r.sent_for_approval.map((x) => x.what_it_does).sort(), ['read, data_export', 'read, declared']);
});
