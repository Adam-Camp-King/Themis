/**
 * Type guards for IPolicyDecision. Narrow a decision to its specific variant.
 *
 * These are used on the hot path by adapter packages (e.g., @bounded/fastapi
 * wrapping a route handler) to branch on the decision kind without resorting
 * to exhaustive switch statements or manual discriminator checks.
 */

import type {
  IAllowDecision,
  IDenyDecision,
  IPolicyDecision,
  IRedirectDecision,
  IRequireApprovalDecision,
} from './types.js';

export function isAllow(d: IPolicyDecision): d is IAllowDecision {
  return d.kind === 'allow';
}

export function isDeny(d: IPolicyDecision): d is IDenyDecision {
  return d.kind === 'deny';
}

export function isRedirect(d: IPolicyDecision): d is IRedirectDecision {
  return d.kind === 'redirect';
}

export function isRequireApproval(d: IPolicyDecision): d is IRequireApprovalDecision {
  return d.kind === 'require_approval';
}
