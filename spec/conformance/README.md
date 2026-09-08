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
- `v0/quarantine.json`, `v0/rate_limit.json`, `v0/anomaly.json` — the RFC v0.2
  agent-firewall policies (§ 5.4–5.6). These policies are pure: their inputs
  arrive on the case's `policy_metadata` (keyed by policy name) and, for an
  identified agent, on `requestor.metadata`.
- `anomaly-scoring.json` — cases for the pure `scoreAction` / `score_action`
  risk function (RFC v0.2 § 5.6): `input` is an `IAnomalyInput`, `expect` is
  the exact `IRiskScore`. Lives outside `v0/` because it is not an engine case.
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
  `"anomaly"`, a scope policy with a
  rule table `{ "name": "scope", "rules": [{ "method", "path", "required_scope" }] }`,
  or a stub `{ "stub": "allow|deny|redirect|require_approval", "name": "…", …fields }`
  used to exercise the engine's ordering rules.
- `expect.decision` is compared **exactly** after canonicalisation: keys whose
  value is `null`/`undefined` are dropped on both sides. An engine-level allow
  is the bare `{ "kind": "allow" }`.
- `expect.policy_chain` is the ordered list of policies that ran.
- `expect.audit` is `"none"` (no event may be emitted), an object (the
  denormalised `requestor` and `action` on the one emitted event must match),
  or absent (an event must be emitted; only decision/chain/tenant/correlation
  are checked).
- `policy_metadata` (optional) is passed to the context verbatim; `requestor.metadata`
  (optional) likewise. That is how the firewall vectors feed their pure policies.
- Every case runs with `correlation_id = "conf-<name>"` and `now = 1700000000000`.

## Adding a case

Add it to the relevant file, run both suites (`npm test` at the repo root and
`pytest` in `python/`), and do not change an existing case's expectation without
a spec change — these files are the contract.
