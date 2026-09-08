// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell
/**
 * Conformance harness — runs spec/conformance/v0/*.json through this
 * implementation. The SAME files are run by the Python package. An
 * implementation that passes them conforms to Themis RFC v0 § 11.
 *
 * Vector shape: see spec/conformance/README.md.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IAuditEvent, IAuditSink, IPolicy, IPolicyContext, IPolicyDecision, IRequestor, IAction } from '../src/index.js';
import { PolicyEngine, DefaultLockPolicy, DefaultScopePolicy, DefaultDraftPolicy } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(here, '..', '..', '..', 'spec', 'conformance', 'v0');

interface StubSpec { stub: 'allow' | 'deny' | 'redirect' | 'require_approval'; name: string; [k: string]: unknown }
interface ScopeSpec { name: 'scope'; rules?: Array<{ method: string; path: string; required_scope: string }> }
type PolicySpec = 'lock' | 'scope' | 'draft' | StubSpec | ScopeSpec;

interface Case {
  name: string;
  policies?: PolicySpec[];
  emit_policy?: 'all' | 'denials_only' | 'off';
  requestor: IRequestor;
  action: IAction;
  entity?: Record<string, unknown> | null;
  expect: { decision: IPolicyDecision; policy_chain: string[]; audit?: 'none' | Record<string, unknown> };
}

class MemSink implements IAuditSink { events: IAuditEvent[] = []; emit(e: IAuditEvent) { this.events.push(e); } }

function stub(spec: StubSpec): IPolicy {
  return {
    name: spec.name,
    async evaluate(): Promise<IPolicyDecision> {
      switch (spec.stub) {
        case 'allow': return { kind: 'allow', policy: spec.name };
        case 'deny': return { kind: 'deny', policy: spec.name, reason: String(spec.reason ?? 'stub'), message: spec.message as string | undefined };
        case 'redirect': return { kind: 'redirect', policy: spec.name, target: 'draft', payload: spec.payload ?? null };
        case 'require_approval': return { kind: 'require_approval', policy: spec.name, approval_ref: String(spec.approval_ref ?? 'ref'), message: spec.message as string | undefined };
      }
    },
  };
}

function build(spec: PolicySpec): IPolicy {
  if (spec === 'lock') return new DefaultLockPolicy();
  if (spec === 'draft') return new DefaultDraftPolicy();
  if (spec === 'scope') return new DefaultScopePolicy();
  if ('stub' in spec) return stub(spec);
  const p = new DefaultScopePolicy();
  for (const r of spec.rules ?? []) p.addRule({ method: r.method, path_pattern: r.path }, r.required_scope);
  return p;
}

/** Canonical form: drop undefined/null-valued keys recursively so TS and Python compare equal. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (val !== undefined && val !== null) o[k] = canon(val);
    return o;
  }
  return v;
}

for (const file of readdirSync(VECTORS).filter((f) => f.endsWith('.json')).sort()) {
  const doc = JSON.parse(readFileSync(join(VECTORS, file), 'utf8')) as { cases: Case[] };
  for (const c of doc.cases) {
    test(`${file} › ${c.name}`, async () => {
      const sink = new MemSink();
      const engine = new PolicyEngine({ auditSink: sink, emit_policy: c.emit_policy ?? 'all' });
      for (const p of c.policies ?? []) engine.addPolicy(build(p));
      const ctx: IPolicyContext = {
        requestor: c.requestor, action: c.action, entity: (c.entity ?? null) as IPolicyContext['entity'],
        now: 1_700_000_000_000, correlation_id: `conf-${c.name}`,
      };
      const decision = await engine.evaluate(ctx);
      assert.deepEqual(canon(decision), canon(c.expect.decision), 'decision');
      if (c.expect.audit === 'none') {
        assert.equal(sink.events.length, 0, 'no audit event expected');
      } else {
        assert.equal(sink.events.length, 1, 'exactly one audit event');
        const e = sink.events[0]!;
        assert.deepEqual([...e.policy_chain], c.expect.policy_chain, 'policy_chain');
        assert.deepEqual(canon(e.decision), canon(c.expect.decision));
        assert.equal(e.tenant_id, c.action.tenant_id);
        assert.equal(e.correlation_id, ctx.correlation_id);
        if (c.expect.audit && typeof c.expect.audit === 'object') {
          const got = canon({ requestor: e.requestor, action: e.action }) as Record<string, unknown>;
          assert.deepEqual(got, canon(c.expect.audit), 'audit denormalization');
        }
      }
    });
  }
}

// Preview tokens are a separate vector file: verify-only, ground truth minted by this implementation.
test('preview-tokens.json › verify vectors', () => {
  const doc = JSON.parse(readFileSync(join(VECTORS, '..', 'preview-tokens.json'), 'utf8')) as { secret: string; cases: Array<{ name: string; token: string; expect: unknown }> };
  const p = new DefaultDraftPolicy();
  for (const c of doc.cases) assert.deepEqual(p.verifyPreviewToken(c.token, doc.secret), c.expect, c.name);
});
