# Themis

> A policy kernel for bounded-autonomy LLM agents.
> **Status:** pre-alpha. Core types shipping. No public release yet.

Themis is a small, framework-agnostic policy engine that decides what an LLM agent can do against a production system. It formalizes four primitives — **locks**, **drafts**, **scopes**, **audit** — and composes them into a single evaluation that returns `allow`, `deny`, `redirect`, or `require_approval`.

This is the reference TypeScript implementation. Conforms to [Themis RFC v0](./spec/RFC-bounded-v0.md) (spec lives upstream in the design notes for now).

## Why

Training-time alignment (RLHF, Constitutional AI) produces a model that *probably* won't do the wrong thing. Themis is the run-time counterpart — the layer that makes the wrong thing *structurally impossible* in a production deployment.

The four primitives are reinvented, inconsistently, in every agent framework and absent in most. Themis is the smallest useful thing that formalizes them.

## Packages

| Package | Status |
|---------|--------|
| [`@themis/core`](./packages/core) | 🧱 types + guards shipping, policies in progress |

Adapter packages (`@themis/fastapi`, `@themis/mcp`, `@themis/langchain`, `@themis/openai`, `@themis/anthropic`, and storage adapters) will land as separate packages in this monorepo.

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
