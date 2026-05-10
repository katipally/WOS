# WorkOS (WOS) E2E Tests

End-to-end tests for the WOS Electron app, powered by Playwright with a deterministic agent stub.

## Quick Start

Before running any E2E tests, build the app once:

```bash
npm run e2e:build
```

Then run individual suites:

```bash
# Smoke test: boot, window, and database sanity check
npm run e2e:smoke

# Interactive: open Playwright Inspector
npm run e2e:live

# Record video and trace to e2e/scratch/
npm run e2e:trace

# Full integration suite
npm run e2e:full
```

The `pre` hooks on each `e2e:*` script rebuild `better-sqlite3` against Electron's Node ABI automatically. Always use these scripts rather than invoking `playwright test` directly.

---

## Stub Mechanism

Real LLM calls are replaced by a deterministic agent script when `WOS_E2E_AGENT_SCRIPT` is set to the path of a JSON stub file.

### Script Format

```json
{
  "turns": [
    [
      { "type": "text_delta", "content": "Hello from stub!" },
      { "type": "message_stop", "stopReason": "end_turn", "usage": { "inputTokens": 0, "outputTokens": 0 } }
    ]
  ]
}
```

Each element of `turns` is an array of `StreamEvent` objects yielded as a single LLM response. Turns are consumed globally in order across the entire process lifetime, including subagent `queryLoop()` calls.

**Turn ordering with subagents:**

1. Turn 0 -- parent LLM call (typically includes a `tool_use_start` for `Task`)
2. Turn 1 -- the subagent's LLM call (the `Task` tool calls `queryLoop()` internally)
3. Turn 2 -- parent's follow-up LLM call after the subagent completes

> Do not script concurrent `Task` calls. Two subagents racing over the shared turn counter will produce unpredictable results.

### Tool Execution is Real

When the stub scripts a `tool_use_start` event, the tool actually executes in the main process:

- `automation_create` will create a real database row.
- Do not script `ask_user`; it blocks waiting for a UI response that will never arrive.

### Pre-built Stubs

Stub JSON files live in `e2e/scripts/stubs/`:

| File | Description |
|---|---|
| `simple-reply.json` | Single text reply |
| `subagent-dispatch.json` | Parent dispatches a Task, subagent replies, parent confirms |

---

## Test Suites

| File | What it covers |
|---|---|
| `smoke.spec.ts` | Boot, window opens, DB initialized, preload bridge present |
| `boot-chat.spec.ts` | Stub reply, DB persistence, conversation history |
| `apps-context.spec.ts` | `app_context_snapshots` seeding and round-trip |
| `automations.spec.ts` | `automation_create` for `schedule`, `hook`, and `webhook` kinds |
| `subagents.spec.ts` | Subagent dispatch, `subagent_runs` seeding |

---

## Fixtures

Each spec gets three fixtures from `e2e/harness/fixtures.ts`:

```ts
test('example', async ({ wos, harnessDb, dump }) => {
  // Drive the UI
  await wos.window.click('text=Settings')

  // Query the live database from the test runner
  const rows = await harnessDb.queryAll("SELECT * FROM workspaces")

  // Write a snapshot to e2e/scratch/ (screenshot + DOM + logs)
  await dump('after-settings-open')
})
```

Live LLM-backed tests are gated behind `WOS_E2E_LIVE=1`.

---

## Writing New Stub Tests

```ts
import { withStub, stubPath, sendChatMessage } from './harness/withStub'

test('my test', async () => {
  const { wos, db } = await withStub({ scriptPath: stubPath('simple-reply.json') })
  try {
    await sendChatMessage(wos.window, 'Hello!')
    await expect(wos.window.getByText('Hello from WOS stub!')).toBeVisible()
  } finally {
    db.close()
    await wos.close()
  }
})
```

---

## Artifacts

| Path | Contents |
|---|---|
| `e2e/.artifacts/test-results/` | Playwright traces, videos, and screenshots |
| `e2e/.artifacts/html-report/` | Playwright HTML report |
| `e2e/scratch/` | Per-run state dumps and harness scratch space |

Open the HTML report after a run:

```bash
npx playwright show-report e2e/.artifacts/html-report
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `WOS_E2E=1` | Set automatically by the harness; enables `__wos_db` bridge and skips single-instance lock |
| `WOS_E2E_AGENT_SCRIPT=<path>` | Path to a stub JSON file; bypasses real LLM calls |
| `WOS_USER_DATA=<dir>` | Override the Electron userData directory |
| `WOS_E2E_VERBOSE=1` | Forward Electron main-process logs to the test runner stdout |
| `WOS_E2E_LIVE=1` | Enable live LLM calls in tests that require them |

---

## Skipped Tests

Tests marked `test.skip` have a `TODO` comment explaining the blocker. Common blockers:

- **Clock mocking** -- cron triggers require advancing time
- **OAuth flow** -- app context picker requires a mock app connection
