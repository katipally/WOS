---
name: testing-strategy
description: Guidelines for writing useful, maintainable tests across unit and integration levels
triggers: [test, tests, write tests, testing, spec, unit test, integration test, coverage]
---

## Testing Strategy

**What to test**
- Public contracts: what the function/module promises to do, not how it does it internally
- Edge cases: empty input, null, max values, concurrent calls
- Error paths: does it throw the right error? Does it return the right sentinel?
- Don't test implementation details — if you rename a private variable, no tests should break

**Unit vs integration**
- Unit: one function, all dependencies mocked. Fast, deterministic. Best for pure logic.
- Integration: real dependencies (DB, filesystem, HTTP). Slower but catches real failures. Prefer for anything that reads or writes external state.
- Don't use unit tests where integration tests are appropriate just to avoid setup cost.

**What to mock**
- Mock at the boundary (network, filesystem, time), not inside your own module
- If you're mocking your own code to test your own code, rethink the design
- `Date.now()` and `Math.random()` should be injectable or mockable; hardcoded `new Date()` inside logic is untestable

**Test naming**
- Use `it('should <expected behavior> when <condition>')` or `it('<does what>')`
- Name describes the failure mode when the test fails — make it obvious what broke

**Coverage focus**
- 100% line coverage is not the goal; covering all meaningful branches is
- Critical paths (auth, payments, data mutation) deserve the most coverage
- Happy path + at least 2 failure cases per function is a reasonable baseline

**Test isolation**
- Each test must be independent; no shared mutable state between tests
- Clean up after yourself (DB rows, temp files, mocks restored)
- Tests that pass in isolation but fail in sequence signal shared state leaking
