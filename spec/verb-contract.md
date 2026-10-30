# Verb contracts and intent records

*Themis RFC v0.3 (draft) — § 2.8 verb contract, § 5.8 verb contract policy, § 9.6 intent record.*

## Why

Themis decides what an agent may do. Until now it learned what an action *does* from its name: `isDeleteVerb` matches the strings `delete`, `remove`, `purge`, `destroy`; scope escalation is a prefix match on `team.` or `billing.`; `side_effects` is whatever the caller says. A verb called `invoice.void`, `contact.merge` or `wire.release` passes all of that untouched.

A **verb contract** is a short, declared description of what a verb does: whether it writes, whether it can be undone, whether it moves money, reaches someone outside the business, changes access or deletes data. Policies read the contract, never the name. The same contract, snapshotted into every audit event next to the agent's stated intent, turns the audit log into **intent records**: who acted, what they said it was for, what that verb does, and what Themis decided.

Two properties matter most:

- **Anyone's verbs.** Themis ships no catalog. A verb ID is namespaced by its owner, so a business's own verbs, a third party's, an MCP server's tools and an agent skill can all be governed by the same engine without colliding, and no one has to register with anyone.
- **Declared is not curated.** A contract you wrote about your own verb is a fact you control. A contract an outside MCP server declares about its own tool is a claim. The contract records which it is, and the default policy treats them differently.

## § 2.8.1 Verb IDs

```
verb-id   = namespace ":" name
namespace = [a-z0-9] *( [a-z0-9] / "." / "_" / "-" )
name      = 1*( any character except whitespace )
```

| Namespace | Use | Example |
|---|---|---|
| reverse DNS (recommended) | a business's or vendor's own verbs | `com.solidnumber:payment_link.send` |
| short owner prefix | the same, where everyone in a deployment knows the owner | `acme:refund.issue` |
| `mcp` (reserved) | a tool on an MCP server: `mcp:<server>/<tool>` | `mcp:github/create_issue` |
| `skill` (reserved) | an agent skill: `skill:<skill-id>` | `skill:pdf-fill` |
| `themis` (reserved) | future use by this specification | |

Themis never reads meaning into a namespace or a name. The name after the colon is opaque. An implementation MAY let callers use an unqualified name (`payment_link.send`) and resolve it in a registry's default namespace (§ 2.8.4).

## § 2.8.2 The contract

```json
{
  "id": "com.solidnumber:payment_link.send",
  "version": "2026-10-01",
  "summary": "Create a payment link and send it to a contact by SMS or email.",
  "side_effects": "write",
  "reversibility": "irreversible",
  "impacts": ["money", "outbound"],
  "requires_consent": true,
  "idempotent": false,
  "required_scope": "payments:write",
  "acts_on": { "noun": "payment_link", "party": "tenant_customer" },
  "refuses": [{ "code": "invalid_amount", "when": "amount_cents must be positive" }],
  "input_schema": { "type": "object" },
  "provenance": "curated",
  "extensions": { "com.solidnumber": { "coordinate": "533", "tier_floor": "starter" } }
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | The verb ID (§ 2.8.1). |
| `side_effects` | yes | `read` changes nothing. `write` changes state. `mixed` reads and may write. |
| `reversibility` | when `side_effects` is not `read` | `reversible`: the prior state can be restored. `compensable`: it cannot be restored, but a counter-action exists (a refund, a retraction). `irreversible`: neither (a sent email, a placed call, a destroyed record). |
| `provenance` | yes | `curated`: written or reviewed by whoever runs the engine. `declared`: self-described by the tool's own server or package. |
| `version` | no | The contract's version, recorded in audit so a report shows what was believed at the time. |
| `summary` | no | One line, plain words. |
| `impacts` | no | What kind of thing changes. Well-known values below; any value containing `:` is an extension (`com.solidnumber:dispatch`). |
| `requires_consent` | no | A person must agree to this exact action before it runs. Default `false`. |
| `undone_by` | no | The verb ID that reverses or compensates this one. Not allowed on `irreversible`. |
| `idempotent` | no | Calling it twice with the same input has the same effect as once. |
| `required_scope` | no | The scope a requestor must hold. Feed it to `action.required_scope` for the scope policy. |
| `acts_on` | no | `{ noun, party }`: what the verb touches and whose it is (`tenant_internal`, `tenant_customer`, `platform`, or your own). |
| `refuses` | no | `[{ code, when }]`: the refusal codes the verb returns and when. |
| `input_schema`, `output_schema` | no | JSON Schema. |
| `extensions` | no | `{ "<namespace>": { … } }`: anything owner-specific. Themis ignores it. |

### Well-known impacts

| Impact | The verb… | Examples |
|---|---|---|
| `money` | moves, commits or requests funds | charge, refund, payout, send a payment link, approve an invoice |
| `access` | changes who can do what | roles, API keys, permissions, agent identities |
| `outbound` | reaches someone outside the tenant | email, SMS, call, social post, webhook to a third party |
| `deletion` | removes records | delete, purge, merge-and-discard |
| `data_export` | moves data out of the system | export, bulk download, sync to an outside service |
| `publish` | changes what the public can see | publish a page, post a listing |

A verb may have several. `impacts` is about kind, `reversibility` is about undo; keep them separate. A refund is `money` and `compensable`; a sent text is `outbound` and `irreversible`.

The machine-readable schema is [`schema/verb-contract.schema.json`](schema/verb-contract.schema.json). Examples: [`examples/verbs/`](examples/verbs).

## § 2.8.3 Provenance and trust

A contract is only as good as whoever wrote it. MCP's own specification tells clients not to make decisions from tool annotations supplied by untrusted servers, and the same holds here.

- **Curated** contracts come from a registry the deployer controls. Themis treats them as fact.
- **Declared** contracts come from the thing being governed. Themis records them and uses them, but the default policy (§ 5.8) requires approval for every declared write, whatever reversibility or impacts the server claims.

A declared `read` claim cannot be checked by any policy layer. If you rely on a third-party tool being read-only, curate its contract.

## § 2.8.4 Registries

```ts
interface IVerbRegistry {
  resolve(verb: string): IVerbContract | null | Promise<IVerbContract | null>;
}
```

The engine does no I/O. The caller, usually an adapter, resolves `action.verb` against a registry and puts the result on `ctx.verb_contract`. Every adapter takes a `verbRegistry` option for this.

Shipped: `StaticVerbRegistry(contracts, { defaultNamespace })` (exact ID, or an unqualified name in the default namespace) and `ChainVerbRegistry([…])` (first hit wins). Chain in trust order, your curated registry first:

```ts
const registry = new ChainVerbRegistry([
  solidVerbs,                                   // curated: com.solidnumber:*
  new StaticVerbRegistry(myOverrides),          // curated: tools you reviewed
  new StaticVerbRegistry(mcpTools.map((t) => contractFromMcpTool('github', t))),  // declared
]);
```

### MCP tools

`contractFromMcpTool(server, tool)` maps an MCP `tools/list` entry, using MCP's defaults for missing hints:

| MCP | Contract |
|---|---|
| `mcp:<server>/<name>` | `id` |
| `description`, else `annotations.title` | `summary` |
| `readOnlyHint: true` | `side_effects: read` (nothing below applies) |
| otherwise | `side_effects: write` |
| `destructiveHint: false` | `reversibility: reversible` |
| `destructiveHint` true or absent | `reversibility: irreversible` |
| `openWorldHint` true or absent | `impacts: ["outbound"]` |
| `idempotentHint` | `idempotent` |
| `inputSchema`, `outputSchema` | `input_schema`, `output_schema` |
| — | `provenance: declared`, `extensions.mcp = { server, tool }` |

Vectors: [`conformance/mcp-mapping.json`](conformance/mcp-mapping.json).

### Skills

Agent skills have no standard risk manifest. Give each skill its contract in your curated registry under `skill:<id>`. A skill that runs several verbs should declare the union: the riskiest `reversibility` and every impact.

## § 5.8 Verb contract policy

`DefaultVerbContractPolicy` (name `verb_contract`) reads `ctx.verb_contract` and `policy_metadata.verb_contract`.

Options: `requireContractFor` (requestor kinds, default `['agent']`), `approvalImpacts` (default `['money', 'access', 'deletion', 'data_export']`), `approveIrreversible` (default `true`), `declaredWrites` (`'require_approval'` default, or `'trust'`).

`impacts` counts only when it is an array of strings; any other value is treated as no impacts, by this policy, by `scoreAction` and by the audit snapshot alike.

Decision rules, in order:

1. No contract (not an object, or no string `id`). The requestor's kind is in `requireContractFor` → **deny** `unknown_verb`. Otherwise allow.
2. The contract is for a different verb → **deny** `contract_mismatch`. A qualified `action.verb` (it contains `:`) must equal `contract.id` exactly. An unqualified one must equal the part of `contract.id` after its first `:`.
3. `side_effects` is `read` → allow.
4. `policy_metadata.verb_contract.approved` is `true` → allow. The deployer sets this after verifying an approval for this exact action. Also put the approval's reference in `action.metadata.approval_ref`: the audit event records `metadata`, so the record shows which approval let a risky action through, and the report flags any that went through without one.
5. Collect approval reasons, in this order:
   - `requires_consent` when `requires_consent` is `true`;
   - `irreversible` when `approveIrreversible` and `reversibility` is `irreversible`; `reversibility_unknown` when `reversibility` is missing or not one of the three values;
   - `impact:<x>` for each impact in `approvalImpacts`, in `approvalImpacts` order, that the contract lists;
   - `declared_write` when `declaredWrites` is `'require_approval'` and `provenance` is not `curated`.
6. Any reasons → **require_approval** with `approval_ref` = `policy_metadata.verb_contract.approval_ref` or `verb:<id>`, and message `Needs approval before <id> runs: <reasons joined by ", ">.`
7. Otherwise allow.

Register it after `intent` and `quarantine` and before `scope`. Wire `contract.required_scope` into `action.required_scope` so the scope policy enforces it.

With a contract on the context, `scoreAction` (§ 5.6) stops guessing: `side_effects` comes from the contract, a bulk delete is a verb whose impacts include `deletion`, and a custom-tier escalation is a verb whose impacts include `access`, `money` or `data_export` (reason `scope_escalation:<impact>`, first match in that order). Without a contract, the name heuristics apply unchanged.

## § 9.6 Intent records

Every audit event now carries, beside the decision and policy chain:

- `intent`: what the requestor said the action was for (§ 2.7);
- `verb_contract`: a snapshot of what the verb does, taken at decision time.

```json
{
  "id": "8b1e…", "timestamp": 1761862800000, "tenant_id": 7, "correlation_id": "toolu_01A…",
  "requestor": { "id": 100, "kind": "agent", "scopes": ["payments:write"] },
  "action": { "verb": "com.solidnumber:payment_link.send", "resource_type": "payment_link" },
  "intent": { "summary": "Send Dana the deposit link she asked for on the call", "source": "user_request",
              "request_ref": "call_5521", "tool_call_id": "toolu_01A…" },
  "verb_contract": { "id": "com.solidnumber:payment_link.send", "version": "2026-10-01", "side_effects": "write",
                     "reversibility": "irreversible", "impacts": ["money", "outbound"],
                     "requires_consent": true, "provenance": "curated" },
  "decision": { "kind": "require_approval", "policy": "verb_contract", "approval_ref": "verb:com.solidnumber:payment_link.send",
                "message": "Needs approval before com.solidnumber:payment_link.send runs: requires_consent, irreversible, impact:money." },
  "policy_chain": ["intent", "quarantine", "verb_contract"]
}
```

The snapshot records `id`, `version`, `summary`, `side_effects`, `reversibility`, `impacts`, `requires_consent` and `provenance`: each only when it has the right JSON type (strings; `impacts` only when every entry is a string; `requires_consent` only when boolean). It is a detached copy. Schemas, refusal codes and extensions are not recorded; join on `id` and `version` if you need them.

That one row answers the governance questions directly:

- What did agents try that moves money or can't be undone, and what did each say it was for?
- Which of those went through, which waited for a person, which were refused, and by which rule?
- Which actions came with no stated reason, or with no contract at all?
- Which contracts did we take on a third party's word?

The outcome of an allowed action (did the handler succeed) is not part of the decision. It joins on `correlation_id`; adapters default that to the model's tool-call id.

### Storing intent records

```sql
create table themis_audit (
  id             uuid primary key,
  tenant_id      bigint      not null,
  ts             timestamptz not null,
  correlation_id text        not null,
  requestor      jsonb       not null,
  verb           text        not null,
  decision_kind  text        not null,      -- allow | deny | redirect | require_approval
  decision       jsonb       not null,
  intent         jsonb,
  verb_contract  jsonb,
  policy_chain   text[]      not null,
  metadata       jsonb
);
create index on themis_audit (tenant_id, ts desc);
create index on themis_audit (tenant_id, decision_kind) where decision_kind <> 'allow';
create index on themis_audit using gin (verb_contract jsonb_path_ops);
create index on themis_audit using gin (intent jsonb_path_ops);

-- Irreversible money moves by agents this week, with what each said it was for.
select ts, verb, decision_kind, intent->>'summary' as stated_intent
from themis_audit
where tenant_id = $1 and ts > now() - interval '7 days'
  and requestor->>'kind' = 'agent'
  and verb_contract @> '{"impacts": ["money"], "reversibility": "irreversible"}'
order by ts desc;
```

Use `jsonb`, not `json`: these columns are queried by containment and indexed. If you hash events for a tamper-evident chain, hash a canonical serialisation at write time and store the hash beside the row; `jsonb` does not keep key order.

### From the command line

`themis-policy-cli` reads NDJSON audit events (what `ConsoleSink` writes):

```bash
themis verbs lint verbs/*.json                 # check contracts before they ship
themis verbs from-mcp tools.json --server github > github.verbs.json
themis report audit.ndjson                     # the intent-record report
themis report audit.ndjson --json              # the same, for another program
```

## Mapping an existing catalog: Solid#

Solid#'s verb library already describes each verb (`library.describe`). Its fields map directly:

| Solid# | Contract |
|---|---|
| `name` | `id`, namespaced `com.solidnumber:<name>` |
| `description` | `summary` |
| `side_effects` (`read` / `write` / `mixed`) | `side_effects` |
| `reversibility` (`reversible` / `irreversible`) | `reversibility` |
| `undone_by`, `inverse` | `undone_by` |
| `requires_consent` | `requires_consent` |
| `required_scope` | `required_scope` |
| `acts_on.noun`, `acts_on.party` | `acts_on` |
| `refuses_when[].code`, `.when` | `refuses` |
| `input_schema`, `output_schema` | `input_schema`, `output_schema` |
| `coordinate`, `tier_floor`, `surfaces`, `shape` | `extensions["com.solidnumber"]` |
| — | `impacts`: not a Solid# field today; derive from the noun's domain (Taking payment → `money`; Texts, Email, Calls → `outbound`) or add it to the library |
| — | `provenance: curated` |

The catalog stays Solid#'s. The contract shape is the open part, so the same engine governs Solid# verbs, a customer's own verbs and any MCP tool together.
