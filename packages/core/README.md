# @bounded/core

Policy kernel for bounded-autonomy LLM agents. Twelve interfaces, four decision variants, zero runtime dependencies.

> Status: pre-alpha. Types + guards shipping. Policies (lock, draft, scope, engine) in progress.

## Install

```bash
npm install @bounded/core
```

## Use (once engine lands)

```ts
import type { IPolicyContext, IPolicyDecision } from '@bounded/core';
import { isDeny, isRedirect } from '@bounded/core';

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
npm --workspace @bounded/core test
```

## License

MIT
