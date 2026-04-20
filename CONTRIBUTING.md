# Contributing to Themis

Thanks for your interest in Themis. This doc is short on purpose — the project is small, the contract is strict, and we'd rather you read the RFC than the rulebook.

## What to read first

Before filing an issue or opening a PR:

1. **[`spec/RFC-bounded-v0.md`](./spec/RFC-bounded-v0.md)** — the policy engine and decision semantics. Normative.
2. **[`spec/policy-dsl.md`](./spec/policy-dsl.md)** — the YAML DSL grammar.
3. **[`docs/bounded-and-claude.md`](./docs/bounded-and-claude.md)** — reference deployment pattern.
4. Each package's `README.md` — public API snapshot.

If your change affects the RFC, say so clearly in the issue.

## Filing issues

Good issues include:

- **What you tried.** Actual code, actual config, actual command.
- **What you expected.** Reference the RFC section or API doc if possible.
- **What happened instead.** Full error, full stack, full tool_result.
- **Repro.** Ideally a failing test case.

Bugs in a specific package should reference the package in the title: `[core]`, `[mcp]`, `[anthropic]`, `[langchain]`, `[openai]`, `[policy-dsl]`.

## Pull requests

### What's in scope

- Bug fixes against documented behavior.
- Tests that cover an existing but untested branch.
- Adapter packages for additional frameworks (open an issue first — we'd like to coordinate).
- Sink implementations (file, HTTP, SQL-flavored).
- Docs fixes, typos, clarifications.

### What's NOT in scope (at least for v0)

- New decision variants beyond `allow | deny | redirect | require_approval`. These are pinned in the RFC. Propose via RFC discussion.
- Hierarchical scope semantics (`*:read`, `pages:*`) in core. Flat membership is deliberate. Ship as a plugin.
- Features that require relaxing a RFC v0 **MUST** clause.
- Non-Apache-licensed code or dependencies. The whole project is Apache-2.0.

### PR checklist

- [ ] Tests pass: `npm test` at the workspace root.
- [ ] Types clean: `npm run typecheck`.
- [ ] Every non-trivial function you add has at least one test in the same PR.
- [ ] New source files carry the SPDX header:
  ```
  // SPDX-License-Identifier: Apache-2.0
  // Copyright 2026 Adam Campbell
  ```
- [ ] If you changed public behavior, the package's README reflects it.
- [ ] Commit message follows Conventional Commits (`feat(core):`, `fix(mcp):`, `docs:`, `test:`, `chore:`).

### Sign-off (DCO)

Every commit must be signed off per the [Developer Certificate of Origin](https://developercertificate.org/). Use `git commit -s` — this appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

By signing off, you certify you have the right to submit the contribution under the project's Apache-2.0 license.

## Dev loop

```bash
# Install (npm workspaces; no pnpm/yarn)
npm install

# Run every test across every package
npm test

# Typecheck every package
npm run typecheck

# Build (emits dist/ in every package)
npm run build
```

Tests run via [`tsx`](https://tsx.is) directly against `.ts` source — no build step needed in the dev loop.

## Release policy

Themis is pre-alpha (`0.0.x`). Expect breaking changes between `0.0.x` versions.

- `0.1.0` is the first public-API-stable release; it goes out once the RFC v0 ships with a public Discussion and at least one non-Solid# adopter validates the shape.
- Semver applies from `1.0.0` onward.

## Scope of this project

Themis packages four primitives: **locks, drafts, scopes, audit**. The scope is deliberately narrow. Proposals to extend into adjacent territory (approval workflow state machines, observability dashboards, admin UIs) are welcome as companion packages but will not land inside `@themis/core`.

## License

By contributing, you agree that your contributions are licensed under Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

## Code of Conduct

See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). tl;dr: be decent, stay on-topic, don't make the project unwelcoming.
