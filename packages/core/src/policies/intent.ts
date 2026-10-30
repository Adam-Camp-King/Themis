// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * DefaultIntentPolicy — an agent that will not say why does not act.
 *
 * Conforms to Themis RFC v0.3 (draft) § 5.7.
 *
 * Decision rules (normative, in order):
 *
 *   1. requestor.kind is not one of the configured kinds → allow.
 *      Default kinds: ['agent'].
 *   2. action.intent.summary is a string with at least one non-whitespace
 *      character → allow.
 *   3. Otherwise deny { reason: 'intent_missing' }.
 *
 * The policy checks that an intent was *stated*, not that it is true. Its job
 * is to make every agent action arrive with a claim that the audit trail can
 * later be checked against. Register it first so even a refused action that
 * stated nothing is recorded as such.
 */

import type { IPolicy, IPolicyContext, IPolicyDecision, IRequestor } from '../types.js';

export interface IntentPolicyOptions {
  /** Requestor kinds that must state an intent. Default ['agent']. */
  readonly kinds?: readonly IRequestor['kind'][];
}

export class DefaultIntentPolicy implements IPolicy {
  readonly name = 'intent' as const;
  private readonly kinds: ReadonlySet<string>;

  constructor(opts: IntentPolicyOptions = {}) {
    this.kinds = new Set(opts.kinds ?? ['agent']);
  }

  async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
    // Rule 1
    if (!this.kinds.has(ctx.requestor.kind)) {
      return { kind: 'allow', policy: this.name };
    }

    // Rule 2
    const summary: unknown = ctx.action.intent?.summary;
    if (typeof summary === 'string' && summary.trim().length > 0) {
      return { kind: 'allow', policy: this.name };
    }

    // Rule 3
    return {
      kind: 'deny',
      policy: this.name,
      reason: 'intent_missing',
      message: `This ${ctx.requestor.kind} action has no stated intent. Set action.intent.summary to say what it is for.`,
      detail: { requestor_kind: ctx.requestor.kind },
    };
  }
}
