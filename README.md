# Themis

[![ci](https://github.com/Adam-Camp-King/Themis/actions/workflows/ci.yml/badge.svg)](https://github.com/Adam-Camp-King/Themis/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/themis-policy)](https://www.npmjs.com/package/themis-policy) [![PyPI](https://img.shields.io/pypi/v/themis-policy)](https://pypi.org/project/themis-policy/)

> A policy kernel for bounded-autonomy LLM agents.
> **Status:** 0.2.0 on npm and PyPI. RFC v0.2 (draft) adds the agent firewall.

Themis is a small, framework-agnostic policy engine that decides what an LLM agent can do against a production system. It formalizes four primitives — **locks**, **drafts**, **scopes**, **audit** — and composes them into a single evaluation that returns `allow`, `deny`, `redirect`, or `require_approval`.

**0.2 adds the agent firewall** — chess, not a cage: a revocable **agent identity** (who acted, not just which token), **quarantine** (a hard stop an owner lifts), **rate limits scaled by reputation** (an agent that misbehaves gets less of everything; a stolen key cannot exfiltrate at full speed), and **anomaly detection** with hard heuristics that fire from day one and a statistical baseline that switches itself on once there is enough history. See [`docs/agent-firewall.md`](./docs/agent-firewall.md) and [`examples/agent-firewall`](./examples/agent-firewall) — an Anthropic-style agent running under the firewall in about fifty lines.

This is the reference TypeScript implementation. Conforms to Themis RFC v0 / v0.2 (the RFC lives upstream in the design notes for now; the [conformance vectors](spec/conformance) are the executable spec).


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
| [`themis-policy`](./packages/core) | engine, the seven default policies (lock, draft, scope, quarantine, rate_limit, anomaly + scoring), sinks, in-memory stores |
| [`themis-policy-anthropic`](./packages/anthropic) | gate Claude `tool_use` blocks |
| [`themis-policy-openai`](./packages/openai) | gate OpenAI tool calls |
| [`themis-policy-langchain`](./packages/langchain) | gate LangChain tools |
| [`themis-policy-mcp`](./packages/mcp) | gate MCP tool handlers |
| [`themis-policy-dsl`](./packages/policy-dsl) | YAML → policy bundle |
| [`themis-policy` (PyPI)](./python) | the Python reference implementation, same vectors |

Every adapter takes a `policyMetadataFrom` hook so the firewall policies receive their per-call inputs (limiter result, reputation, risk score) from your stores.

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
