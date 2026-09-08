# Themis + Claude — Reference Architecture

> **One-page architecture for deploying Claude-powered agents with Themis as the run-time safety layer.**
>
> Status: v0 draft. Themis itself is pre-alpha.
> Audience: engineers building Claude agents for production; Anthropic BD / research.

## The problem Themis solves for Claude

Anthropic ships Claude with tool use. Applications give Claude a list of tools (`name`, `description`, `input_schema`). Claude emits `tool_use` blocks; the application runs them; results go back as `tool_result` blocks. This loop is well-documented and works today.

What the loop does NOT answer:

- *Which of these tools is the credential actually authorized to call?*
- *Should this update land live, or in a draft-review queue?*
- *Does this operation (wire transfer, delete, send invoice) need a human approval before it fires?*
- *Is this agent operating inside the correct tenant?*
- *Where is the structured audit trail of every attempted action, denial, redirect, and approval?*

Every production Claude deployment answers these four questions with bespoke, inconsistent middleware. Themis formalizes the answers into a single pluggable kernel.

## The picture (textual diagram)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Your application                              │
│                                                                      │
│   user message                                                       │
│        │                                                             │
│        ▼                                                             │
│   ┌─────────────────────┐                                            │
│   │  Anthropic SDK      │  Claude decides a tool_use                 │
│   │  messages.create()  │  { id, name: 'send_wire_transfer',         │
│   │                     │    input: { amount: 500000 } }             │
│   └──────────┬──────────┘                                            │
│              │                                                       │
│              ▼                                                       │
│   ┌──────────────────────────────────────────────┐                   │
│   │  themis-policy-anthropic.gateToolHandlers         │                   │
│   │   ├─ requestorFrom  → IRequestor             │                   │
│   │   ├─ actionFrom     → IAction                │                   │
│   │   └─ engine.evaluate(ctx)                    │                   │
│   └──────────────────┬───────────────────────────┘                   │
│                      │                                               │
│                      ▼                                               │
│   ┌──────────────────────────────────────────────┐                   │
│   │  themis-policy PolicyEngine                  │                   │
│   │   1. tenancy gate                            │                   │
│   │   2. scope policy      ─────┐                │                   │
│   │   3. lock policy       ─── (in order)        │                   │
│   │   4. draft policy      ─────┘                │                   │
│   │                                              │                   │
│   │   exactly one IAuditEvent ──────────────┐    │                   │
│   └──────────────────┬───────────────────────│───┘                   │
│                      │                       │                       │
│         ┌────────────┴──────┐            IAuditSink                  │
│         │                   │           (stdout, file,               │
│         ▼                   ▼            http, SQL, ...)             │
│    allow  →  your handler   deny / redirect / require_approval       │
│              runs as normal  ─→  tool_result with structured envelope│
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Minimum viable integration (10 minutes)

```ts
import Anthropic from '@anthropic-ai/sdk';
import {
  ConsoleSink,
  DefaultDraftPolicy,
  DefaultLockPolicy,
  DefaultScopePolicy,
  PolicyEngine,
} from 'themis-policy';
import { gateToolHandlers } from 'themis-policy-anthropic';

// 1. Build an engine with the three default policies
const engine = new PolicyEngine({ auditSink: new ConsoleSink() });
const scope = new DefaultScopePolicy();
scope.addRule({ method: 'POST', path_pattern: '/wires' }, 'payments:write');
engine.addPolicy(scope);
engine.addPolicy(new DefaultLockPolicy());
engine.addPolicy(new DefaultDraftPolicy());

// 2. Gate your tool handlers through the engine
const gated = gateToolHandlers(
  { send_wire_transfer: async (args) => treasury.wire(args) },
  {
    engine,
    requestorFrom: () => currentAgent,
    actionFrom: (toolUse) => ({
      verb: 'invoke',
      resource_type: 'wire_transfer',
      tenant_id: currentTenantId,
      required_scope: 'payments:write',
      payload: toolUse.input,
    }),
  },
);

// 3. In your Claude tool-use loop, route each tool_use through gated.execute
const client = new Anthropic();
let response = await client.messages.create({ /* ... */ });
while (response.stop_reason === 'tool_use') {
  const toolUses = response.content.filter((b) => b.type === 'tool_use');
  const toolResults = await Promise.all(toolUses.map((tu) => gated.execute(tu)));
  response = await client.messages.create({
    /* feed toolResults back as user-role content */
  });
}
```

That's it. Every tool call now produces an audit event. Denials, redirects, and approval-pending states come back as structured `tool_result` blocks that Claude can reason about.

## What each policy does, in Claude terms

| Policy | Decision | Tool-result shape Claude sees |
|--------|----------|-------------------------------|
| **Scope** | `allow` / `deny` | `is_error: true, content: "[themis] scope: Missing required scope 'payments:write'."` |
| **Lock** | `allow` / `deny` | `is_error: true, content: "[themis] lock: Area 'pages' is locked by the agency."` |
| **Draft** | `allow` (direct write) / `redirect` | `content: {"themis_redirect": true, "target": "draft", "payload": {...}}` — Claude sees the redirect and can surface the preview URL to the user |
| **Custom threshold** | `allow` / `require_approval` | `content: {"themis_approval_pending": true, "approval_ref": "approval-xyz"}` — Claude can tell the user an approval was requested |

Claude **sees** every denial, redirect, and approval. This is critical: the model isn't blind to the safety layer. It can explain to the user *why* an action didn't execute, and suggest the right follow-up (e.g., "I tried to send the wire but the system requires approval for amounts over $10k — I've queued it").

## Why this fits Anthropic's deployment story

Anthropic's messaging around Claude emphasizes helpful, harmless, honest. Constitutional AI (training-time) covers *harmless*. Themis (deploy-time) covers what Constitutional AI can't structurally guarantee: **that a model which might still "want" to do the wrong thing cannot actually do it** in a multi-tenant production system.

- Themis is **run-time constitutional AI** — the same principle, enforced at the action layer.
- Themis is **off-by-default** in the sense that no adoption is required to use Claude. It's *drop-in* for teams that want it — same shape as the existing tool-use pattern, just wrapped.
- Themis is **framework-shaped** — Anthropic's own internal tools can wrap their tool-use handlers with `themis-policy-anthropic` without rewriting agents.
- Themis's **audit schema** captures every policy denial as structured, machine-labeled training data. This is the single most scarce corpus for alignment research: real bounded-autonomy decisions with outcomes.

## Solid# as the reference deployment

Themis runs in production inside [Solid#](https://solidnumber.com), a multi-tenant AI business-operations platform. The four primitives Themis packages (agency locks, drafts-by-default, scoped API keys, structured audit) ran there for ~12 months before extraction. Solid# has:

- Agency locks on 6 resource categories across thousands of tenants
- Drafts-by-default on every CMS write from an AI agent
- 43 canonical scopes enforced on every API-key-authenticated request
- Policy-denial audit events as first-class `IAuditEvent` rows (the gap Themis fills in Solid#'s internal corpus)

Solid# is public-source (Tier 2 licensing for CLI/SDK; Tier 1 proprietary for the product itself). Themis is the extracted Tier 3 "bait layer" — Apache-2.0, no commercial restriction, designed for wide adoption.

## Deployment profiles

| Profile | How Themis runs | Audit sink |
|---------|------------------|------------|
| Solo dev / prototype | In-process, `DefaultScopePolicy` + `ConsoleSink` | stdout NDJSON |
| Single-tenant SaaS | In-process, all three policies, SQL sink | table in app DB |
| Multi-tenant SaaS | In-process per request; tenancy gate enforced from JWT claims | partitioned table per tenant / per-region |
| Claude Code / workstation | Wraps each MCP tool handler; per-user sink | local NDJSON + optional cloud fan-out |
| Anthropic research corpus | Fan-out via `MultiSink`; one sink redacts + forwards to a shared bucket | custom research sink |

## What's next

- `themis-policy-dsl` — YAML declarations for the 80% common case (scopes + locks + drafts + approvals)
- `themis-policy-approvals` — the approval workflow state machine companion to `require_approval`
- `themis-policy-observe` — OpenTelemetry-compatible audit sink
- Official MCP reference integration showing every `solid-mcp-server` tool gated by Themis (Solid#'s dogfood loop)

## License

Apache-2.0. See `LICENSE` in the repo root.

> Themis is deliberately permissive. Adopt it in commercial products, fork it, embed it in frameworks. The *permission* is free; the *scale* is where Solid#'s hosted platform becomes the natural home (multi-region audit retention, approval dashboards, cross-tenant collective intelligence, partner-grade SLAs). License-as-strategy, not license-as-surveillance.

---

**Contact:** `adam@solidnumber.com` · **Repo:** [`github.com/Adam-Camp-King/Themis`](https://github.com/Adam-Camp-King/Themis) · **RFC:** privately at `Solid/themis-extraction-notes/07-RFC-themis-v0.md` (public version lands in `spec/` at v0.1)
