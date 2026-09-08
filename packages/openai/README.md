# themis-policy-openai

Intercepts an OpenAI `tool_calls` entry (`{ id, type: 'function', function:
{ name, arguments } }`), evaluates it with a Themis policy engine, and returns
the matching `{ role: 'tool', tool_call_id, content }` message. Arguments are
parsed for policy evaluation and passed through untouched on `allow`.

```ts
import { gateToolCalls } from 'themis-policy-openai';
const handle = gateToolCalls({ send_invoice: sendInvoice }, { engine, requestor, tenant_id });
const toolMessages = await handle(completion.choices[0].message.tool_calls);
```
