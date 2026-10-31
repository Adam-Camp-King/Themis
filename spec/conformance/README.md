# Themis conformance vectors

Themis is a specification (RFC v0) with more than one implementation. These
files are what "conforms" means: an implementation passes every case here or it
does not conform. `themis-policy` (TypeScript) and `themis-policy` (Python) both
run this exact directory in their test suites.

## Layout

- `v0/engine.json` — evaluation rules (RFC § 6): tenancy gate, short-circuits,
  redirect ordering, one audit event per evaluation, `emit_policy`.
- `v0/lock.json`, `v0/scope.json`, `v0/draft.json` — the three core policies
  (RFC § 5), one case per numbered decision rule plus edge cases.
- `v0/intent.json` — RFC v0.3 draft action intent (§ 2.7, § 5.7, § 9.5): intent is
  copied, detached, into the one audit event whatever the decision; only the
  five spec fields are recorded (string fields only as strings, `attributes`
  only as a JSON object at most 32 deep); a summary is blank when every
  character is Unicode White_Space or U+FEFF; and the intent policy denies
  configured requestor kinds that state no summary. Non-finite numbers and
  non-JSON values cannot be written in JSON vectors, so each implementation
  pins those in its unit tests (they drop the whole `attributes` field).
- `v0/verb_contract.json` — RFC v0.3 draft verb contracts (§ 2.8, § 5.8, § 9.6):
  the verb contract policy's rules, and the contract snapshot every audit event
  carries.
- `mcp-mapping.json` — `contractFromMcpTool` / `contract_from_mcp_tool`: `server`
  and `tool` in, the exact declared contract out.
- `v0/quarantine.json`, `v0/rate_limit.json`, `v0/anomaly.json` — the RFC v0.2
  agent-firewall policies (§ 5.4–5.6). These policies are pure: their inputs
  arrive on the case's `policy_metadata` (keyed by policy name) and, for an
  identified agent, on `requestor.metadata`.
- `anomaly-scoring.json` — cases for the pure `scoreAction` / `score_action`
  risk function (RFC v0.2 § 5.6): `input` is an `IAnomalyInput`, `expect` is
  the exact `IRiskScore`. Cases whose input has a `contract` pin § 5.8: the
  contract, not the verb name, decides side effects, deletion and escalation.
  Lives outside `v0/` because it is not an engine case.
- `preview-tokens.json` — verify-only vectors for the draft preview token
  (RFC § 9.3). Minted by the TypeScript implementation; a Python verifier that
  accepts and rejects the same tokens is byte-compatible.

## Case shape

```json
{
  "name": "8. locked area denies with detail",
  "policies": ["lock"],
  "emit_policy": "all",
  "requestor": { "id": 10, "kind": "user", "tenant_id": 7, "scopes": [] },
  "action":    { "verb": "pages.update", "resource_type": "page", "tenant_id": 7, "resource_id": 42, "area": "design" },
  "entity":    { "id": 42, "tenant_id": 7, "agency_owner_id": 99, "locks": { "design": true } },
  "expect": {
    "decision": { "kind": "deny", "policy": "lock", "reason": "agency_lock", "message": "…", "detail": { "…": "…" } },
    "policy_chain": ["lock"],
    "audit": { "requestor": { "…": "…" }, "action": { "…": "…" } }
  }
}
```

- `policies` entries are `"lock"`, `"scope"`, `"draft"`, `"quarantine"`, `"rate_limit"`,
  `"anomaly"`, `"intent"`, `"verb_contract"`, a verb contract policy with options
  `{ "name": "verb_contract", "requireContractFor": [...], "approvalImpacts": [...],
  "approveIrreversible": false, "declaredWrites": "trust" }`, an intent policy with configured kinds
  `{ "name": "intent", "kinds": ["agent", "api_key"] }`, a scope policy with a
  rule table `{ "name": "scope", "rules": [{ "method", "path", "required_scope" }] }`,
  or a stub `{ "stub": "allow|deny|redirect|require_approval", "name": "…", …fields }`
  used to exercise the engine's ordering rules.
- `expect.decision` is compared **exactly** after canonicalisation: keys whose
  value is `null`/`undefined` are dropped on both sides. An engine-level allow
  is the bare `{ "kind": "allow" }`.
- `expect.policy_chain` is the ordered list of policies that ran.
- `expect.audit` is `"none"` (no event may be emitted), an object (the
  denormalised `requestor` and `action` on the one emitted event must match;
  when it has an `intent` key, the event's intent must match too, and
  `"intent": null` means the event must carry none), or absent (an event must be emitted; only decision/chain/tenant/correlation
  are checked).
- `verb_contract` (optional, top level) is placed on the context as `ctx.verb_contract`.
  When `expect.audit` has a `verb_contract` key, the event's contract snapshot must
  match it (`null`: the event carries none).
- `policy_metadata` (optional) is passed to the context verbatim; `requestor.metadata`
  (optional) likewise. That is how the firewall vectors feed their pure policies.
- Every case runs with `correlation_id = "conf-<name>"` and `now = 1700000000000`.

## Adding a case

Add it to the relevant file, run both suites (`npm test` at the repo root and
`pytest` in `python/`), and do not change an existing case's expectation without
a spec change — these files are the contract.
