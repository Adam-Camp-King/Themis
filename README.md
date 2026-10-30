# Themis

[![ci](https://github.com/Adam-Camp-King/Themis/actions/workflows/ci.yml/badge.svg)](https://github.com/Adam-Camp-King/Themis/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/themis-policy)](https://www.npmjs.com/package/themis-policy) [![PyPI](https://img.shields.io/pypi/v/themis-policy)](https://pypi.org/project/themis-policy/)

> A policy kernel for bounded-autonomy LLM agents.
> **Status:** 0.2.1 on npm and PyPI. RFC v0.2 adds the agent firewall; the RFC v0.3 draft adds action intent.

Themis is a small, framework-agnostic policy engine that decides what an LLM agent can do against a production system. It formalizes four primitives — **locks**, **drafts**, **scopes**, **audit** — and composes them into a single evaluation that returns `allow`, `deny`, `redirect`, or `require_approval`.

**0.2 adds the agent firewall** — chess, not a cage: a revocable **agent identity** (who acted, not just which token), **quarantine** (a hard stop an owner lifts), **rate limits scaled by reputation** (an agent that misbehaves gets less of everything; a stolen key cannot exfiltrate at full speed), and **anomaly detection** with hard heuristics that fire from day one and a statistical baseline that switches itself on once there is enough history. See [`docs/agent-firewall.md`](./docs/agent-firewall.md) and [`examples/agent-firewall`](./examples/agent-firewall) — an Anthropic-style agent running under the firewall in about fifty lines.

This is the reference TypeScript implementation. Conforms to Themis RFC v0 / v0.2 (the RFC lives upstream in the design notes for now; the [conformance vectors](spec/conformance) are the executable spec).


**Intent (RFC v0.3 draft).** Every action can state why it is happening: a one-line `summary` in the agent's words, where the goal came from, the request and tool call it traces to. The engine copies it, detached, into the audit event of every evaluation, so the record pairs what an agent *said* it was doing with what it was *allowed* to do. `DefaultIntentPolicy` makes stating one mandatory for agents. See [Intent](#intent).

**Verb contracts (RFC v0.3 draft).** Policies used to guess what an action does from its name. A verb contract declares it: whether it writes, whether it can be undone, whether it moves money, reaches someone outside the business, changes access or deletes data. Verb IDs are namespaced by their owner (`com.solidnumber:payment_link.send`, `acme:refund.issue`, `mcp:github/create_issue`, `skill:pdf-fill`), so anyone's verbs, any MCP server's tools and any skill are governed by the same engine. Every audit event carries a snapshot of the contract next to the agent's stated intent: an *intent record*. See [`spec/verb-contract.md`](./spec/verb-contract.md).

**Runs anywhere JavaScript does.** The core has no `node:` imports and no `Buffer`: Node 20+, Deno, Bun, Cloudflare Workers and the browser.

## Implementations and conformance

| Implementation | Language | Package | Status |
|---|---|---|---|
| `themis-policy` + adapters | TypeScript | `packages/*` | reference |
| `themis-policy` | Python 3.11+ | `python/` | reference |

Both run the same [conformance vectors](spec/conformance) in CI. Themis is the
vectors and the RFC; an implementation conforms when it passes them (RFC § 11).

## Why

Training-time alignment (RLHF, Constitutional AI) produces a model that *probably* won't do the wrong thing. Themis is the run-time counterpart — the layer that makes the wrong thing *structurally impossible* in a production deployment.

The four primitives are reinvented, inconsistently, in every agent framework and absent in most. Themis is the smallest useful thing that formalizes them.

## Packages

| Package | What |
|---------|------|
| [`themis-policy`](./packages/core) | engine, the seven default policies (intent, quarantine, rate_limit, anomaly + scoring, scope, lock, draft), sinks, in-memory stores |
| [`themis-policy-anthropic`](./packages/anthropic) | gate Claude `tool_use` blocks |
| [`themis-policy-openai`](./packages/openai) | gate OpenAI tool calls |
| [`themis-policy-langchain`](./packages/langchain) | gate LangChain tools |
| [`themis-policy-mcp`](./packages/mcp) | gate MCP tool handlers |
| [`themis-policy-dsl`](./packages/policy-dsl) | YAML → policy bundle |
| [`themis-policy-cli`](./packages/cli) | the `themis` command: lint verb contracts, convert MCP tools, report on intent records |
| [`themis-policy` (PyPI)](./python) | the Python reference implementation, same vectors |

Every adapter takes a `policyMetadataFrom` hook so the firewall policies receive their per-call inputs (limiter result, reputation, risk score) from your stores.

## Intent

```ts
engine.addPolicy(new DefaultIntentPolicy());            // register first: agents must say why

await engine.evaluate({
  requestor: { id: 100, kind: 'agent', tenant_id: 7, scopes: ['*'] },
  action: {
    verb: 'invoice.send', resource_type: 'invoice', tenant_id: 7,
    intent: { summary: 'Send the March invoice the owner asked for', source: 'user_request', request_ref: 'msg_31' },
  },
  now: Date.now(), correlation_id: 'req-123',
});
// audit event → { …, decision: { kind: 'allow' }, intent: { summary: 'Send the March invoice…', … } }
```

An agent that states nothing is denied with `intent_missing`. Your adapter's `actionFrom` supplies the intent; to have the model state it, add a required `intent` field to each tool's input schema and map it to `summary`. Intent is declared, not verified. Its value is the pairing: an approved `team.update_role` whose stated purpose was "send an invoice" is exactly what an auditor, or an anomaly model, should look at. Persisting events to Postgres? Store `decision`, `intent` and `metadata` as `jsonb` and index `intent` with GIN.

## Development

```bash
# install
npm install

# typecheck all packages
npm run typecheck

# run all tests
npm test

# build all packages (emit dist/)
npm run build
```

Node 20+ required. Tests run via [`tsx`](https://tsx.is) against TypeScript source — no build step needed for dev.

## License

[Apache License 2.0](./LICENSE). See [`NOTICE`](./NOTICE) for attribution.

Themis is deliberately permissive — free to adopt, fork, or embed. The enforcement model follows the industry pattern used by MongoDB, Elastic, and Sentry: **give away the ability to start; the architecture, not the license, controls the ability to scale.** Running Themis locally, in a framework, or in a small service is friction-free. Running multi-tenant at scale with audit retention, approval workflows, and policy-denial corpora for alignment research is where Solid#'s proprietary platform becomes the natural home. License-as-strategy, not license-as-surveillance.

## Acknowledgements

Themis was extracted from [Solid#](https://solidnumber.com) — a multi-tenant AI business infrastructure platform — after ~12 months of production operation of the four primitives. Solid# is the reference deployment. Extraction audit notes live in a private repo.

## Maintenance posture

Themis is in **maintenance mode with a stable spec**: RFC v0 and the
conformance vectors are the contract, both implementations stay green in CI,
dependency bumps land monthly, and releases are cut when there is a reason.
Bug reports and spec questions are welcome as issues. Pull requests that change
behaviour need a conformance vector first, so the other implementation moves
with them. Security reports: see [SECURITY.md](SECURITY.md).
