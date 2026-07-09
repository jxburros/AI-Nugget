# Recipe: Spec-Driven Context

Use this when source selection should be policy-driven, not only semantic.

## Example policy

```ts
import { selectSourcesByPolicy } from '@jxburros/context-nugget';

const { selected, missingRequired, coverageWarning } = selectSourcesByPolicy(sources, 'architecture-change', [
  {
    taskType: 'architecture-change',
    requiredSourceIds: ['identity', 'architecture'],
    optionalSourceIds: ['roadmap', 'changelog'],
  },
]);
```

## Pattern

```txt
task type
-> required docs
-> optional docs
-> coverage warning if missing
-> no over-reading by default
```

## Good fit

- Identity/scope changes.
- Architecture/data-flow changes.
- Roadmap implementation.
- Completion reports.
- Changelog updates.
