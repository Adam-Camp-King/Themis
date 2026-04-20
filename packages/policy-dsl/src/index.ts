/**
 * @bounded/policy-dsl — YAML → @bounded/core PolicyEngine compiler.
 *
 * Grammar lives in `spec/policy-dsl.md`. The DSL covers the 80% common
 * case (scopes / locks / drafts / approvals). Custom code policies are
 * registered alongside the DSL-compiled ones.
 *
 * Usage:
 *   import { compilePolicyYaml } from '@bounded/policy-dsl';
 *
 *   const bundle = compilePolicyYaml(fs.readFileSync('policies.yaml', 'utf8'));
 *   // bundle.engine is a PolicyEngine with scope/lock/draft + approval policies
 *   // bundle.lock_defaults is for your ILockStore to apply on entity creation
 */

import type {
  IAuditSink,
  IPolicy,
  IPolicyContext,
  IPolicyDecision,
} from '@bounded/core';
import {
  DefaultDraftPolicy,
  DefaultLockPolicy,
  DefaultScopePolicy,
  PolicyEngine,
} from '@bounded/core';
import { parse as parseYaml } from 'yaml';

// ============================================================================
// Public types
// ============================================================================

export interface CompiledPolicyBundle {
  readonly engine: PolicyEngine;
  readonly lock_defaults: Readonly<Record<string, boolean>>;
  readonly declared_areas: readonly string[];
  readonly declared_scopes: readonly string[];
}

export interface CompileOptions {
  readonly auditSink?: IAuditSink | null;
}

export class PolicyDslError extends Error {
  constructor(message: string) {
    super(`[bounded-dsl] ${message}`);
    this.name = 'PolicyDslError';
  }
}

// ============================================================================
// Parser — YAML string → ValidatedDSL
// ============================================================================

interface RawScopeRule {
  method?: unknown;
  path?: unknown;
  verb?: unknown;
  resource_type?: unknown;
  require?: unknown;
}

interface RawLocksBlock {
  declare_areas?: unknown;
  defaults?: unknown;
}

interface RawDraftRule {
  verb?: unknown;
  resource_type?: unknown;
  force_review?: unknown;
}

interface RawApprovalRule {
  verb?: unknown;
  resource_type?: unknown;
  min_amount?: unknown;
  amount_field?: unknown;
  message?: unknown;
}

interface RawDocument {
  bounded_version?: unknown;
  scopes?: unknown;
  locks?: unknown;
  drafts?: unknown;
  approvals?: unknown;
}

interface ValidatedScopeRule {
  matcher:
    | { kind: 'path_method'; method: string; path: string | RegExp }
    | { kind: 'verb'; verb: string; resource_type: string };
  required_scope: string;
}

interface ValidatedLocks {
  declared_areas: readonly string[];
  defaults: Readonly<Record<string, boolean>>;
}

interface ValidatedDraftRule {
  verb: string;
  resource_type: string;
  force_review: boolean;
}

interface ValidatedApprovalRule {
  verb: string;
  resource_type: string;
  min_amount: number | null;
  amount_field: string | null;
  message: string | null;
}

interface ValidatedDSL {
  scopes: readonly ValidatedScopeRule[];
  locks: ValidatedLocks;
  drafts: readonly ValidatedDraftRule[];
  approvals: readonly ValidatedApprovalRule[];
}

function parse(source: string): ValidatedDSL {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (err) {
    throw new PolicyDslError(`invalid YAML: ${formatError(err)}`);
  }
  if (!isObject(doc)) {
    throw new PolicyDslError('document must be a YAML mapping');
  }
  const raw = doc as RawDocument;

  if (raw.bounded_version !== '0' && raw.bounded_version !== 0) {
    throw new PolicyDslError(
      `bounded_version must be "0" (got ${JSON.stringify(raw.bounded_version)})`,
    );
  }

  return {
    scopes: parseScopes(raw.scopes),
    locks: parseLocks(raw.locks),
    drafts: parseDrafts(raw.drafts),
    approvals: parseApprovals(raw.approvals),
  };
}

function parseScopes(raw: unknown): readonly ValidatedScopeRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new PolicyDslError('scopes must be a list');
  return raw.map((entry, idx): ValidatedScopeRule => {
    if (!isObject(entry)) {
      throw new PolicyDslError(`scopes[${idx}]: must be a mapping`);
    }
    const r = entry as RawScopeRule;
    if (typeof r.require !== 'string' || r.require.length === 0) {
      throw new PolicyDslError(`scopes[${idx}]: 'require' must be a non-empty string`);
    }
    const required_scope = r.require;
    if (typeof r.method === 'string' && r.path !== undefined) {
      return {
        matcher: {
          kind: 'path_method',
          method: r.method,
          path: isRegExp(r.path)
            ? (r.path as RegExp)
            : typeof r.path === 'string'
              ? r.path
              : (() => {
                  throw new PolicyDslError(`scopes[${idx}]: 'path' must be a string or RegExp`);
                })(),
        },
        required_scope,
      };
    }
    if (typeof r.verb === 'string' && typeof r.resource_type === 'string') {
      return {
        matcher: { kind: 'verb', verb: r.verb, resource_type: r.resource_type },
        required_scope,
      };
    }
    throw new PolicyDslError(
      `scopes[${idx}]: must specify either {method, path} or {verb, resource_type}`,
    );
  });
}

function parseLocks(raw: unknown): ValidatedLocks {
  if (raw === undefined || raw === null) {
    return { declared_areas: [], defaults: {} };
  }
  if (!isObject(raw)) throw new PolicyDslError("'locks' must be a mapping");
  const r = raw as RawLocksBlock;

  let declared_areas: readonly string[] = [];
  if (r.declare_areas !== undefined) {
    if (!Array.isArray(r.declare_areas)) {
      throw new PolicyDslError("'locks.declare_areas' must be a list of strings");
    }
    declared_areas = r.declare_areas.map((a, i) => {
      if (typeof a !== 'string' || a.length === 0) {
        throw new PolicyDslError(`locks.declare_areas[${i}]: must be a non-empty string`);
      }
      return a;
    });
  }

  const defaults: Record<string, boolean> = {};
  if (r.defaults !== undefined) {
    if (!Array.isArray(r.defaults)) {
      throw new PolicyDslError("'locks.defaults' must be a list");
    }
    for (const [i, entry] of r.defaults.entries()) {
      if (!isObject(entry)) {
        throw new PolicyDslError(`locks.defaults[${i}]: must be a mapping`);
      }
      const e = entry as { area?: unknown; locked_by_default?: unknown };
      if (typeof e.area !== 'string') {
        throw new PolicyDslError(`locks.defaults[${i}]: 'area' must be a string`);
      }
      if (typeof e.locked_by_default !== 'boolean') {
        throw new PolicyDslError(
          `locks.defaults[${i}]: 'locked_by_default' must be a boolean`,
        );
      }
      if (declared_areas.length > 0 && !declared_areas.includes(e.area)) {
        throw new PolicyDslError(
          `locks.defaults[${i}]: area '${e.area}' is not in declare_areas`,
        );
      }
      defaults[e.area] = e.locked_by_default;
    }
  }

  return { declared_areas, defaults };
}

function parseDrafts(raw: unknown): readonly ValidatedDraftRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new PolicyDslError("'drafts' must be a list");
  return raw.map((entry, idx): ValidatedDraftRule => {
    if (!isObject(entry)) {
      throw new PolicyDslError(`drafts[${idx}]: must be a mapping`);
    }
    const r = entry as RawDraftRule;
    if (typeof r.verb !== 'string' || typeof r.resource_type !== 'string') {
      throw new PolicyDslError(
        `drafts[${idx}]: 'verb' and 'resource_type' must be strings`,
      );
    }
    return {
      verb: r.verb,
      resource_type: r.resource_type,
      force_review:
        r.force_review === undefined
          ? false
          : typeof r.force_review === 'boolean'
            ? r.force_review
            : (() => {
                throw new PolicyDslError(
                  `drafts[${idx}]: 'force_review' must be a boolean`,
                );
              })(),
    };
  });
}

function parseApprovals(raw: unknown): readonly ValidatedApprovalRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new PolicyDslError("'approvals' must be a list");
  const entries = raw.map((entry, idx): ValidatedApprovalRule => {
    if (!isObject(entry)) {
      throw new PolicyDslError(`approvals[${idx}]: must be a mapping`);
    }
    const r = entry as RawApprovalRule;
    if (typeof r.verb !== 'string' || typeof r.resource_type !== 'string') {
      throw new PolicyDslError(
        `approvals[${idx}]: 'verb' and 'resource_type' must be strings`,
      );
    }
    let min_amount: number | null = null;
    if (r.min_amount !== undefined) {
      if (typeof r.min_amount !== 'number' || !Number.isFinite(r.min_amount)) {
        throw new PolicyDslError(
          `approvals[${idx}]: 'min_amount' must be a finite number`,
        );
      }
      min_amount = r.min_amount;
    }
    const amount_field =
      r.amount_field === undefined
        ? null
        : typeof r.amount_field === 'string'
          ? r.amount_field
          : (() => {
              throw new PolicyDslError(
                `approvals[${idx}]: 'amount_field' must be a string`,
              );
            })();
    const message =
      r.message === undefined
        ? null
        : typeof r.message === 'string'
          ? r.message
          : (() => {
              throw new PolicyDslError(
                `approvals[${idx}]: 'message' must be a string`,
              );
            })();
    if (min_amount !== null && !amount_field) {
      throw new PolicyDslError(
        `approvals[${idx}]: 'amount_field' is required when 'min_amount' is set`,
      );
    }
    return { verb: r.verb, resource_type: r.resource_type, min_amount, amount_field, message };
  });
  // Merge rule per spec §open-questions #2: when two entries target the same
  // verb+resource_type, take MIN min_amount (deny-safer).
  const merged = new Map<string, ValidatedApprovalRule>();
  for (const e of entries) {
    const key = `${e.verb}::${e.resource_type}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, e);
      continue;
    }
    const minThresh =
      prev.min_amount === null
        ? null
        : e.min_amount === null
          ? null
          : Math.min(prev.min_amount, e.min_amount);
    merged.set(key, {
      ...prev,
      min_amount: minThresh,
      amount_field: prev.amount_field ?? e.amount_field,
      message: prev.message ?? e.message,
    });
  }
  return Array.from(merged.values());
}

// ============================================================================
// Compile — ValidatedDSL → CompiledPolicyBundle
// ============================================================================

export function compilePolicyYaml(
  source: string,
  opts: CompileOptions = {},
): CompiledPolicyBundle {
  const dsl = parse(source);

  const engine = new PolicyEngine({ auditSink: opts.auditSink ?? null });

  // 1. Scope
  if (dsl.scopes.length > 0) {
    const scope = new DefaultScopePolicy();
    for (const rule of dsl.scopes) {
      if (rule.matcher.kind === 'path_method') {
        scope.addRule(
          { method: rule.matcher.method, path_pattern: rule.matcher.path },
          rule.required_scope,
        );
      } else {
        const { verb, resource_type } = rule.matcher;
        scope.addRule(
          (ctx) =>
            ctx.action.verb === verb && ctx.action.resource_type === resource_type,
          rule.required_scope,
        );
      }
    }
    engine.addPolicy(scope);
  }

  // 2. Lock
  engine.addPolicy(new DefaultLockPolicy());

  // 3. Draft — the base policy, plus force_review wrapping if any rule demands it
  const forcedPairs = new Set(
    dsl.drafts.filter((d) => d.force_review).map((d) => `${d.verb}::${d.resource_type}`),
  );
  if (forcedPairs.size > 0) {
    engine.addPolicy(buildForceReviewPolicy(forcedPairs));
  }
  engine.addPolicy(new DefaultDraftPolicy());

  // 4. Approvals
  for (const a of dsl.approvals) {
    engine.addPolicy(buildApprovalPolicy(a));
  }

  const declared_scopes = Array.from(
    new Set(dsl.scopes.map((s) => s.required_scope)),
  );

  return {
    engine,
    lock_defaults: dsl.locks.defaults,
    declared_areas: dsl.locks.declared_areas,
    declared_scopes,
  };
}

// ----------------------------------------------------------------------------
// Inline policies compiled from DSL
// ----------------------------------------------------------------------------

function buildForceReviewPolicy(pairs: ReadonlySet<string>): IPolicy {
  return {
    name: 'force_review',
    async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
      const key = `${ctx.action.verb}::${ctx.action.resource_type}`;
      if (!pairs.has(key)) {
        return { kind: 'allow', policy: 'force_review' };
      }
      // Force a redirect even on create / unpublished entities
      return {
        kind: 'redirect',
        policy: 'force_review',
        target: 'draft',
        payload: ctx.action.payload ?? null,
      };
    },
  };
}

function buildApprovalPolicy(rule: ValidatedApprovalRule): IPolicy {
  return {
    name: `approval:${rule.verb}:${rule.resource_type}`,
    async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
      if (
        ctx.action.verb !== rule.verb ||
        ctx.action.resource_type !== rule.resource_type
      ) {
        return { kind: 'allow', policy: `approval:${rule.verb}:${rule.resource_type}` };
      }
      if (rule.min_amount !== null && rule.amount_field !== null) {
        const payload = ctx.action.payload as Record<string, unknown> | undefined;
        const amount = payload?.[rule.amount_field];
        if (typeof amount !== 'number' || amount <= rule.min_amount) {
          return { kind: 'allow', policy: `approval:${rule.verb}:${rule.resource_type}` };
        }
      }
      return {
        kind: 'require_approval',
        policy: `approval:${rule.verb}:${rule.resource_type}`,
        approval_ref: `approval-${ctx.correlation_id}`,
        message: rule.message ?? undefined,
      };
    },
  };
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isRegExp(v: unknown): v is RegExp {
  return Object.prototype.toString.call(v) === '[object RegExp]';
}
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
