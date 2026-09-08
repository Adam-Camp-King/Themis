# @themis/langchain

Wraps a LangChain `Tool` — or anything duck-typed like one: a named object with
`call`, `invoke`, `func` or `_call` — so every invocation is evaluated by a
Themis policy engine first.

```ts
import { DynamicTool } from '@langchain/core/tools';
import { gateTool } from '@themis/langchain';

const raw = new DynamicTool({ name: 'send_invoice', description: 'Sends an invoice', func: sendInvoice });
const safe = gateTool(raw, { engine, requestor, tenant_id });
```
