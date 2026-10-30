# themis-policy

Policy kernel for bounded-autonomy LLM agents. One engine, pluggable policies, four decisions, one audit event per evaluation, zero runtime dependencies.

> Status: 0.2.1 on npm. Ships the engine, eight default policies, verb registries, sinks and guards. Conforms to Themis RFC v0.2 and the RFC v0.3 draft (action intent) through the shared [`spec/conformance`](../../spec/conformance) vectors, which the Python implementation also passes. Runs on Node 20+, Deno, Bun, Cloudflare Workers and in the browser: no `node:` imports.

## Install

```bash
npm install themis-policy
```

## Use

```ts
import {
  PolicyEngine, ConsoleSink,
  DefaultIntentPolicy, DefaultQuarantinePolicy, DefaultScopePolicy, DefaultLockPolicy, DefaultDraftPolicy,
  isDeny,
} from 'themis-policy';

const engine = new PolicyEngine({ auditSink: new ConsoleSink() });
engine.addPolicy(new DefaultIntentPolicy());     // agents must say why
engine.addPolicy(new DefaultQuarantinePolicy());
engine.addPolicy(new DefaultScopePolicy());
engine.addPolicy(new DefaultLockPolicy());
engine.addPolicy(new DefaultDraftPolicy());

const decision = await engine.evaluate({
  requestor: { id: 100, kind: 'agent', tenant_id: 7, scopes: ['invoices:write'] },
  action: {
    verb: 'invoice.send', resource_type: 'invoice', tenant_id: 7, required_scope: 'invoices:write',
    intent: { summary: 'Send the March invoice the owner asked for', source: 'user_request', request_ref: 'msg_31' },
  },
  now: Date.now(),
  correlation_id: 'req-123',
});

if (isDeny(decision)) console.log(decision.reason);
```

`evaluate` returns `allow`, `deny`, `redirect` (to a draft) or `require_approval`, and the sink receives exactly one `IAuditEvent` with the decision, the policy chain, and a detached copy of the action's intent.

## Evaluation rules (RFC § 6)

0. Tenancy gate: requestor and action tenants differ → deny before any policy runs.
1. Policies run in registration order.
2. `deny` and `require_approval` short-circuit.
3. `redirect` does not; a later deny wins, otherwise the last redirect wins.
4. All allow → allow.
5. One audit event per evaluation. A failing sink never fails the evaluation.

## Default policies

| Policy | Decides | Reads |
|---|---|---|
| `DefaultIntentPolicy` | deny `intent_missing` when an agent (or other configured kind) states no `action.intent.summary` | `action.intent` |
| `DefaultVerbContractPolicy` | deny `unknown_verb` / `contract_mismatch`; `require_approval` for consent, irreversible, money, access, deletion, export and declared writes | `ctx.verb_contract` (resolve it with a verb registry), `policy_metadata.verb_contract` |
| `DefaultQuarantinePolicy` | deny `agent_quarantined` | `requestor.metadata.quarantined`, `policy_metadata.quarantine` |
| `DefaultRateLimitPolicy` | deny `rate_limited`; limits scale with reputation | `policy_metadata.rate_limit` |
| `DefaultAnomalyPolicy` | `require_approval` above 0.8 risk, deny above 0.95 | `policy_metadata.anomaly` (from `scoreAction`) |
| `DefaultScopePolicy` | deny `missing_scope` | `requestor.scopes`, `action.required_scope` or rules |
| `DefaultLockPolicy` | deny `agency_lock` | `entity.locks`, `action.area` |
| `DefaultDraftPolicy` | `redirect` writes on published entities to a draft | `entity.is_published`, `payload.publish` |

The firewall policies are pure: they read only `policy_metadata[policy.name]`. Your stores compute the limiter result, reputation and risk score and pass them in. `MemoryRateLimiter`, `MemoryReputationStore` and `scoreAction` ship for development.

## Intent

`action.intent` records why the requestor says it is acting: `summary`, `source` (`user_request`, `agent_plan`, `schedule`, `system`, or your own), `request_ref`, `tool_call_id` and free-form `attributes`. It is declared, not verified. The engine records only those five fields: the four string fields when they are strings, and `attributes` when it is a JSON object (anything else — NaN, a Date, a class instance, more than 32 levels deep — drops the whole `attributes` field). The engine copies it, detached, into every audit event whatever the decision, so the audit trail pairs what an agent said it was doing with what it was allowed to do. The Anthropic and OpenAI adapters stamp the model's tool-call id onto a stated intent automatically.

## Verb contracts

What a verb does is declared in a contract, not guessed from its name. IDs are `<namespace>:<name>`, owned by whoever owns the verb. Resolve contracts with a registry and pass `verbRegistry` to any adapter:

```ts
import { ChainVerbRegistry, StaticVerbRegistry, contractFromMcpTool, DefaultVerbContractPolicy } from 'themis-policy';

const verbs = new ChainVerbRegistry([
  new StaticVerbRegistry(myCuratedContracts, { defaultNamespace: 'com.example' }),     // your facts first
  new StaticVerbRegistry(githubTools.map((t) => contractFromMcpTool('github', t))),    // a server's own claims
]);
engine.addPolicy(new DefaultVerbContractPolicy());
```

Every audit event then carries a contract snapshot beside the stated intent. Spec: [`spec/verb-contract.md`](../../spec/verb-contract.md).

## Tests

```bash
npm --workspace themis-policy test
```

## License

Apache License 2.0. See [`LICENSE`](../../LICENSE) and [`NOTICE`](../../NOTICE).
