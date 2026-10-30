// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * DefaultVerbContractPolicy — decide from what a verb does, not what it is called.
 *
 * Conforms to Themis RFC v0.3 (draft) § 5.8. Reads ctx.verb_contract (resolved
 * by the caller from an IVerbRegistry) and policy_metadata.verb_contract.
 *
 * Decision rules (normative, in order):
 *
 *   1. No usable contract (not a plain object, or no string id):
 *      requestor kind in requireContractFor → deny 'unknown_verb'; else allow.
 *   2. Contract describes another verb → deny 'contract_mismatch'.
 *   3. policy_metadata.verb_contract.approved === true → allow.
 *   4. Collect reasons, in this order:
 *        requires_consent                      — requires_consent is true (reads too)
 *        side_effects_unknown                  — side_effects is not read/write/mixed
 *        irreversible | reversibility_unknown  — not for reads
 *        impacts_unknown                       — impacts present but malformed or unrecognised
 *        impact:<x>                            — each approvalImpacts entry listed, in that order (reads too)
 *        declared_read | declared_write        — provenance is not 'curated'
 *   5. Any reasons → require_approval; otherwise allow.
 *
 * A malformed contract never fails open: anything unrecognised is a reason.
 */

import type { IPolicy, IPolicyContext, IPolicyDecision, IRequestor, VerbImpact } from '../types.js';
import { isPlainObject } from '../internal/intent.js';
import { contractMatchesVerb, readImpacts, usableContract } from '../internal/verb_contract.js';

export const DEFAULT_APPROVAL_IMPACTS: readonly VerbImpact[] = ['money', 'access', 'deletion', 'data_export'];
const REVERSIBILITY = new Set(['reversible', 'compensable', 'irreversible']);

export interface VerbContractPolicyOptions {
  /** Requestor kinds that may only run verbs with a contract. Default ['agent']. */
  readonly requireContractFor?: readonly IRequestor['kind'][];
  /** Impacts that need approval, on reads and writes alike. Default money, access, deletion, data_export. */
  readonly approvalImpacts?: readonly VerbImpact[];
  /** Irreversible writes need approval. Default true. */
  readonly approveIrreversible?: boolean;
  /** Writes whose contract is not curated. Default 'require_approval'. */
  readonly declaredWrites?: 'require_approval' | 'trust';
  /** Reads whose contract is not curated (a server's own read-only claim). Default 'require_approval'. */
  readonly declaredReads?: 'require_approval' | 'trust';
  /** Unqualified verbs must match `<defaultNamespace>:<verb>` exactly. */
  readonly defaultNamespace?: string;
}

function stringList(name: string, v: unknown, fallback: readonly string[]): string[] {
  if (v === undefined) return [...fallback];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new TypeError(`DefaultVerbContractPolicy: ${name} must be an array of strings`);
  }
  return [...v];
}

function choice<T extends string>(name: string, v: unknown, allowed: readonly T[], fallback: T): T {
  if (v === undefined) return fallback;
  if (!allowed.includes(v as T)) throw new TypeError(`DefaultVerbContractPolicy: ${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

export class DefaultVerbContractPolicy implements IPolicy {
  readonly name = 'verb_contract' as const;
  private readonly requireFor: ReadonlySet<string>;
  private readonly approvalImpacts: readonly string[];
  private readonly approveIrreversible: boolean;
  private readonly declaredWrites: 'require_approval' | 'trust';
  private readonly declaredReads: 'require_approval' | 'trust';
  private readonly defaultNamespace: string | undefined;

  constructor(opts: VerbContractPolicyOptions = {}) {
    this.requireFor = new Set(stringList('requireContractFor', opts.requireContractFor, ['agent']));
    this.approvalImpacts = stringList('approvalImpacts', opts.approvalImpacts, DEFAULT_APPROVAL_IMPACTS);
    if (opts.approveIrreversible !== undefined && typeof opts.approveIrreversible !== 'boolean') {
      throw new TypeError('DefaultVerbContractPolicy: approveIrreversible must be true or false');
    }
    this.approveIrreversible = opts.approveIrreversible ?? true;
    this.declaredWrites = choice('declaredWrites', opts.declaredWrites, ['require_approval', 'trust'], 'require_approval');
    this.declaredReads = choice('declaredReads', opts.declaredReads, ['require_approval', 'trust'], 'require_approval');
    if (opts.defaultNamespace !== undefined && typeof opts.defaultNamespace !== 'string') {
      throw new TypeError('DefaultVerbContractPolicy: defaultNamespace must be a string');
    }
    this.defaultNamespace = opts.defaultNamespace;
  }

  async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
    const verb = ctx.action.verb;
    const contract = usableContract(ctx.verb_contract);

    // Rule 1
    if (!contract) {
      if (!this.requireFor.has(ctx.requestor.kind)) return { kind: 'allow', policy: this.name };
      return {
        kind: 'deny',
        policy: this.name,
        reason: 'unknown_verb',
        message: `${verb} has no verb contract. Register one so Themis knows what it does.`,
        detail: { verb },
      };
    }
    const id = contract['id'] as string;

    // Rule 2
    if (!contractMatchesVerb(id, verb, this.defaultNamespace)) {
      return {
        kind: 'deny',
        policy: this.name,
        reason: 'contract_mismatch',
        message: `The verb contract ${id} does not describe ${verb}.`,
        detail: { verb, contract_id: id },
      };
    }

    // Rule 3
    const meta = ctx.policy_metadata?.[this.name];
    if (isPlainObject(meta) && meta['approved'] === true) return { kind: 'allow', policy: this.name };

    // Rule 4
    const reasons: string[] = [];
    const se = contract['side_effects'];
    const isRead = se === 'read';
    if (contract['requires_consent'] === true) reasons.push('requires_consent');
    if (!isRead) {
      if (se !== 'write' && se !== 'mixed') reasons.push('side_effects_unknown');
      const rev = contract['reversibility'];
      if (typeof rev !== 'string' || !REVERSIBILITY.has(rev)) reasons.push('reversibility_unknown');
      else if (rev === 'irreversible' && this.approveIrreversible) reasons.push('irreversible');
    }
    const { impacts, unknown } = readImpacts(contract);
    if (unknown) reasons.push('impacts_unknown');
    const listed = new Set(impacts);
    for (const impact of this.approvalImpacts) if (listed.has(impact)) reasons.push(`impact:${impact}`);
    if (contract['provenance'] !== 'curated') {
      if (isRead && this.declaredReads === 'require_approval') reasons.push('declared_read');
      if (!isRead && this.declaredWrites === 'require_approval') reasons.push('declared_write');
    }

    // Rule 5
    if (reasons.length === 0) return { kind: 'allow', policy: this.name };
    const ref = isPlainObject(meta) && typeof meta['approval_ref'] === 'string' ? meta['approval_ref'] : `verb:${id}`;
    return {
      kind: 'require_approval',
      policy: this.name,
      approval_ref: ref,
      message: `Needs approval before ${id} runs: ${reasons.join(', ')}.`,
    };
  }
}
