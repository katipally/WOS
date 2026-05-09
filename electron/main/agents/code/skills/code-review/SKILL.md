---
name: code-review
description: Systematic checklist for reviewing code changes for correctness, safety, and clarity
triggers: [review, code review, PR review, pull request, check this code, look over, critique]
---

## Code Review Checklist

**Correctness**
- Does the logic handle all edge cases (null, empty, boundary values)?
- Are error paths handled explicitly — no silent swallows?
- Are async operations awaited properly; no race conditions?

**Type safety**
- No unchecked casts (`as any`, unsafe coercions)?
- Return types match what callers expect?
- Optional chaining used where values may be undefined?

**Naming and clarity**
- Variable and function names reveal intent without needing a comment?
- No abbreviations that require domain knowledge to decode?
- Long functions should be broken up if they do more than one thing?

**Test coverage**
- Happy path tested?
- At least one failure/edge case tested?
- Tests don't mock so heavily that they stop verifying real behavior?

**Security**
- User input sanitized before use in queries, shell commands, or HTML?
- No secrets hardcoded or logged?
- Auth/permission checks present where data is sensitive?

**Performance**
- No N+1 queries inside loops?
- Expensive operations (I/O, regex, JSON parse) not in hot paths without reason?

**Minimal diff**
- Change does only what the task requires — no unrelated cleanup mixed in?
