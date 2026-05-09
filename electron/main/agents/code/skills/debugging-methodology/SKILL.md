---
name: debugging-methodology
description: Step-by-step approach to diagnosing and fixing bugs systematically
triggers: [debug, bug, error, crash, exception, not working, broken, failing, fix this]
---

## Debugging Methodology

**Step 1 — Read the full error**
Read the stack trace top-to-bottom. Identify the exact file, line, and message. Don't guess before you read.

**Step 2 — Search the code**
Grep for the error message string or the function at the top of the stack. Understand what was running, not just where it crashed.

**Step 3 — Reproduce**
Confirm you can trigger the bug reliably before touching anything. A bug you can't reproduce is a bug you can't verify fixed.

**Step 4 — Isolate**
Narrow the failure to the smallest possible unit. Comment out code, add `console.log`/breakpoints, bisect the input. If it only fails with certain data, find what's different about that data.

**Step 5 — Fix the root cause**
Fix the underlying invariant violation — not just the symptom. Ask: why did this unexpected state exist? Fix that, not just the crash handler.

**Step 6 — Verify**
Re-run the original reproduction. Confirm the error is gone. Check adjacent behavior hasn't regressed.

**Step 7 — Add a test**
If there isn't a test that would have caught this, write one. Name it `should not <bad thing> when <condition>`.

**Common traps**
- Async: `await` missing, callbacks firing multiple times, unhandled promise rejections
- State: shared mutable state mutated in unexpected order
- Types: runtime value doesn't match TypeScript type (bad cast, external data)
- Off-by-one: `<` vs `<=`, 0-indexed vs 1-indexed, empty array checks
