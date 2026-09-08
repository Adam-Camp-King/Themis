# Themis

[![ci](https://github.com/Adam-Camp-King/Themis/actions/workflows/ci.yml/badge.svg)](https://github.com/Adam-Camp-King/Themis/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/themis-policy)](https://www.npmjs.com/package/themis-policy) [![PyPI](https://img.shields.io/pypi/v/themis-policy)](https://pypi.org/project/themis-policy/)

> A policy kernel for bounded-autonomy LLM agents.
> **Status:** pre-alpha. Core types shipping. No public release yet.

Themis is a small, framework-agnostic policy engine that decides what an LLM agent can do against a production system. It formalizes four primitives — **locks**, **drafts**, **scopes**, **audit** — and composes them into a single evaluation that returns `allow`, `deny`, `redirect`, or `require_approval`.

This is the reference TypeScript implementation. Conforms to [Themis RFC v0](./spec/RFC-bounded-v0.md) (spec lives upstream in the design notes for now).


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

| Package | Status |
|---------|--------|
| [`themis-policy`](./packages/core) | 🧱 types + guards shipping, policies in progress |

Adapter packages (`themis-policy-fastapi`, `themis-policy-mcp`, `themis-policy-langchain`, `themis-policy-openai`, `themis-policy-anthropic`, and storage adapters) will land as separate packages in this monorepo.

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
