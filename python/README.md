# themis-policy

Python reference implementation of **Themis RFC v0** — a policy kernel for
LLM agents that act on production systems. Four primitives — **locks**,
**drafts**, **scopes**, **audit** — composed by one engine into a single
decision per attempted action: `allow`, `deny`, `redirect`, or
`require_approval`.

Byte-compatible with [`themis-policy`](https://github.com/Adam-Camp-King/Themis)
(TypeScript): both pass the same [conformance vectors](../spec/conformance).

```python
from themis import (
    PolicyEngine, DefaultLockPolicy, DefaultScopePolicy, DefaultDraftPolicy,
    Requestor, Action, PolicyContext, ConsoleSink, is_deny,
)

engine = PolicyEngine(audit_sink=ConsoleSink())
engine.add_policy(DefaultLockPolicy())
engine.add_policy(DefaultScopePolicy())
engine.add_policy(DefaultDraftPolicy())

decision = engine.evaluate(PolicyContext(
    requestor=Requestor(id="key_1", kind="api_key", tenant_id=7, scopes=("pages:read",)),
    action=Action(verb="pages.update", resource_type="page", tenant_id=7, resource_id=42,
                  required_scope="pages:write"),
    now=0, correlation_id="req-123",
))
if is_deny(decision):
    print(decision.reason)          # missing_scope
```

The engine is synchronous (every core policy is pure CPU); `evaluate_async`
exists for callers already inside an event loop. Stores (`LockStore`,
`DraftStore`) are ports you implement against your persistence; audit sinks
receive one event per evaluation and may never fail an evaluation.

Install: `pip install themis-policy` (Python 3.11+, no dependencies).
Tests: `pip install -e '.[test]' && pytest`.

Apache-2.0 — see the repository LICENSE.
