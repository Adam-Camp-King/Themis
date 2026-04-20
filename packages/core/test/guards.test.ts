// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * Tests for the 4 type guards. Decision/classification logic: a wrong verdict
 * would mis-classify a policy outcome — e.g., treat a denial as an allow,
 * bypassing T10 locks or scope checks in production.
 *
 * Table-driven: every (guard, kind) pair is exercised; mutual exclusivity is
 * also asserted.
 *
 * Run: npm --workspace @themis/core test
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  isAllow,
  isDeny,
  isRedirect,
  isRequireApproval,
  type IPolicyDecision,
} from '../src/index.js';

const allow: IPolicyDecision = { kind: 'allow', policy: 'lock' };
const deny: IPolicyDecision = {
  kind: 'deny',
  policy: 'lock',
  reason: 'agency_lock',
  message: 'area locked',
  detail: { area: 'pages' },
};
const redirect: IPolicyDecision = {
  kind: 'redirect',
  policy: 'draft',
  target: 'draft',
  payload: { title: 'new' },
};
const require_approval: IPolicyDecision = {
  kind: 'require_approval',
  policy: 'approval',
  approval_ref: 'abc123',
};

const all: Readonly<Record<string, IPolicyDecision>> = {
  allow,
  deny,
  redirect,
  require_approval,
};

type Case = {
  guard: (d: IPolicyDecision) => boolean;
  label: string;
  match: IPolicyDecision['kind'];
};

const cases: readonly Case[] = [
  { guard: isAllow, label: 'isAllow', match: 'allow' },
  { guard: isDeny, label: 'isDeny', match: 'deny' },
  { guard: isRedirect, label: 'isRedirect', match: 'redirect' },
  { guard: isRequireApproval, label: 'isRequireApproval', match: 'require_approval' },
];

for (const { guard, label, match } of cases) {
  test(`${label} returns true only for kind === '${match}'`, () => {
    for (const [kind, decision] of Object.entries(all)) {
      const expected = kind === match;
      const actual = guard(decision);
      assert.equal(
        actual,
        expected,
        `${label}(${kind}) returned ${actual}; expected ${expected}`,
      );
    }
  });
}

test(`isDeny narrows to IDenyDecision (compile + runtime)`, () => {
  const d: IPolicyDecision = deny;
  if (isDeny(d)) {
    assert.equal(d.reason, 'agency_lock');
    assert.equal(d.policy, 'lock');
  } else {
    assert.fail('isDeny should have narrowed');
  }
});

test(`isRedirect narrows to IRedirectDecision`, () => {
  const d: IPolicyDecision = redirect;
  if (isRedirect(d)) {
    assert.equal(d.target, 'draft');
  } else {
    assert.fail('isRedirect should have narrowed');
  }
});

test(`guards are mutually exclusive on every decision`, () => {
  for (const [kind, decision] of Object.entries(all)) {
    const hits = [
      isAllow(decision),
      isDeny(decision),
      isRedirect(decision),
      isRequireApproval(decision),
    ].filter(Boolean).length;
    assert.equal(hits, 1, `exactly one guard must match for kind=${kind}, got ${hits}`);
  }
});
