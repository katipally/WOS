---
name: refactoring-patterns
description: Safe, incremental refactoring techniques that preserve behavior while improving clarity
triggers: [refactor, clean up, simplify, restructure, extract, rename, reorganize]
---

## Refactoring Patterns

**Ground rule: one behavior change at a time**
Never mix refactoring with feature changes in the same commit. Refactor first, then add the feature. This makes diffs reviewable and rollbacks safe.

**Extract function**
When a block of code has a clear purpose distinct from its surroundings, extract it. Name the function for what it does, not what it contains (`validateEmail`, not `checkStringForAtSign`).

**Rename for clarity**
`data`, `info`, `result`, `temp`, `val`, `obj` are not names — they're placeholders. Replace with what the value actually represents. Rename all usages in one pass.

**Remove dead code**
If it's unreachable, commented out, or behind a flag that's always false — delete it. Version control is the undo button. Don't preserve code "just in case."

**Guard clauses (early returns)**
Invert nested conditions into early returns. Instead of `if (valid) { ... lots of code ... }`, use `if (!valid) return`. Reduces nesting and makes the happy path obvious.

**No magic numbers/strings**
`if (status === 3)` is a bug waiting to happen. Extract to a named constant or enum: `if (status === Status.FAILED)`.

**Replace boolean traps**
`setLoading(true, false, true)` — which arg means what? Use an options object or named constants when a function takes more than one boolean.

**Consolidate duplicate logic**
Three functions that do 90% the same thing should become one function with a parameter. But don't over-abstract two things that happen to look similar — wait for the third.

**After every refactor**
Run the tests. If tests fail after a pure refactor, either the refactor changed behavior (a bug) or the tests were testing implementation details (the tests need fixing).
