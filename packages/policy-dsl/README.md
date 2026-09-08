# themis-policy-dsl

Compiles a YAML policy file into a ready `themis-policy` `PolicyEngine`. The DSL
covers the common case — scopes, locks, drafts, approval thresholds — and
custom code policies register alongside. Grammar: `spec/policy-dsl.md`.

```ts
import { compilePolicyYaml } from 'themis-policy-dsl';
const bundle = compilePolicyYaml(fs.readFileSync('policies.yaml', 'utf8'));
bundle.engine.evaluate(ctx);          // scope / lock / draft / approval policies
bundle.lock_defaults;                 // for your ILockStore on entity creation
```
