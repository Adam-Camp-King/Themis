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
import { isVerbId } from '../registry.js';

const SNAPSHOT_STRINGS = ['id', 'version', 'summary', 'side_effects', 'reversibility', 'provenance'] as const;

/** A contract the engine can use: a plain object with a string id. */
export function usableContract(c: unknown): Record<string, unknown> | null {
  return isPlainObject(c) && typeof c['id'] === 'string' ? c : null;
}

export const KNOWN_IMPACTS: ReadonlySet<string> = new Set(['money', 'access', 'outbound', 'deletion', 'data_export', 'publish']);

/**
 * A contract's impacts. `unknown` is true when `impacts` is present (not
 * undefined or null) but is not an array of strings, or lists a value that is
 * neither a well-known impact nor a namespaced extension. Policies treat an
 * unknown impact as a reason for approval: a typo must not fail open.
 */
export function readImpacts(c: Record<string, unknown>): { impacts: string[]; unknown: boolean } {
  const v = c['impacts'];
  if (v === undefined || v === null) return { impacts: [], unknown: false };
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return { impacts: [], unknown: true };
  const impacts = [...(v as string[])];
  return { impacts, unknown: impacts.some((i) => !KNOWN_IMPACTS.has(i) && !isVerbId(i)) };
}

/** The impacts a contract lists that are strings, or []. */
export function impactsOf(c: Record<string, unknown>): string[] {
  return readImpacts(c).impacts;
}

/**
 * Does `contractId` describe `verb`? A qualified verb must equal the id. An
 * unqualified one must equal `<defaultNamespace>:<verb>` when a default
 * namespace is given, and otherwise the part of the id after its first ':'.
 */
export function contractMatchesVerb(contractId: string, verb: string, defaultNamespace?: string): boolean {
  if (verb.includes(':')) return contractId === verb;
  if (defaultNamespace !== undefined) return contractId === `${defaultNamespace}:${verb}`;
  const i = contractId.indexOf(':');
  return i >= 0 && contractId.slice(i + 1) === verb;
}

/** The part of a qualified verb id after its first ':', or the verb itself. */
export function verbName(verb: string): string {
  return isVerbId(verb) ? verb.slice(verb.indexOf(':') + 1) : verb;
}

/** The snapshot an audit event records, or undefined when there is no usable contract. */
export function recordableContract(c: unknown): IVerbContractSnapshot | undefined {
  const contract = usableContract(c);
  if (!contract) return undefined;
  const out: Record<string, unknown> = {};
  // Each field on its own: one hostile getter loses that field, not the event.
  const read = (k: string): unknown => {
    try { return contract[k]; } catch { return undefined; }
  };
  for (const k of SNAPSHOT_STRINGS) {
    const v = read(k);
    if (typeof v === 'string') out[k] = v;
  }
  const impacts = read('impacts');
  if (Array.isArray(impacts) && impacts.every((x) => typeof x === 'string')) out['impacts'] = [...impacts];
  const consent = read('requires_consent');
  if (typeof consent === 'boolean') out['requires_consent'] = consent;
  return typeof out['id'] === 'string' ? (out as unknown as IVerbContractSnapshot) : undefined;
}
