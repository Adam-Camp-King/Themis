# @themis/mcp

Wraps an MCP tool function so a Themis policy engine evaluates every call:
`allow` runs the tool, `deny` throws `MCPPolicyDenied` (or returns a denial
envelope), `redirect` and `require_approval` return typed envelopes the host
can render as a draft or an approval prompt.

```ts
import { withThemis } from '@themis/mcp';
const send_invoice = withThemis(sendInvoice, { engine, tool: 'send_invoice', requestor, tenant_id });
```

Hints, not gates: pair this with MCP tool annotations (`readOnlyHint`,
`destructiveHint`) for the host's approval UX; the gate is the engine.
