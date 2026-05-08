import { app, BrowserWindow, globalShortcut, nativeImage } from 'electron'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createWindow } from './window'
import { setupTray } from './tray'
import { setupAutoUpdater } from './updater'
import { initDatabase, getDb, schema, notifyWrite } from './db'
import { encryptApiKey } from './crypto'
import { getSettingJSON, readAllSettings } from './db/settings'
import { registerIpcHandlers } from './ipc'
import { automationsRuntime } from './automations'
import { getLoadedPlugins, startPluginWatcher } from './plugins/loader'
import { scanSkills } from './skills/manager'
import { scanRules } from './rules/manager'
import { disconnectAll } from './mcp/manager'
import { startContextScheduler, stopContextScheduler } from './context/scheduler'

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

// E2E hook: when WOS_E2E=1, redirect userData to a hermetic tmp dir provided by
// the harness. Must run BEFORE any code calls app.getPath('userData') (which
// happens lazily during whenReady, so setting it here is safe).
const isE2E = process.env.WOS_E2E === '1'
if (isE2E && process.env.WOS_USER_DATA) {
  app.setPath('userData', process.env.WOS_USER_DATA)
  console.log('[main] WOS_E2E userData ->', process.env.WOS_USER_DATA)
}

// Enable Chrome DevTools Protocol for remote debugging when debug env is set.
if (process.env.WOS_DEBUG === '1' || process.env.WOS_CDP_PORT) {
  const port = process.env.WOS_CDP_PORT || '9222'
  app.commandLine.appendSwitch('remote-debugging-port', port)
  console.log('[main] CDP enabled on', port)
}

// Under E2E, force the Chrome DevTools port to be enabled on an ephemeral
// port. Playwright's _electron.launch() passes --remote-debugging-port=0 on
// the CLI, but in some packaged builds chromium ignores the CLI switch
// unless we also append it programmatically before whenReady. Without this
// the harness times out waiting for "DevTools listening on…".
if (isE2E) {
  app.commandLine.appendSwitch('remote-debugging-port', '0')
}

// Expose for use in other modules
export let mainWindow: BrowserWindow | null = null
export { MAIN_WINDOW_VITE_DEV_SERVER_URL, MAIN_WINDOW_VITE_NAME }

// Handle single instance. Under E2E we skip the lock so concurrent harness
// runs (each with its own hermetic WOS_USER_DATA) don't fight each other or
// a leftover dev/manual Electron for a global lock.
if (!isE2E) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// Defense-in-depth: never let a stray async error from a child process,
// timer, or unhandled promise take down the whole app. Log loudly and
// continue running so the tray daemon and IPC stay alive.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection', reason)
})

app.whenReady().then(async () => {
  console.log('[main] app ready')
  try {
    console.log('[main] initializing database...')
    await initDatabase()
    console.log('[main] database initialized')

    // Start background context refresh scheduler after DB is ready.
    try {
      startContextScheduler()
    } catch (err) {
      console.warn('[main] context scheduler failed to start', err)
    }

    // Start projects refresh loop (per-resource smart cadence).
    try {
      const { initProjects } = await import('./projects')
      initProjects()
    } catch (err) {
      console.warn('[main] projects refresh loop failed to start', err)
    }

    // E2E: expose a tiny query helper so Playwright tests can introspect the
    // DB through `app.evaluate(...)`. This avoids loading better-sqlite3 in
    // the test runner (it's compiled against Electron's Node ABI, not the
    // host Node), and reuses the live main-process binding.
    if (isE2E) {
      const dbMod = await import('./db')
      ;(globalThis as { __wos_db?: { queryRaw: (s: string, p: unknown[]) => unknown[] } }).__wos_db = {
        queryRaw: (sql, params) => dbMod.queryRaw(sql, (params || []) as never),
      }
      console.log('[main] WOS_E2E exposed __wos_db helper')
    }

    // Dev-only: seed OpenAI API key from env so E2E runs work out of the box.
    if (process.env.WOS_DEV_OPENAI_KEY) {
      try {
        const db = getDb()
        const existing = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.provider, 'openai')).get()
        if (!existing) {
          const { encrypted, iv } = encryptApiKey(process.env.WOS_DEV_OPENAI_KEY)
          const now = new Date()
          db.insert(schema.apiKeys).values({ provider: 'openai', encryptedKey: encrypted, iv, createdAt: now, updatedAt: now }).run()
          notifyWrite()
          console.log('[main] seeded OpenAI API key from WOS_DEV_OPENAI_KEY')
        }
      } catch (err) {
        console.warn('[main] API key seed failed', err)
      }
    }
  } catch (err) {
    console.error('[main] database init failed:', err)
    // Continue without DB in dev — show window anyway
  }

  // Create main window
  mainWindow = createWindow()
  console.log('[main] window created')

  // Register IPC handlers
  registerIpcHandlers(mainWindow)

  // Automations runtime — boots schedule (at|every|cron), hook bus, and webhooks.
  try {
    const cfg = readAllSettings()
    if (cfg['automations.masterEnabled'] === false) {
      console.log('[main] automations master switch off, skipping start')
    } else {
      automationsRuntime.configure({
        webhookPort: typeof cfg['automations.webhookPort'] === 'number' ? cfg['automations.webhookPort'] as number : undefined,
        tunnelProvider: (cfg['automations.tunnelProvider'] as 'cloudflared' | 'none' | undefined) ?? undefined,
      })
      automationsRuntime.start()
      console.log('[main] automations runtime started')
    }
  } catch (err) {
    console.warn('[main] automations runtime failed to start', err)
  }

  // Discover and load WOS plugins (~/.wos/plugins/<id>/) before tools are first built.
  try {
    await getLoadedPlugins()
    if (!isE2E) startPluginWatcher()
  } catch (err) {
    console.warn('[main] plugin discovery failed', err)
  }

  // Scan skills and rules from disk so they're available to the first query.
  try {
    const { runSkillsMigrationV2 } = await import('./skills/migrateV2')
    runSkillsMigrationV2()
  } catch (err) {
    console.warn('[main] skills v2 migration failed', err)
  }
  try {
    scanSkills()
  } catch (err) {
    console.warn('[main] scanSkills failed', err)
  }
  try {
    const wsId = getSettingJSON<string | null>('activeWorkspaceId', null)
    let wsPath: string | null = null
    if (wsId) {
      const db = getDb()
      const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)).get()
      wsPath = ws?.path ?? null
    }
    scanRules(wsPath, wsId)
  } catch (err) {
    console.warn('[main] scanRules failed', err)
  }

  // Dev dock icon (production uses the packaged .icns)
  if (process.platform === 'darwin' && !app.isPackaged) {
    const iconPath = path.join(__dirname, '../../resources/icon.png')
    app.dock?.setIcon(nativeImage.createFromPath(iconPath))
  }

  // Setup tray (skip in E2E to avoid leaking a tray icon across runs).
  if (!isE2E) setupTray(mainWindow)

  // Apply launch-at-login preference (read from settings).
  try {
    const launchAtLogin = getSettingJSON<boolean>('automations.launchAtLogin', false)
    if (app.isPackaged && !isE2E) {
      app.setLoginItemSettings({ openAtLogin: launchAtLogin, openAsHidden: true })
    }
  } catch (err) {
    console.warn('[main] launch-at-login apply failed', err)
  }

  // Setup auto updater (only in production)
  if (app.isPackaged) {
    setupAutoUpdater(mainWindow)
  }

  // Register global shortcuts
  globalShortcut.register('CommandOrControl+N', () => {
    mainWindow?.webContents.send('shortcut:new-conversation')
  })
})

app.on('window-all-closed', () => {
  // Tray daemon: never auto-quit on window close. Automations keep running.
  // Quit only happens via Tray > Quit (which sets isQuitting + app.quit()).
})

app.on('before-quit', () => {
  ;(app as unknown as { isQuitting: boolean }).isQuitting = true
})

app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    registerIpcHandlers(mainWindow)
  } else {
    mainWindow.show()
    mainWindow.focus()
  }
  if (process.platform === 'darwin') app.dock?.show()
})

app.on('will-quit', async () => {
  globalShortcut.unregisterAll()
  try { stopContextScheduler() } catch { /* ignore */ }
  try { automationsRuntime.stop() } catch { /* ignore */ }
  try { await disconnectAll() } catch { /* ignore */ }
})
