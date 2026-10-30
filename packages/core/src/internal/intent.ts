// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * Intent normalisation (RFC v0.3 draft § 2.7, § 9.5). Shared by the engine
 * (what the audit event records) and DefaultIntentPolicy (what counts as a
 * stated summary). The Python implementation mirrors this file rule for rule;
 * spec/conformance/v0/intent.json pins every edge.
 *
 * Normative rules:
 *  - Only the five spec fields are recorded. `summary`, `source`,
 *    `request_ref` and `tool_call_id` are recorded only when they are strings.
 *  - `attributes` is recorded only when it is a JSON object whose every value
 *    is JSON: null, boolean, finite number, string, array, or object with
 *    string keys, nested at most MAX_ATTRIBUTE_DEPTH deep. Anything else —
 *    NaN, Infinity, a Date, a class instance, a BigInt, a cycle — drops the
 *    whole `attributes` field. It is never coerced and never thrown.
 *  - An intent with nothing left to record is recorded as no intent.
 *  - A summary is blank when every character is in BLANK_CHARS: Unicode
 *    White_Space plus U+FEFF. This set is spelled out because JavaScript
 *    `trim()` and Python `str.strip()` disagree on it.
 *
 * Internal: not re-exported from index.ts.
 */

import type { IIntent } from '../types.js';

export const MAX_ATTRIBUTE_DEPTH = 32;

const STRING_FIELDS = ['summary', 'source', 'request_ref', 'tool_call_id'] as const;

/** Unicode White_Space (PropList.txt) plus U+FEFF. */
const BLANK = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$/;

export function isBlankSummary(summary: unknown): boolean {
  return typeof summary !== 'string' || BLANK.test(summary);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const DROP = Symbol('drop');

function copyJson(v: unknown, depth: number): unknown {
  if (depth > MAX_ATTRIBUTE_DEPTH) return DROP;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : DROP;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) {
      const c = copyJson(x, depth + 1);
      if (c === DROP) return DROP;
      out.push(c);
    }
    return out;
  }
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const c = copyJson(x, depth + 1);
      if (c === DROP) return DROP;
      out[k] = c;
    }
    return out;
  }
  return DROP; // undefined, bigint, symbol, function, Date, Map, class instances…
}

/** The detached, normalised intent an audit event records, or undefined for none. */
export function recordableIntent(intent: unknown): IIntent | undefined {
  if (!isPlainObject(intent)) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of STRING_FIELDS) {
    const v = intent[k];
    if (typeof v === 'string') out[k] = v;
  }
  if ('attributes' in intent && isPlainObject(intent['attributes'])) {
    const attrs = copyJson(intent['attributes'], 1);
    if (attrs !== DROP) out['attributes'] = attrs;
  }
  return Object.keys(out).length > 0 ? (out as IIntent) : undefined;
}
