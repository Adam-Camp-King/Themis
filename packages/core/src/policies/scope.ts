// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * DefaultScopePolicy — flat-membership scope authorization.
 *
 * Decides whether the requestor's credential carries the scope the action
 * requires. A missing scope is a hard deny.
 *
 * Ported from Solid# `solid-backend/middleware/auth.py:376-422` and
 * `solid-backend/models/cli_api_key.py:178-182` (has_scope).
 * Conforms to Themis RFC v0 § 5.3.
 *
 * Decision rule (first match wins):
 *
 *   1. requestor.is_super_admin                        -> allow
 *   2. requestor.scopes includes '*'                   -> allow
 *   3. requestor.kind === 'user' && scopes is empty    -> allow  (session user)
 *   4. required_scope resolves to null                 -> allow  (no scope needed)
 *   5. requestor.scopes includes required_scope        -> allow
 *   6. otherwise                                       -> deny
 *
 * `required_scope` is taken from `action.required_scope` first. If absent,
 * the policy consults its registered rule table (path + method, or predicate)
 * to resolve one. If no rule matches, the action passes scope policy (rule 4).
 *
 * Flat membership is the default per RFC v0: `pages:write` does NOT imply
 * `pages:read`. Wildcards beyond `*` are opt-in extensions (not in core).
 */

import type {
  IPolicy,
  IPolicyContext,
  IPolicyDecision,
  IScopePolicy,
  ScopeRuleMatcher,
} from '../types.js';

interface ScopeRule {
  matcher: ScopeRuleMatcher;
  required_scope: string;
}

export class DefaultScopePolicy implements IScopePolicy, IPolicy {
  readonly name = 'scope' as const;
  private readonly rules: ScopeRule[] = [];

  async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
    // 1. Super admin bypass
    if (ctx.requestor.is_super_admin === true) {
      return { kind: 'allow', policy: this.name };
    }

    // 2. Wildcard scope — granted full access
    if (ctx.requestor.scopes.includes('*')) {
      return { kind: 'allow', policy: this.name };
    }

    // 3. Session users (kind='user', no scopes) bypass scope checks
    if (ctx.requestor.kind === 'user' && ctx.requestor.scopes.length === 0) {
      return { kind: 'allow', policy: this.name };
    }

    // 4. Resolve the required scope
    const required = ctx.action.required_scope ?? this.resolveRequired(ctx);
    if (!required) {
      return { kind: 'allow', policy: this.name };
    }

    // 5. Flat membership check
    if (ctx.requestor.scopes.includes(required)) {
      return { kind: 'allow', policy: this.name };
    }

    // 6. Deny
    return {
      kind: 'deny',
      policy: this.name,
      reason: 'missing_scope',
      message: `Missing required scope '${required}'.`,
      detail: {
        required,
        held: Array.from(ctx.requestor.scopes),
      },
    };
  }

  addRule(matcher: ScopeRuleMatcher, required_scope: string): void {
    this.rules.push({ matcher, required_scope });
  }

  /** Return every distinct scope mentioned in any registered rule. */
  listScopes(): readonly string[] {
    const seen = new Set<string>();
    for (const r of this.rules) seen.add(r.required_scope);
    return Array.from(seen);
  }

  private resolveRequired(ctx: IPolicyContext): string | null {
    for (const { matcher, required_scope } of this.rules) {
      if (typeof matcher === 'function') {
        if (matcher(ctx)) return required_scope;
      } else {
        const method = (ctx.action.metadata?.['method'] as string | undefined) ?? '';
        const path = (ctx.action.metadata?.['path'] as string | undefined) ?? '';
        if (method.toUpperCase() !== matcher.method.toUpperCase()) continue;
        if (typeof matcher.path_pattern === 'string') {
          if (path === matcher.path_pattern) return required_scope;
        } else if (matcher.path_pattern.test(path)) {
          return required_scope;
        }
      }
    }
    return null;
  }
}
