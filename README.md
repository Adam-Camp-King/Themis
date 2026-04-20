# Bounded

> A policy kernel for bounded-autonomy LLM agents.
> **Status:** pre-alpha. Core types shipping. No public release yet.

Bounded is a small, framework-agnostic policy engine that decides what an LLM agent can do against a production system. It formalizes four primitives — **locks**, **drafts**, **scopes**, **audit** — and composes them into a single evaluation that returns `allow`, `deny`, `redirect`, or `require_approval`.

This is the reference TypeScript implementation. Conforms to [Bounded RFC v0](./spec/RFC-bounded-v0.md) (spec lives upstream in the design notes for now).

## Why

Training-time alignment (RLHF, Constitutional AI) produces a model that *probably* won't do the wrong thing. Bounded is the run-time counterpart — the layer that makes the wrong thing *structurally impossible* in a production deployment.

The four primitives are reinvented, inconsistently, in every agent framework and absent in most. Bounded is the smallest useful thing that formalizes them.

## Packages

| Package | Status |
|---------|--------|
| [`@bounded/core`](./packages/core) | 🧱 types + guards shipping, policies in progress |

Adapter packages (`@bounded/fastapi`, `@bounded/mcp`, `@bounded/langchain`, `@bounded/openai`, `@bounded/anthropic`, and storage adapters) will land as separate packages in this monorepo.

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

Bounded is deliberately permissive — free to adopt, fork, or embed. The enforcement model follows the industry pattern used by MongoDB, Elastic, and Sentry: **give away the ability to start; the architecture, not the license, controls the ability to scale.** Running Bounded locally, in a framework, or in a small service is friction-free. Running multi-tenant at scale with audit retention, approval workflows, and policy-denial corpora for alignment research is where Solid#'s proprietary platform becomes the natural home. License-as-strategy, not license-as-surveillance.

## Acknowledgements

Bounded was extracted from Solid# (a multi-tenant AI business infrastructure platform) after ~12 months of production operation of the four primitives. See the extraction notes at [`../Solid/bounded-extraction-notes/`](https://github.com/) (private) for the source audits.
