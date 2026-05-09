/**
 * withStub — launch WOS with a scripted agent stub.
 *
 * Writes the script JSON to e2e/scratch/, sets WOS_E2E_AGENT_SCRIPT, then
 * launches the Electron app and waits for the DB to be ready.
 *
 * Usage:
 *   const { wos, db } = await withStub({ scriptPath: path.join(__dirname, 'scripts/stubs/simple-reply.json') })
 *   try { ... } finally { db.close(); await wos.close() }
 */

import path from 'node:path'
import { launchWos, type HarnessHandle, type HarnessOptions } from './launch'
import { openHarnessDb } from './db'

export type HarnessDbHandle = ReturnType<typeof openHarnessDb>

export interface WithStubOptions extends Pick<HarnessOptions, 'userDataDir' | 'forwardLogs'> {
  /** Absolute path to the stub JSON script file. */
  scriptPath: string
}

export interface WithStubResult {
  wos: HarnessHandle
  db: HarnessDbHandle
}

export async function withStub(opts: WithStubOptions): Promise<WithStubResult> {
  const wos = await launchWos({
    userDataDir: opts.userDataDir,
    forwardLogs: opts.forwardLogs ?? !!process.env.WOS_E2E_VERBOSE,
    env: {
      WOS_E2E_AGENT_SCRIPT: opts.scriptPath,
    },
  })

  const db = openHarnessDb(wos.app)
  // Wait for the main-process __wos_db helper to be installed (same pattern as fixtures.ts).
  let tries = 0
  while (tries < 120) {
    try {
      await db.queryAll('SELECT 1')
      break
    } catch {
      await new Promise((r) => setTimeout(r, 250))
      tries++
    }
  }

  return { wos, db }
}

/** Convenience: resolve a stub JSON path relative to the e2e/scripts/stubs/ directory. */
export function stubPath(name: string): string {
  return path.join(__dirname, '..', 'scripts', 'stubs', name)
}

/** Helper: wait for a textarea, type text, and press Enter to send a message. */
export async function sendChatMessage(window: import('@playwright/test').Page, text: string): Promise<void> {
  // App can open on Home view (new chat flow) or Chat view (existing conversation).
  const homeComposer = window.getByPlaceholder('Plan, build, or ask anything… (type / or @)')
  const chatComposer = window.getByPlaceholder('Send a message… (/ for commands, @ to attach a file)')

  let textarea = homeComposer
  try {
    await homeComposer.waitFor({ state: 'visible', timeout: 5_000 })
  } catch {
    textarea = chatComposer
    await chatComposer.waitFor({ state: 'visible', timeout: 30_000 })
  }

  await textarea.fill(text)
  await window.keyboard.press('Enter')
}
