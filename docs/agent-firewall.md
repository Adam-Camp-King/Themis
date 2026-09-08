# The agent firewall: chess, not a cage

*Themis 0.2 — RFC v0.2 § 4.6, § 5.4–5.6. Draft post, 2026-09-08.*

Every agent framework ships a cage. Allowlists, role checks, "human in the
loop" toggles. They are static: the same answer for every agent, every time,
regardless of what the agent has been doing for the last ten minutes. A cage
stops the agent you designed for. It does nothing about the one whose key was
stolen at 3 a.m., or the one a prompt injection just turned.

Themis 0.1 was the static layer — locks, drafts, scopes, audit, one engine,
one decision. It is the opening. 0.2 is the middle game.

## Four moves

**Identity.** An agent gets its own revocable key, distinct from the user or
API key it runs under. Before this, the audit row said which *token* acted.
Now it says which *agent*. Revoke the key and the agent is gone; the human's
session is untouched.

**Quarantine.** A hard stop an owner lifts. An agent that trips the anomaly
policy is quarantined automatically; `release` is one command.

**Reputation-scaled rate limits.** Every agent has a reputation from 0 to 1.
It decays when the agent hits a lock, an escalation, a block; it recovers a
little on each clean write. The per-minute limit for its tier is multiplied
by that number. An agent at 0.3 gets 30 % of its quota. A stolen key cannot
exfiltrate at full speed, because the moment it starts behaving like a stolen
key it is already slowing down.

**Anomaly detection that switches itself on.** Hard heuristics fire from day
one: ten deletes in ten minutes, a custom-tier agent reaching for the team or
billing namespace, sixty writes in five minutes at 2 a.m., a 200 KB payload.
The statistical half — today's volume against the agent's own daily history —
contributes nothing until the baseline has two hundred actions over seven
days. A fresh tenant cannot quarantine anyone on noise. Above 0.8 the action
parks with a human; above 0.95 it is denied and the agent is quarantined.

## Why the policies are pure

Each firewall policy reads exactly one thing: `policy_metadata[policy.name]`.
The limiter result, the reputation, the risk score are computed by *your*
stores and handed to the engine. That is what makes the policies testable
across languages: the same JSON vectors run under TypeScript and Python, and
a third implementation conforms when it passes them.

## Fifty lines

```ts
const engine = new PolicyEngine({ auditSink: new ConsoleSink() });
engine.addPolicy(new DefaultQuarantinePolicy());
engine.addPolicy(new DefaultRateLimitPolicy());
engine.addPolicy(new DefaultAnomalyPolicy());

const gated = gateToolHandlers(handlers, {
  engine,
  requestorFrom: () => ({ id: 100, kind: 'agent', tenant_id: 7, scopes: ['*'],
                          metadata: { agent_identity_id: 5, trust_tier: 'custom', quarantined: false } }),
  actionFrom: (tu) => ({ verb: verbFor(tu.name), resource_type: 'invoice', tenant_id: 7, payload: tu.input }),
  policyMetadataFrom: async (tu) => ({
    rate_limit: await limiter.check(7, 'id:5', verbFor(tu.name), 'custom', await reputation.get(7, 'id:5'), Date.now()),
    anomaly: scoreAction({ verb: verbFor(tu.name), side_effects: 'write', trust_tier: 'custom',
                           recent_deletes, recent_writes, local_hour, payload_bytes, now: Date.now() }),
  }),
});
```

The full runnable version, with three scenario tests, is
[`examples/agent-firewall`](../examples/agent-firewall). The reference
deployment is Solid#, where the same policies run on every agent verb
dispatched through the CLI, the MCP server, and ADA — with Redis for the
limiter, Postgres for identities and baselines, and a nightly job that
rebuilds each agent's baseline from the audit substrate.

## What it is not

It is not a model-side safety measure. Training-time alignment makes the
wrong thing *unlikely*; Themis makes it *structurally impossible* at the
point where an agent touches a production system, and now makes the
*unusual* thing slow, visible, and stoppable.
