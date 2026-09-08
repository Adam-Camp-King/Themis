# @themis/anthropic

Gates Claude's `tool_use` blocks through a Themis policy engine. No Anthropic
SDK import: it accepts the public `tool_use` shape (`type`, `id`, `name`,
`input`) and returns the public `tool_result` shape (`tool_use_id`, `content`,
optional `is_error`). Any SDK that speaks those shapes works.

```ts
import Anthropic from '@anthropic-ai/sdk';
import { PolicyEngine, DefaultScopePolicy } from '@themis/core';
import { gateToolHandlers } from '@themis/anthropic';

const engine = new PolicyEngine();
engine.addPolicy(new DefaultScopePolicy());

const gated = gateToolHandlers({ send_invoice: sendInvoice }, { engine, requestor, tenant_id });
// run Claude's tool_use blocks through `gated`; a deny becomes an is_error tool_result
```

`deny` → an error `tool_result` the model can read; `redirect` → the handler
receives the draft target; `require_approval` → an approval reference instead
of execution. One audit event per attempted call.
