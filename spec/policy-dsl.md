# Bounded Policy DSL — v0 Design

> Status: draft v0
> Date: 2026-04-19
> Part of: Bounded RFC v0
> Implements sprint task #9; implemented by task #13 (`@bounded/policy-dsl` parser)

## Problem

Code-defined policies (hand-written TypeScript `IPolicy` implementations) are flexible but verbose. The common case — "route X requires scope Y; these areas are locked by default; these verbs always draft; these verbs always require approval" — should be declarative.

The Policy DSL is a YAML syntax that compiles to a registered set of `IPolicy` instances ready to add to a `PolicyEngine`. It is **not** a replacement for code policies; it's a shorthand for the 80% common configuration. Custom logic (like finance-ops' `ThresholdApprovalPolicy`) stays in code.

## Design goals

1. **Declarative and flat.** One YAML file per service. No includes, no inheritance.
2. **Round-trippable.** DSL → compiled policies → evaluate() produces the SAME decisions as hand-coded equivalents.
3. **Minimum surface.** Only covers the three core policies (Lock, Scope, Draft) plus a small set of conveniences (`require_approval: true` on verbs). Custom policies are registered in code, not DSL.
4. **Auditable.** A human reading the YAML can tell every denial the system can produce.
5. **Stable.** Grammar changes between versions are additive; v0 files remain valid in v1.

## Top-level shape

```yaml
bounded_version: "0"      # REQUIRED. Matches RFC version.

scopes:                   # list of scope declarations (optional)
  - ...

locks:                    # default lock configuration for resource types (optional)
  - ...

drafts:                   # which verb+resource_type combos redirect to drafts (optional)
  - ...

approvals:                # which verb+resource_type combos require approval (optional)
  - ...
```

The four blocks are independent. Any subset may be omitted.

---

## `scopes:` block

Each entry declares either an explicit required-scope-per-route or a verb-level scope mapping. Compiled into `DefaultScopePolicy.addRule()` calls.

```yaml
scopes:
  # path + method form
  - method: POST
    path: /api/v1/cms/pages
    require: pages:write

  # regex path form
  - method: DELETE
    path: !regex ^/api/v1/cms/pages/\d+$
    require: pages:write

  # verb-level form (matches any action with this verb + resource_type)
  - verb: invoke
    resource_type: wire_transfer
    require: payments:write
```

**Grammar:**

```
scope_rule = { method: str, path: str | !regex regex, require: scope }
           | { verb: str, resource_type: str, require: scope }
```

- `scope`: any non-empty string. Not validated against a list. Treat as opaque.
- `!regex` is a YAML custom tag; the parser converts the string to a `RegExp`.

**Compilation:**

```ts
scope = new DefaultScopePolicy();
for (rule of doc.scopes) {
  if (rule.method) {
    scope.addRule(
      { method: rule.method, path_pattern: rule.path },
      rule.require,
    );
  } else {
    scope.addRule(
      (ctx) =>
        ctx.action.verb === rule.verb &&
        ctx.action.resource_type === rule.resource_type,
      rule.require,
    );
  }
}
```

---

## `locks:` block

Declares lock areas and their defaults. Compiles to a seeded `DefaultLockPolicy` plus an initial `ILockStore` state for entities the DSL author can enumerate.

```yaml
locks:
  # declare known lock areas for this service
  declare_areas:
    - pages
    - brand
    - domains
    - modules
    - design
    - billing

  # default lock state applied when an ILockableEntity is provisioned
  # (store implementations consume this during factory calls)
  defaults:
    - area: pages
      locked_by_default: true
    - area: brand
      locked_by_default: true
```

**Grammar:**

```
locks = { declare_areas: [str], defaults: [{ area: str, locked_by_default: bool }] }
```

Bounded's core does not persist these defaults — they're metadata for an implementing `ILockStore` to apply at entity creation time. The DSL parser exposes them via `compiled.locks.defaults` for a storage adapter to consume.

**Compilation:**

```ts
lock = new DefaultLockPolicy();
// areas + defaults are attached to the compiled bundle for the caller
// to consume when provisioning entities. The core policy is otherwise
// unchanged (its decision rule is fixed per RFC §5.1).
```

---

## `drafts:` block

Marks verb+resource_type combinations that should redirect to drafts by default. This is a **router-level** declaration — the draft policy already exists in core with a fixed rule (`is_published && !publish_flag`); the DSL's job is to hint the application layer which verbs belong in the draft queue.

```yaml
drafts:
  - verb: update
    resource_type: page
  - verb: update
    resource_type: site_template
  - verb: publish
    resource_type: page
    force_review: true   # optional — true even if !is_published
```

**Grammar:**

```
drafts = [{ verb: str, resource_type: str, force_review?: bool }]
```

When `force_review: true`, the compiled bundle wraps `DefaultDraftPolicy` with a predicate that forces the draft redirect even on unpublished entities. This is a convenience for "every update goes through review, no matter what."

---

## `approvals:` block

Declares combinations that always fire `require_approval`. Compiles to a small inline policy.

```yaml
approvals:
  - verb: invoke
    resource_type: wire_transfer
    min_amount: 10000      # optional — only approval-gate above this value
    amount_field: amount
    message: "Wire transfer over $10,000 requires CFO approval."
```

**Grammar:**

```
approvals = [{ verb: str, resource_type: str,
               min_amount?: number, amount_field?: str,
               message?: str }]
```

`min_amount` is a payload-value threshold; `amount_field` picks the field on `action.payload` to compare. Without `min_amount`, the policy always requires approval.

**Compilation:** produces a single `ThresholdApprovalPolicy`-equivalent per entry (or a batched policy if multiple entries share the same verb+resource_type — the parser merges).

---

## Full worked example

```yaml
bounded_version: "0"

scopes:
  - method: POST
    path: /api/v1/cms/pages
    require: pages:write
  - verb: invoke
    resource_type: wire_transfer
    require: payments:write

locks:
  declare_areas: [pages, brand, domains]
  defaults:
    - area: pages
      locked_by_default: true

drafts:
  - verb: update
    resource_type: page

approvals:
  - verb: invoke
    resource_type: wire_transfer
    min_amount: 10000
    amount_field: amount
    message: "Wire transfer over $10,000 requires CFO approval."
```

Produces a `PolicyEngine` with 4 policies:

```
[scope, lock, draft, threshold_approval(wire_transfer)]
```

---

## Compilation output

```ts
type CompiledPolicyBundle = {
  engine: PolicyEngine;                    // ready to evaluate
  lock_defaults: Record<string, boolean>;  // for ILockStore to seed
  declared_areas: readonly string[];
  declared_scopes: readonly string[];
};
```

Parser entry point:

```ts
export function compilePolicyYaml(
  source: string,
  opts: { auditSink?: IAuditSink } = {},
): CompiledPolicyBundle;
```

---

## What's explicitly NOT in v0

- **Includes / imports.** One file per service; no merging.
- **Dynamic conditions.** No "if user.email endsWith @corp.com then …". Use a code policy.
- **Wildcard scopes.** `pages:*` is NOT expanded by the DSL. Flat membership only.
- **Time windows.** No "unlock between 9am–5pm". Code policy.
- **Computed thresholds.** `min_amount` is a literal number; no expressions.

These are deliberate omissions to keep the DSL readable and auditable. Any of them can be satisfied by registering a code policy alongside the DSL-compiled ones.

---

## Open questions

1. **Version field values.** `bounded_version: "0"` today — do we promote to `"0.1"` when DSL gets a breaking change, or stay on integer majors? Leaning toward major integers (`"0"`, `"1"`, …).
2. **Merging strategy for approvals.** If two `approvals` entries target the same verb+resource_type but different `min_amount`, do we take the MIN (stricter) or the MAX (looser)? Leaning MIN (deny-safer). Needs a test.
3. **Area enum.** `locks.declare_areas` is just a hint today. Should the parser enforce that every `action.area` referenced elsewhere must be in `declare_areas`? Probably yes for v0.1.
4. **YAML custom tags.** `!regex` is non-standard. Consider falling back to `path_regex: "^/…"` form for portability across YAML parsers.

---

## Implementation plan (sprint task #13)

1. Add `yaml` dependency to `@bounded/policy-dsl` package.
2. Write a parser module: `parse(source) → ValidatedDSL`.
3. Write a compiler module: `compile(validatedDSL, coreOpts) → CompiledPolicyBundle`.
4. Ship round-trip tests: every worked example above gets an end-to-end test that compiles, evaluates canonical scenarios, and asserts the same decisions as hand-coded equivalents.
5. Document usage in `packages/policy-dsl/README.md` with the worked example and the `compilePolicyYaml` signature.
