# themis-policy

Policy kernel for bounded-autonomy LLM agents. Twelve interfaces, four decision variants, zero runtime dependencies.

> Status: 0.1.0 — engine, the three core policies, sinks and guards ship; conforms to Themis RFC v0 (the `spec/conformance` vectors, shared with the Python implementation `themis-policy`).

## Install

```bash
npm install themis-policy
```

## Use (once engine lands)

```ts
import type { IPolicyContext, IPolicyDecision } from 'themis-policy';
import { isDeny, isRedirect } from 'themis-policy';

// Engine + policies are implemented in upcoming releases. Public types are
// stable under RFC v0.
```

## API surface today

Public exports: the 12 interfaces of RFC v0 and 4 type guards.

```ts
// Cross-cutting
export type { IRequestor, IAction, IPolicyContext, IPolicyDecision, IAuditEvent };
export type { IAllowDecision, IDenyDecision, IRedirectDecision, IRequireApprovalDecision };

// Policies
export type { ILockPolicy, IDraftPolicy, IScopePolicy, IPolicyEngine };
export type { IPolicy, IPolicyConfig, ScopeRuleMatcher };

// Entities
export type { ILockableEntity, IDraftableEntity };

// Stores
export type { ILockStore, IDraftStore, IAuditSink };

// Guards
export { isAllow, isDeny, isRedirect, isRequireApproval };
```

## Tests

```bash
npm --workspace themis-policy test
```

## License

Apache License 2.0. See [`LICENSE`](../../LICENSE) and [`NOTICE`](../../NOTICE).
