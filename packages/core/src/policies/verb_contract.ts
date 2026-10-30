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
 *      A qualified action.verb must equal contract.id; an unqualified one
 *      must equal the part of contract.id after its first ':'.
 *   3. side_effects === 'read' → allow.
 *   4. policy_metadata.verb_contract.approved === true → allow.
 *   5. Collect reasons in order: requires_consent; irreversible (when
 *      approveIrreversible) or reversibility_unknown; impact:<x> for each
 *      approvalImpacts entry the contract lists, in approvalImpacts order;
 *      declared_write (when declaredWrites is 'require_approval' and
 *      provenance is not 'curated').
 *   6. Any reasons → require_approval.
 *   7. Otherwise allow.
 */

import type { IPolicy, IPolicyContext, IPolicyDecision, IRequestor, VerbImpact } from '../types.js';
import { isPlainObject } from '../internal/intent.js';
import { contractMatchesVerb, impactsOf, usableContract } from '../internal/verb_contract.js';

export const DEFAULT_APPROVAL_IMPACTS: readonly VerbImpact[] = ['money', 'access', 'deletion', 'data_export'];
const REVERSIBILITY = new Set(['reversible', 'compensable', 'irreversible']);

export interface VerbContractPolicyOptions {
  /** Requestor kinds that may only run verbs with a contract. Default ['agent']. */
  readonly requireContractFor?: readonly IRequestor['kind'][];
  /** Impacts that need approval. Default money, access, deletion, data_export. */
  readonly approvalImpacts?: readonly VerbImpact[];
  /** Irreversible writes need approval. Default true. */
  readonly approveIrreversible?: boolean;
  /** Writes whose contract is not curated. Default 'require_approval'. */
  readonly declaredWrites?: 'require_approval' | 'trust';
}

export class DefaultVerbContractPolicy implements IPolicy {
  readonly name = 'verb_contract' as const;
  private readonly requireFor: ReadonlySet<string>;
  private readonly approvalImpacts: readonly string[];
  private readonly approveIrreversible: boolean;
  private readonly declaredWrites: 'require_approval' | 'trust';

  constructor(opts: VerbContractPolicyOptions = {}) {
    this.requireFor = new Set(opts.requireContractFor ?? ['agent']);
    this.approvalImpacts = [...(opts.approvalImpacts ?? DEFAULT_APPROVAL_IMPACTS)];
    this.approveIrreversible = opts.approveIrreversible ?? true;
    this.declaredWrites = opts.declaredWrites ?? 'require_approval';
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
    if (!contractMatchesVerb(id, verb)) {
      return {
        kind: 'deny',
        policy: this.name,
        reason: 'contract_mismatch',
        message: `The verb contract ${id} does not describe ${verb}.`,
        detail: { verb, contract_id: id },
      };
    }

    // Rule 3
    if (contract['side_effects'] === 'read') return { kind: 'allow', policy: this.name };

    // Rule 4
    const meta = ctx.policy_metadata?.[this.name];
    if (isPlainObject(meta) && meta['approved'] === true) return { kind: 'allow', policy: this.name };

    // Rule 5
    const reasons: string[] = [];
    if (contract['requires_consent'] === true) reasons.push('requires_consent');
    const rev = contract['reversibility'];
    if (typeof rev !== 'string' || !REVERSIBILITY.has(rev)) reasons.push('reversibility_unknown');
    else if (rev === 'irreversible' && this.approveIrreversible) reasons.push('irreversible');
    const impacts = new Set(impactsOf(contract));
    for (const impact of this.approvalImpacts) if (impacts.has(impact)) reasons.push(`impact:${impact}`);
    if (this.declaredWrites === 'require_approval' && contract['provenance'] !== 'curated') reasons.push('declared_write');

    // Rules 6–7
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
