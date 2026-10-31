// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * Verb contract lint (RFC v0.3 draft § 2.8). Errors cover everything the JSON
 * Schema (spec/schema/verb-contract.schema.json) rejects, in plain words, plus
 * duplicate ids across files; warnings are contracts that are valid but
 * probably wrong. Schemas inside input_schema/output_schema are not checked.
 */

import { isVerbId } from 'themis-policy';

export interface LintFinding {
  readonly level: 'error' | 'warning';
  readonly source: string;
  readonly id: string | null;
  readonly message: string;
}

export interface LintInput {
  readonly source: string;
  readonly contract: unknown;
}

const FIELDS = new Set([
  'id', 'version', 'summary', 'side_effects', 'reversibility', 'undone_by', 'impacts', 'requires_consent',
  'idempotent', 'required_scope', 'acts_on', 'refuses', 'input_schema', 'output_schema', 'provenance', 'extensions',
]);
const SIDE_EFFECTS = new Set(['read', 'write', 'mixed']);
const REVERSIBILITY = new Set(['reversible', 'compensable', 'irreversible']);
const IMPACTS = new Set(['money', 'access', 'outbound', 'deletion', 'data_export', 'publish']);
const PROVENANCE = new Set(['curated', 'declared']);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Lint a set of contracts together, so duplicate ids and undone_by references are checked across files. */
export function lintContracts(inputs: readonly LintInput[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const ids = new Map<string, string>();
  const undoRefs: Array<{ source: string; id: string; ref: string }> = [];

  for (const { source, contract: c } of inputs) {
    const id = isObject(c) && typeof c['id'] === 'string' ? c['id'] : null;
    const err = (message: string): void => { findings.push({ level: 'error', source, id, message }); };
    const warn = (message: string): void => { findings.push({ level: 'warning', source, id, message }); };

    if (!isObject(c)) { err('A contract must be a JSON object.'); continue; }

    if (id === null) err('id is required and must be a string.');
    else if (!isVerbId(id)) err(`id '${id}' is not <namespace>:<name>. The namespace is lowercase letters, digits, '.', '_' or '-'.`);
    else if (ids.has(id)) err(`id '${id}' is also defined in ${ids.get(id)}.`);
    else ids.set(id, source);

    for (const k of Object.keys(c)) if (!FIELDS.has(k)) err(`Unknown field '${k}'. Put owner-specific data under extensions.`);

    const se = c['side_effects'];
    const writes = se === 'write' || se === 'mixed';
    if (typeof se !== 'string' || !SIDE_EFFECTS.has(se)) err("side_effects is required: 'read', 'write' or 'mixed'.");

    const rev = c['reversibility'];
    if (rev !== undefined && (typeof rev !== 'string' || !REVERSIBILITY.has(rev)))
      err("reversibility must be 'reversible', 'compensable' or 'irreversible'.");
    else if (writes && rev === undefined)
      err(`reversibility is required for a ${se} verb. Without it the default policy asks for approval every time.`);
    else if (se === 'read' && rev !== undefined) warn('reversibility is ignored on a read verb.');

    const prov = c['provenance'];
    if (typeof prov !== 'string' || !PROVENANCE.has(prov)) err("provenance is required: 'curated' or 'declared'.");

    const impacts = c['impacts'];
    let impactList: string[] = [];
    if (impacts !== undefined) {
      if (!Array.isArray(impacts) || !impacts.every((x) => typeof x === 'string')) {
        err('impacts must be an array of strings. Any other shape is ignored by every policy.');
      } else {
        impactList = impacts;
        const seen = new Set<string>();
        for (const i of impacts) {
          if (seen.has(i)) err(`impacts lists '${i}' twice.`);
          seen.add(i);
          if (i.includes(':')) { if (!isVerbId(i)) err(`Extension impact '${i}' must be <namespace>:<name>.`); }
          else if (!IMPACTS.has(i)) err(`Unknown impact '${i}'. Use money, access, outbound, deletion, data_export or publish, or a namespaced extension like 'acme:${i}'.`);
        }
      }
    }

    for (const k of ['requires_consent', 'idempotent'] as const)
      if (c[k] !== undefined && typeof c[k] !== 'boolean') err(`${k} must be true or false. Any other value is ignored.`);
    for (const k of ['version', 'summary', 'required_scope'] as const)
      if (c[k] !== undefined && typeof c[k] !== 'string') err(`${k} must be a string.`);

    const undo = c['undone_by'];
    if (undo !== undefined) {
      if (!isVerbId(undo)) err('undone_by must be a verb id.');
      else if (rev === 'irreversible') err('An irreversible verb cannot have undone_by. Use compensable if a counter-action exists.');
      else if (id !== null) undoRefs.push({ source, id, ref: undo });
    }

    const actsOn = c['acts_on'];
    if (actsOn !== undefined && !(isObject(actsOn) && typeof actsOn['noun'] === 'string' && (actsOn['party'] === undefined || typeof actsOn['party'] === 'string')))
      err('acts_on must be an object with a string noun and, if given, a string party.');
    const refuses = c['refuses'];
    if (refuses !== undefined && !(Array.isArray(refuses) && refuses.every((r) => isObject(r) && typeof r['code'] === 'string' && (r['when'] === undefined || typeof r['when'] === 'string'))))
      err('refuses must be an array of { code, when } objects with string values.');
    for (const k of ['input_schema', 'output_schema'] as const)
      if (c[k] !== undefined && !isObject(c[k])) err(`${k} must be a JSON Schema object.`);
    if (c['extensions'] !== undefined && !(isObject(c['extensions']) && Object.values(c['extensions']).every(isObject)))
      err('extensions must map a namespace to an object.');

    if (typeof c['summary'] !== 'string' || c['summary'].trim() === '') warn('No summary. Reports and approval prompts read better with one.');
    if (se === 'read' && (c['requires_consent'] === true || impactList.some((i) => ['money', 'access', 'deletion', 'data_export'].includes(i))))
      warn('A read with requires_consent or a risky impact still needs approval under the default policy. Is it really a read?');
    if (prov === 'declared')
      warn('Declared: the default policy asks for approval on every call. Curate it once you have reviewed the tool.');
    if (writes && impactList.includes('money') && c['requires_consent'] !== true)
      warn('Moves money without requires_consent. Is a person meant to agree first?');
    if (writes && rev === 'irreversible' && impactList.includes('outbound') && c['requires_consent'] !== true)
      warn('Reaches someone outside the business and cannot be undone, without requires_consent.');
  }

  for (const { source, id, ref } of undoRefs) {
    if (!ids.has(ref))
      findings.push({ level: 'warning', source, id, message: `undone_by '${ref}' is not in the contracts being linted. Fine if another registry has it.` });
  }
  return findings;
}

/** Contracts from a parsed file: one contract, an array, or { contracts: [...] }. */
export function contractsFromJson(doc: unknown): unknown[] {
  if (Array.isArray(doc)) return doc;
  if (isObject(doc) && Array.isArray(doc['contracts'])) return doc['contracts'];
  return [doc];
}
