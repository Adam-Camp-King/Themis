// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell
/**
 * examples/agent-firewall — a Claude-style agent under the Themis firewall.
 *
 * Chess, not a cage. The agent has an identity (kind 'agent', a trust tier, a
 * reputation), and every tool_use block is gated by: quarantine → rate limit
 * (scaled by reputation) → anomaly (bulk delete, escalation, off-hours burst,
 * oversized payload). Nothing here needs a database: the memory stores ship in
 * `themis-policy`; swap them for Redis/SQL in production.
 */
import type { IAgentIdentity, IRequestor } from 'themis-policy';
import {
  ConsoleSink, DefaultAnomalyPolicy, DefaultQuarantinePolicy, DefaultRateLimitPolicy,
  MemoryRateLimiter, MemoryReputationStore, PolicyEngine, scoreAction,
} from 'themis-policy';
import { gateToolHandlers } from 'themis-policy-anthropic';

const TENANT = 7;
const recent = { deletes: 0, writes: 0 };            // your audit stream, in one line
const limiter = new MemoryRateLimiter();
const reputation = new MemoryReputationStore();

export const agent: IAgentIdentity = { id: 5, tenant_id: TENANT, agent_type: 'custom-invoicer', trust_tier: 'custom', reputation: 1 };

export function requestorFor(a: IAgentIdentity): IRequestor {
  return { id: 100, kind: 'agent', tenant_id: TENANT, scopes: ['*'], role: 'employee',
           metadata: { agent_identity_id: a.id, trust_tier: a.trust_tier, quarantined: a.quarantined_at != null } };
}

export function buildEngine(): PolicyEngine {
  const engine = new PolicyEngine({ auditSink: new ConsoleSink() });
  engine.addPolicy(new DefaultQuarantinePolicy());
  engine.addPolicy(new DefaultRateLimitPolicy());
  engine.addPolicy(new DefaultAnomalyPolicy());
  return engine;
}

export function buildGate(engine: PolicyEngine, a: IAgentIdentity, localHour = 12) {
  const key = `id:${a.id}`;
  return gateToolHandlers(
    { delete_invoice: async (input) => ({ deleted: (input as { id: number }).id }),
      update_role:    async (input) => ({ role: (input as { role: string }).role }) },
    {
      engine,
      requestorFrom: () => requestorFor(a),
      actionFrom: (tu) => ({ verb: tu.name === 'delete_invoice' ? 'invoice.delete' : 'team.update_role',
                             resource_type: 'invoice', tenant_id: TENANT, payload: tu.input }),
      policyMetadataFrom: async (tu) => {
        const verb = tu.name === 'delete_invoice' ? 'invoice.delete' : 'team.update_role';
        const rep = await reputation.get(TENANT, key);
        const rate_limit = await limiter.check(TENANT, key, verb, a.trust_tier, rep, Date.now());
        const anomaly = scoreAction({ verb, side_effects: 'write', trust_tier: a.trust_tier,
          recent_deletes: recent.deletes, recent_writes: recent.writes, local_hour: localHour,
          payload_bytes: JSON.stringify(tu.input).length, now: Date.now() });
        if (!rate_limit.allowed) await reputation.deduct(TENANT, key, 'rate_limited');
        if (anomaly.risk > 0.8) await reputation.deduct(TENANT, key, anomaly.risk > 0.95 ? 'anomaly_hard_block' : 'anomaly_soft_block');
        if (verb === 'invoice.delete') recent.deletes += 1; recent.writes += 1;
        return { rate_limit, anomaly };
      },
    },
  );
}

if (process.argv[1]?.endsWith('index.ts')) {
  const gate = buildGate(buildEngine(), agent);
  for (let i = 1; i <= 11; i++) console.log(await gate.execute({ type: 'tool_use', id: `t${i}`, name: 'delete_invoice', input: { id: i } }));
}
