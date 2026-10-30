# themis-policy-cli

The `themis` command: check verb contracts, turn MCP tools into contracts, and read Themis audit logs as intent records.

```bash
npm install -g themis-policy-cli
```

## Commands

```bash
themis verbs lint verbs/*.json
themis verbs from-mcp tools.json --server github > github.verbs.json
themis report audit.ndjson [--since 2026-10-01] [--tenant 7] [--limit 20] [--json]
```

**`verbs lint`** checks contracts against [the verb contract spec](../../spec/verb-contract.md), across all files at once so duplicate ids and `undone_by` references are caught. Errors (exit 1) are what the JSON Schema rejects, explained in plain words. Warnings flag valid contracts that are probably wrong: money moved without `requires_consent`, an irreversible outbound action without consent, no summary.

**`verbs from-mcp`** maps an MCP `tools/list` result to *declared* contracts using MCP's annotation defaults. Review them, then promote the ones you rely on to *curated*.

**`report`** reads NDJSON audit events (what `ConsoleSink` writes, or a dump of your audit table) and answers:

- what agents did, grouped by what the verb does (read, irreversible, money, outbound, declared…);
- which risky actions went through, which approval let each one through, and what the agent said it was for;
- what is waiting for a person;
- which agent actions stated no intent, ran a verb with no contract, or relied on a declared contract;
- denials by rule, and the busiest verbs.

```
Themis intent report · 2026-10-26 14:17 to 2026-10-26 18:32 UTC

16 decisions: 10 allowed, 4 sent for approval, 0 redirected to draft, 2 denied.

Agents made 16. 15 (94%) stated an intent; 15 (94%) ran a verb with a contract.

Risky agent actions that went through (irreversible, money, access, deletion or export)
  when              who        verb               what it does                                  approval                stated intent
  ────────────────  ─────────  ─────────────────  ────────────────────────────────────────────  ──────────────────────  ───────────────────
  2026-10-26 15:08  agent:100  payment_link.send  irreversible, money, outbound, needs consent  apr_2214                Collect the deposit
  2026-10-26 14:34  agent:100  proposals.send     irreversible, outbound, needs consent         (no approval recorded)  Send Dana the water-heater estimate she asked for
```

## As a library

Everything the command does is exported, so another CLI can embed it:

```ts
import { lintContracts, parseAuditLines, buildReport, formatReport } from 'themis-policy-cli';
```

## License

Apache License 2.0.
