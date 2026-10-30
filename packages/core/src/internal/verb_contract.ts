// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * Verb contract helpers shared by the engine, the policy and scoreAction
 * (RFC v0.3 draft § 2.8, § 9.6). Mirrored rule for rule in Python
 * (themis/_verb_contract.py).
 *
 * Internal: not re-exported from index.ts.
 */

import type { IVerbContractSnapshot } from '../types.js';
import { isPlainObject } from './intent.js';

const SNAPSHOT_STRINGS = ['id', 'version', 'summary', 'side_effects', 'reversibility', 'provenance'] as const;

/** A contract the engine can use: a plain object with a string id. */
export function usableContract(c: unknown): Record<string, unknown> | null {
  return isPlainObject(c) && typeof c['id'] === 'string' ? c : null;
}

/** The impacts a contract lists, or [] unless `impacts` is an array of strings. */
export function impactsOf(c: Record<string, unknown>): string[] {
  const v = c['impacts'];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...(v as string[])] : [];
}

/** Does `contractId` describe `verb`? Qualified verbs match exactly; unqualified ones match the name. */
export function contractMatchesVerb(contractId: string, verb: string): boolean {
  if (verb.includes(':')) return contractId === verb;
  const i = contractId.indexOf(':');
  return i >= 0 && contractId.slice(i + 1) === verb;
}

/** The snapshot an audit event records, or undefined when there is no usable contract. */
export function recordableContract(c: unknown): IVerbContractSnapshot | undefined {
  const contract = usableContract(c);
  if (!contract) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of SNAPSHOT_STRINGS) {
    const v = contract[k];
    if (typeof v === 'string') out[k] = v;
  }
  const impacts = contract['impacts'];
  if (Array.isArray(impacts) && impacts.every((x) => typeof x === 'string')) out['impacts'] = [...impacts];
  if (typeof contract['requires_consent'] === 'boolean') out['requires_consent'] = contract['requires_consent'];
  return out as unknown as IVerbContractSnapshot;
}
