import { app, shell, BrowserWindow, ipcMain, dialog, Notification, session, Tray, Menu, nativeImage } from 'electron'
import { extname, isAbsolute, join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, readFileSync, writeFileSync, promises as fsPromises } from 'fs'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { Store } from './store'
import { PtyManager } from './ptyManager'
import { StatusManager } from './statusManager'
import { HookServer } from './hookServer'
import { GitBranchPoller } from './git'
import { Updater } from './updater'
import { IPC, HOOK_SERVER_PORT } from '../shared/types'
import type {
  CreateTerminalInput,
  CreateWorkspaceInput,
  ExportResult,
  FileEntry,
  ImportCommitInput,
  ImportCommitResult,
  ImportPrepareResult,
  ImportPreviewEntry,
  ListDirResult,
  ReadFileResult,
  RestorableSettings,
  Terminal,
  UpdateTerminalInput,
  Workspace
} from '../shared/types'

// E2E tests set this to an isolated temp directory so test runs never read/write the real
// user's persisted workspaces.json. Must run before Store() (below) touches userData.
if (process.env.ITTOP_USER_DATA_DIR) {
  app.setPath('userData', process.env.ITTOP_USER_DATA_DIR)
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
// ittop's whole point is keeping sessions alive in the background — closing the window (the X
// button, Alt+F4, ...) minimizes to the tray instead of quitting. This flag distinguishes that
// from a real quit (tray menu "Quit", or the app quitting for another reason), so the window's
// own 'close' handler knows whether to hide or actually let the close proceed.
let isQuitting = false

function createTray(): void {
  // The app icon is a full-color square logo, not an alpha-only silhouette, so it can't be a
  // macOS template image (that would flatten it to a solid black/white blob). Just size it for
  // the menu bar instead; Windows keeps the smaller tray-standard size.
  const size = process.platform === 'darwin' ? 22 : 16
  const trayIcon = nativeImage.createFromPath(icon).resize({ width: size, height: size })
  tray = new Tray(trayIcon)
  tray.setToolTip('ittop')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open ittop',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
        }
      },
      {
        label: 'Check for updates',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
          mainWindow?.webContents.send(IPC.openSettingsRequest)
          void updater.checkForUpdates()
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

const store = new Store()
const statusManager = new StatusManager()
const ptyManager = new PtyManager(
  statusManager,
  (terminalId, data) => mainWindow?.webContents.send(IPC.ptyData, { id: terminalId, data }),
  (terminalId, exitCode) => mainWindow?.webContents.send(IPC.ptyExit, { id: terminalId, exitCode }),
  () => store.getState().settings.idleDebounceMs
)

function allTerminals(): Terminal[] {
  return store.getState().workspaces.flatMap((w) => w.terminals)
}

function findTerminal(terminalId: string): { workspace: Workspace; terminal: Terminal } | null {
  for (const workspace of store.getState().workspaces) {
    const terminal = workspace.terminals.find((t) => t.id === terminalId)
    if (terminal) return { workspace, terminal }
  }
  return null
}

function samePath(a: string, b: string): boolean {
  return join(a).toLowerCase() === join(b).toLowerCase()
}

const hookServer = new HookServer((payload) => {
  mainWindow?.webContents.send(IPC.hookEventReceived, {
    hookEventName: payload.hookEventName,
    receivedAt: Date.now()
  })

  const terminal = allTerminals().find((t) => samePath(t.projectPath, payload.projectPath))
  if (!terminal) return

  if (payload.hookEventName === 'Notification') {
    statusManager.markWaiting(terminal.id)
    bumpUnread(terminal.id)
    maybeNotify(terminal, payload.message ?? 'Claude is waiting for your input')
  } else if (payload.hookEventName === 'Stop' || payload.hookEventName === 'SubagentStop') {
    statusManager.markIdle(terminal.id)
  }
})
const gitPoller = new GitBranchPoller(
  // Only poll terminals whose pane is actually open (pty running) — panes are lazy, so sidebar
  // entries without a mounted pane shouldn't trigger git subprocesses every few seconds.
  () =>
    allTerminals()
      .filter((t) => ptyManager.has(t.id))
      .map((t) => ({ id: t.id, path: t.projectPath })),
  (terminalId, branch) => mainWindow?.webContents.send(IPC.gitBranchChanged, { id: terminalId, branch })
)
const updater = new Updater((status) => mainWindow?.webContents.send(IPC.appUpdateStatus, status))

const unreadCounts = new Map<string, number>()

function bumpUnread(terminalId: string): void {
  unreadCounts.set(terminalId, (unreadCounts.get(terminalId) ?? 0) + 1)
  mainWindow?.webContents.send(IPC.statusChanged, {
    id: terminalId,
    status: statusManager.get(terminalId),
    unreadCount: unreadCounts.get(terminalId)
  })
}

function maybeNotify(terminal: Terminal, body: string): void {
  if (!store.getState().settings.notificationsEnabled) return
  if (!Notification.isSupported()) return
  if (mainWindow?.isFocused()) return
  const notification = new Notification({
    title: `${terminal.name} needs your input`,
    body,
    silent: false
  })
  notification.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
    mainWindow?.webContents.send(IPC.terminalFocusRequest, terminal.id)
  })
  notification.show()
}

statusManager.onChange((terminalId, status) => {
  mainWindow?.webContents.send(IPC.statusChanged, {
    id: terminalId,
    status,
    unreadCount: unreadCounts.get(terminalId) ?? 0
  })
})

// The origin our own renderer is ever legitimately loaded from — either the Vite dev server or
// the packaged index.html. Anything a window tries to navigate to that isn't this exact prefix
// is untrusted content (e.g. a link clicked inside a previewed Markdown/HTML file) and must not
// be allowed to load in-place, since our preload script re-injects on every navigation and
// exposes a privileged API (spawn shells, read arbitrary files) via contextBridge.
const APP_URL_PREFIX =
  is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href

function guardNavigation(webContents: Electron.WebContents): void {
  webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(APP_URL_PREFIX)) return
    event.preventDefault()
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
  })
}

function createWindow(): void {
  const bounds = store.getState().settings.windowBounds
  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1400,
    height: bounds?.height ?? 900,
    x: bounds?.x,
    y: bounds?.y,
    show: false,
    backgroundColor: '#1e1e1e',
    title: 'ittop',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  // No application menu exists on Windows/Linux (removed in whenReady), so no menu bar is
  // attached to this window and Alt can never reveal one.
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (bounds?.maximized) mainWindow?.maximize()
  })

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[renderer] did-fail-load ${errorCode} ${errorDescription}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] render-process-gone', details)
  })
  if (is.dev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.on('close', (event) => {
    if (!mainWindow) return
    const maximized = mainWindow.isMaximized()
    // getBounds() while maximized returns the maximized size, not the restorable windowed
    // size — save the pre-maximize bounds instead so un-maximizing later isn't full-screen.
    const { x, y, width, height } = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    persistSettings({ windowBounds: { x, y, width, height, maximized } })

    if (!isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  guardNavigation(mainWindow.webContents)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createPreviewWindow(filePath: string): void {
  const previewWindow = new BrowserWindow({
    width: 900,
    height: 800,
    backgroundColor: '#1e1e1e',
    title: `ittop: ${filePath}`,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  previewWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  guardNavigation(previewWindow.webContents)

  const query = `preview=${encodeURIComponent(filePath)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    previewWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${query}`)
  } else {
    previewWindow.loadFile(join(__dirname, '../renderer/index.html'), { search: query })
  }
}

function persistSettings(patch: Partial<ReturnType<Store['getState']>['settings']>): void {
  const state = store.getState()
  store.save({ ...state, settings: { ...state.settings, ...patch } })
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.workspacesGet, () => {
    const state = store.getState()
    const runtime: Record<string, { status: string; unreadCount: number; ptyStarted: boolean }> = {}
    for (const terminal of allTerminals()) {
      runtime[terminal.id] = {
        status: statusManager.get(terminal.id),
        unreadCount: unreadCounts.get(terminal.id) ?? 0,
        ptyStarted: ptyManager.has(terminal.id)
      }
    }
    return { workspaces: state.workspaces, settings: state.settings, runtime }
  })

  ipcMain.handle(IPC.terminalPickFolder, async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Pick a script file (bat/cmd/ps1/sh/…) to use as a terminal's F5 run script. The chosen
  // absolute path is what gets stored — the pty starts in the project folder, and shells
  // resolve relative names against that, but an absolute path is always unambiguous.
  ipcMain.handle(IPC.terminalPickScript, async (_event, startFolder?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Select run script',
      defaultPath: startFolder || undefined,
      filters: [
        { name: 'Scripts', extensions: ['bat', 'cmd', 'ps1', 'psm1', 'sh', 'ps1', 'mjs', 'cjs', 'js', 'ts', 'py'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.workspaceCreate, (_event, input: CreateWorkspaceInput) => {
    const state = store.getState()
    const workspace: Workspace = {
      id: uuidv4(),
      name: input.name,
      order: state.workspaces.length,
      terminals: []
    }
    store.save({ ...state, workspaces: [...state.workspaces, workspace] })
    return workspace
  })

  ipcMain.handle(IPC.workspaceRename, (_event, workspaceId: string, name: string) => {
    const state = store.getState()
    const workspaces = state.workspaces.map((w) => (w.id === workspaceId ? { ...w, name } : w))
    store.save({ ...state, workspaces })
  })

  ipcMain.handle(IPC.workspaceReorder, (_event, orderedIds: string[]) => {
    const state = store.getState()
    const byId = new Map(state.workspaces.map((w) => [w.id, w]))
    const workspaces = orderedIds
      .map((id, index) => {
        const w = byId.get(id)
        return w ? { ...w, order: index } : null
      })
      .filter((w): w is Workspace => w !== null)
    store.save({ ...state, workspaces })
  })

  ipcMain.handle(IPC.workspaceDelete, async (_event, workspaceId: string) => {
    const state = store.getState()
    const workspace = state.workspaces.find((w) => w.id === workspaceId)
    if (workspace) {
      await Promise.all(workspace.terminals.map((t) => ptyManager.stop(t.id)))
      for (const t of workspace.terminals) {
        statusManager.remove(t.id)
        unreadCounts.delete(t.id)
        gitPoller.forget(t.id)
      }
    }
    const workspaces = state.workspaces.filter((w) => w.id !== workspaceId)
    const settings = { ...state.settings }
    if (settings.activeWorkspaceId === workspaceId) settings.activeWorkspaceId = null
    store.save({ ...state, workspaces, settings })
  })

  ipcMain.handle(IPC.terminalCreate, (_event, input: CreateTerminalInput) => {
    const state = store.getState()
    const workspace = state.workspaces.find((w) => w.id === input.workspaceId)
    if (!workspace) return null
    const terminal: Terminal = {
      id: uuidv4(),
      name: input.name,
      projectPath: input.projectPath,
      startCommand: input.startCommand?.trim() || state.settings.defaultStartCommand || 'claude',
      autoRunCommand: input.autoRunCommand ?? false,
      runCommand: input.runCommand?.trim() ?? '',
      order: workspace.terminals.length
    }
    const workspaces = state.workspaces.map((w) =>
      w.id === workspace.id ? { ...w, terminals: [...w.terminals, terminal] } : w
    )
    store.save({ ...state, workspaces })
    return terminal
  })

  ipcMain.handle(IPC.terminalRename, (_event, terminalId: string, name: string) => {
    const state = store.getState()
    const workspaces = state.workspaces.map((w) => ({
      ...w,
      terminals: w.terminals.map((t) => (t.id === terminalId ? { ...t, name } : t))
    }))
    store.save({ ...state, workspaces })
  })

  ipcMain.handle(IPC.terminalUpdate, (_event, terminalId: string, input: UpdateTerminalInput) => {
    const state = store.getState()
    const workspaces = state.workspaces.map((w) => ({
      ...w,
      terminals: w.terminals.map((t) =>
        t.id === terminalId
          ? {
              ...t,
              name: input.name,
              projectPath: input.projectPath,
              startCommand: input.startCommand,
              autoRunCommand: input.autoRunCommand,
              runCommand: input.runCommand
            }
          : t
      )
    }))
    store.save({ ...state, workspaces })
  })

  ipcMain.handle(IPC.terminalReorder, (_event, workspaceId: string, orderedTerminalIds: string[]) => {
    const state = store.getState()
    const workspaces = state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w
      const byId = new Map(w.terminals.map((t) => [t.id, t]))
      const terminals = orderedTerminalIds
        .map((id, index) => {
          const t = byId.get(id)
          return t ? { ...t, order: index } : null
        })
        .filter((t): t is Terminal => t !== null)
      return { ...w, terminals }
    })
    store.save({ ...state, workspaces })
  })

  ipcMain.handle(IPC.terminalDelete, async (_event, terminalId: string) => {
    await ptyManager.stop(terminalId)
    statusManager.remove(terminalId)
    unreadCounts.delete(terminalId)
    gitPoller.forget(terminalId)
    const state = store.getState()
    const workspaces = state.workspaces.map((w) => ({
      ...w,
      terminals: w.terminals.filter((t) => t.id !== terminalId)
    }))
    store.save({ ...state, workspaces })
  })

  ipcMain.handle(IPC.terminalRestart, async (_event, terminalId: string) => {
    await ptyManager.stop(terminalId)
    statusManager.markIdle(terminalId)
  })

  // Native, modal confirmation before closing a pane with a live session — like Notepad's
  // "unsaved changes" prompt that blocks closing the window until you choose. Only sessions
  // that are actually doing something (working / waiting on the agent) trigger it; an idle
  // shell or a session that already exited closes without asking. The Settings toggle
  // (confirmCloseActivePane) switches the prompt off entirely.
  ipcMain.handle(IPC.terminalConfirmClosePane, async (_event, terminalId: string) => {
    if (!store.getState().settings.confirmCloseActivePane) return { ok: true }
    if (!mainWindow) return { ok: true }
    if (!ptyManager.has(terminalId)) return { ok: true }
    const status = statusManager.get(terminalId)
    if (status === 'idle') return { ok: true }
    const terminal = allTerminals().find((t) => t.id === terminalId)
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Stop session', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Session still active',
      message: `The session in ${terminal?.name ?? 'this terminal'} is still active.`,
      detail: 'Stopping it will end the running program. You can reopen the pane later, but the session will not resume.'
    })
    return { ok: response === 0 }
  })

  ipcMain.handle(IPC.terminalMarkRead, (_event, terminalId: string) => {
    unreadCounts.set(terminalId, 0)
    mainWindow?.webContents.send(IPC.statusChanged, {
      id: terminalId,
      status: statusManager.get(terminalId),
      unreadCount: 0
    })
  })

  ipcMain.handle(IPC.workspacesExport, async (): Promise<ExportResult> => {
    if (!mainWindow) return { ok: false, reason: 'error', message: 'No window available.' }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export workspaces',
      defaultPath: join(app.getPath('documents'), 'ittop-workspaces.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, reason: 'cancelled' }
    try {
      const state = store.getState()
      // version 3: nested workspaces (each carrying its terminals) plus the restorable
      // preference subset (never window/layout/session state — see RestorableSettings) so a
      // full export/import round-trip can bring those back too, opt-in.
      const payload = {
        version: 3,
        workspaces: state.workspaces,
        settings: {
          theme: state.settings.theme,
          notificationsEnabled: state.settings.notificationsEnabled,
          defaultStartCommand: state.settings.defaultStartCommand,
          idleDebounceMs: state.settings.idleDebounceMs,
          autoFocusRowZoom: state.settings.autoFocusRowZoom
        } satisfies RestorableSettings
      }
      writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf-8')
      return { ok: true, path: result.filePath }
    } catch (err) {
      return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  })

  // Import is a two-step prepare/commit flow so the renderer can show the user exactly what
  // each imported workspace and its terminals will run before anything is added — importing a
  // config someone else wrote otherwise auto-runs their chosen shell commands with no visibility.
  ipcMain.handle(IPC.workspacesImportPrepare, async (): Promise<ImportPrepareResult> => {
    if (!mainWindow) return { ok: false, reason: 'error', message: 'No window available.' }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import workspaces',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, reason: 'cancelled' }
    try {
      const raw = JSON.parse(readFileSync(result.filePaths[0], 'utf-8')) as {
        workspaces?: unknown
        settings?: unknown
      }
      if (!Array.isArray(raw.workspaces)) {
        return { ok: false, reason: 'error', message: 'File has no "workspaces" array.' }
      }
      const state = store.getState()
      const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined)
      const defaultCmd = state.settings.defaultStartCommand || 'claude'

      const entries: ImportPreviewEntry[] = raw.workspaces
        .filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null)
        .map((w) => {
          const name = asString(w.name) || 'Imported workspace'
          // Pre-2.0 export format: the workspace itself carried one projectPath/startCommand.
          if (Array.isArray(w.terminals)) {
            const terminals = (w.terminals as unknown[])
              .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
              .map((t) => asString(t.projectPath) && { t, path: asString(t.projectPath) as string })
              .filter((x): x is { t: Record<string, unknown>; path: string } => !!x)
              .map(({ t, path }) => ({
                name: asString(t.name) || 'Terminal',
                projectPath: path,
                startCommand: asString(t.startCommand) || defaultCmd,
                autoRunCommand: typeof t.autoRunCommand === 'boolean' ? (t.autoRunCommand as boolean) : undefined,
                runCommand: asString(t.runCommand) || undefined
              }))
            return terminals.length > 0 ? { name, terminals } : null
          }
          const projectPath = asString(w.projectPath)
          if (!projectPath) return null
          return {
            name,
            terminals: [{ name, projectPath, startCommand: asString(w.startCommand) || defaultCmd }]
          }
        })
        .filter((e): e is ImportPreviewEntry => e !== null)

      if (entries.length === 0) {
        return { ok: false, reason: 'error', message: 'No valid workspace entries found in file.' }
      }

      let settings: RestorableSettings | null = null
      if (typeof raw.settings === 'object' && raw.settings !== null) {
        const s = raw.settings as Record<string, unknown>
        const theme = s.theme
        if (
          (theme === 'dark' ||
            theme === 'light' ||
            theme === 'dracula' ||
            theme === 'nord' ||
            theme === 'solarized') &&
          typeof s.notificationsEnabled === 'boolean' &&
          typeof s.defaultStartCommand === 'string' &&
          typeof s.idleDebounceMs === 'number'
        ) {
          settings = {
            theme,
            notificationsEnabled: s.notificationsEnabled,
            defaultStartCommand: s.defaultStartCommand,
            idleDebounceMs: s.idleDebounceMs,
            // Older exports predate the toggle; keep their behavior (zoom on) by defaulting.
            autoFocusRowZoom: typeof s.autoFocusRowZoom === 'boolean' ? s.autoFocusRowZoom : true
          }
        }
      }

      return { ok: true, entries, settings }
    } catch (err) {
      return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.workspacesImportCommit, (_event, input: ImportCommitInput): ImportCommitResult => {
    try {
      const state = store.getState()
      const imported: Workspace[] = input.entries.map((entry, i) => ({
        id: uuidv4(),
        name: entry.name,
        order: state.workspaces.length + i,
        terminals: entry.terminals.map((t, ti) => ({
          id: uuidv4(),
          name: t.name,
          projectPath: t.projectPath,
          startCommand: t.startCommand,
          autoRunCommand: typeof t.autoRunCommand === 'boolean' ? t.autoRunCommand : true,
          runCommand: t.runCommand ?? '',
          order: ti
        }))
      }))
      const settings = input.settings ? { ...state.settings, ...input.settings } : state.settings
      store.save({ ...state, workspaces: [...state.workspaces, ...imported], settings })
      return { ok: true, count: imported.length }
    } catch (err) {
      return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  })

  const FILE_PREVIEW_MAX_BYTES = 512 * 1024

  ipcMain.handle(IPC.fsListDir, async (_event, dirPath: string): Promise<ListDirResult> => {
    try {
      const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
      const mapped: FileEntry[] = entries.map((entry) => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        isDirectory: entry.isDirectory()
      }))
      mapped.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return { ok: true, entries: mapped }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.fsReadFile, async (_event, filePath: string): Promise<ReadFileResult> => {
    let handle: Awaited<ReturnType<typeof fsPromises.open>> | null = null
    try {
      const stat = await fsPromises.stat(filePath)
      handle = await fsPromises.open(filePath, 'r')
      const readLength = Math.min(stat.size, FILE_PREVIEW_MAX_BYTES)
      const buffer = Buffer.alloc(readLength)
      await handle.read(buffer, 0, readLength, 0)
      // A NUL byte anywhere in a reasonable-sized sample is a reliable enough signal that this
      // is a binary file (image, archive, compiled binary, ...) not meant to be shown as text.
      if (buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0)) {
        return { ok: false, reason: 'binary' }
      }
      return { ok: true, content: buffer.toString('utf-8'), truncated: stat.size > FILE_PREVIEW_MAX_BYTES }
    } catch (err) {
      return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
    } finally {
      await handle?.close()
    }
  })

  ipcMain.handle(IPC.settingsGet, () => store.getState().settings)

  ipcMain.handle(IPC.settingsUpdate, (_event, patch: Record<string, unknown>) => {
    persistSettings(patch)
  })

  ipcMain.handle(IPC.ptyStart, (_event, terminalId: string, cols: number, rows: number) => {
    const found = findTerminal(terminalId)
    if (!found) return
    // autoRunCommand === false means "open a plain shell, don't type the start command" — the
    // user runs it manually when they're ready. Explicit-false test keeps legacy/imported
    // terminals (no flag) on their old always-auto-run behavior.
    const command = found.terminal.autoRunCommand === false ? '' : found.terminal.startCommand
    ptyManager.start(terminalId, found.terminal.projectPath, command, cols, rows)
    unreadCounts.set(terminalId, 0)
    // The pane just opened — fetch this terminal's branch once right away instead of waiting
    // for the next poll tick, and cache it so subsequent ticks only fire on real changes.
    void gitPoller.refreshTerminal(terminalId)
  })

  ipcMain.on(IPC.ptyInput, (_event, terminalId: string, data: string) => {
    ptyManager.write(terminalId, data)
  })

  // F5 "run script": run the terminal's configured runCommand (e.g. a .bat) as an EXTERNAL
  // child process — never inside the terminal pty. The pty usually holds a running coding
  // agent session; typing a command into it would hand the command to that agent instead of
  // the shell. The script runs in its own process rooted at the terminal's project folder;
  // .bat/.cmd via cmd /c, .ps1 via powershell -File, everything else through the default
  // shell. Output does not appear in the app — success/failure is reported back to the
  // renderer for a toast.
  ipcMain.handle(IPC.terminalRunScript, (_event, terminalId: string) => {
    const found = findTerminal(terminalId)
    const script = found?.terminal.runCommand?.trim() ?? ''
    if (!found || script.length === 0) return { ok: false, message: 'No run script set for this terminal.' }

    const cwd = found.terminal.projectPath
    if (!existsSync(cwd)) return { ok: false, message: `Project folder does not exist: ${cwd}` }

    // Resolve a relative script name against the project folder.
    const resolved = isAbsolute(script) ? script : join(cwd, script)
    if (!existsSync(resolved)) return { ok: false, message: `Script not found: ${resolved}` }

    let command: string
    let args: string[]
    if (process.platform === 'win32') {
      const ext = extname(resolved).toLowerCase()
      if (ext === '.ps1') {
        command = 'powershell.exe'
        args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved]
      } else {
        // Pass the path RAW as its own argument: Windows child_process builds the final
        // command line itself and quotes space-containing args correctly. Pre-quoting here
        // (empirically verified) makes cmd treat the quotes as part of the file name and
        // fail with "not recognized as an internal or external command".
        command = 'cmd.exe'
        args = ['/c', resolved]
      }
    } else {
      // POSIX: the whole command is one shell string, so single-quote the path (the
      // standard escape used for shell injection).
      const shQuoted = `'${resolved.replace(/'/g, `'\\''`)}'`
      command = process.env.SHELL ?? 'sh'
      args = ['-c', shQuoted]
    }

    return new Promise<{ ok: boolean; message: string }>((resolve) => {
      const proc = spawn(command, args, { cwd, stdio: 'ignore', windowsHide: true })
      let settled = false
      const settle = (ok: boolean, message: string): void => {
        if (settled) return
        settled = true
        resolve({ ok, message })
      }
      const failTimer = setTimeout(() => {
        // Long-running build: give up waiting for exit, report as launched.
        settle(true, `${script} is still running in the background.`)
      }, 10_000)
      proc.on('error', (err) => {
        clearTimeout(failTimer)
        settle(false, `Failed to start ${script}: ${err.message}`)
      })
      proc.on('close', (code) => {
        clearTimeout(failTimer)
        if (code === 0) settle(true, `${script} finished successfully.`)
        else settle(false, `${script} exited with code ${code}.`)
      })
    })
  })

  ipcMain.on(IPC.ptyResize, (_event, terminalId: string, cols: number, rows: number) => {
    ptyManager.resize(terminalId, cols, rows)
  })

  ipcMain.handle(IPC.hookServerInfo, () => ({ port: HOOK_SERVER_PORT }))

  ipcMain.handle(IPC.previewOpen, (_event, filePath: string) => {
    createPreviewWindow(filePath)
  })

  // Reveal a path in the OS file manager. Directories open in Explorer; files open their
  // containing folder with the file selected — shell.openPath on a file would launch its
  // default handler, which is wrong for "show me where this file is". shell.openPath resolves
  // after the manager launches and returns '' on success, otherwise an error message.
  ipcMain.handle(IPC.fsReveal, async (_event, targetPath: string) => {
    try {
      const st = await fsPromises.stat(targetPath)
      if (st.isFile()) {
        shell.showItemInFolder(targetPath)
        return
      }
    } catch {
      // stat failed (deleted / disconnected network path) — fall through to opening directly
    }
    const error = await shell.openPath(targetPath)
    if (error) console.error(`openPath(${targetPath}) failed: ${error}`)
  })

  // Open an INDEPENDENT PowerShell window rooted at folderPath (Windows only). A bare
  // spawn of powershell.exe inherits no console and its NUL stdin makes PowerShell exit
  // immediately — `cmd /c start` instead allocates a brand-new console window for it, and
  // the new window inherits cmd's cwd so the prompt starts in folderPath. -NoExit keeps the
  // session open no matter how stdio is wired up.
  ipcMain.handle(IPC.fsOpenPowerShell, (_event, folderPath: string) => {
    if (process.platform !== 'win32') {
      console.warn(`fs:openPowerShell is only supported on Windows (requested for ${folderPath})`)
      return
    }
    try {
      const proc = spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit'], {
        cwd: folderPath,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      })
      proc.on('error', (err) => console.error(`powershell spawn failed: ${err.message}`))
      proc.unref()
    } catch (err) {
      console.error(`powershell spawn failed for ${folderPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // Open the folder in Visual Studio Code. Prefer known install locations so it works even
  // when the `code` CLI isn't on PATH; fall back to the `code` launcher (which on Windows is
  // code.cmd and therefore needs a shell).
  ipcMain.handle(IPC.fsOpenVSCode, (_event, folderPath: string) => {
    const candidates: string[] = []
    if (process.platform === 'win32') {
      const local = process.env['LOCALAPPDATA']
      const pf = process.env['ProgramFiles']
      const pfx86 = process.env['ProgramFiles(x86)']
      if (local) {
        candidates.push(join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'))
        candidates.push(join(local, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'))
      }
      if (pf) candidates.push(join(pf, 'Microsoft VS Code', 'Code.exe'))
      if (pfx86) candidates.push(join(pfx86, 'Microsoft VS Code', 'Code.exe'))
    } else if (process.platform === 'darwin') {
      candidates.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')
      const home = process.env['HOME']
      if (home) {
        candidates.push(
          join(home, 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code')
        )
      }
    } else {
      candidates.push('/snap/bin/code', '/usr/share/code/bin/code', '/usr/bin/code')
    }
    const executable = candidates.find((c) => existsSync(c)) ?? null
    try {
      const proc = spawn(executable ?? 'code', [folderPath], {
        detached: true,
        stdio: 'ignore',
        shell: process.platform === 'win32' && !executable
      })
      proc.on('error', (err) => console.error(`vscode spawn failed: ${err.message}`))
      proc.unref()
    } catch (err) {
      console.error(`vscode spawn failed for ${folderPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())
  ipcMain.handle(IPC.appCheckForUpdates, () => updater.checkForUpdates())
  ipcMain.handle(IPC.appInstallUpdate, () => updater.installUpdate())

  // Run a user-configured external tool (Settings → External tools) against a terminal's project
  // directory. The configured command is a free-form shell line — spawned through a shell so
  // PATH lookups and .cmd launchers like `code` work. The directory is appended as the final
  // argument, or substituted in place wherever the command contains the `{path}` placeholder.
  ipcMain.handle(IPC.toolsRunExternal, (_event, toolId: string, directory: string) => {
    const tool = store.getState().settings.externalTools.find((t) => t.id === toolId)
    if (!tool || !tool.command.trim()) return
    const quotedDir = `"${directory}"`
    const commandLine = tool.command.includes('{path}')
      ? tool.command.replaceAll('{path}', quotedDir)
      : `${tool.command} ${quotedDir}`
    try {
      const proc = spawn(commandLine, {
        cwd: directory,
        detached: true,
        stdio: 'ignore',
        shell: true,
        windowsHide: false
      })
      proc.on('error', (err) => console.error(`external tool "${tool.title}" failed: ${err.message}`))
      proc.unref()
    } catch (err) {
      console.error(
        `external tool "${tool.title}" failed for ${directory}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.ittop.app')

  // No native menu bar on Windows/Linux: setMenuBarVisibility(false) only hides it visually,
  // and the single Alt key would still pop the hidden menu bar up. Removing the application
  // menu entirely leaves nothing for Alt to reveal, so Alt falls through to the app/renderer.
  // (macOS keeps its app menu — Cmd+C/V and friends live there, and Alt isn't used to open it.)
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }

  // Third-party dictation tools (Wispr Flow, Spokenly, Windows Voice Access, ...) typically
  // inject recognized text via the OS accessibility tree rather than simulated keystrokes.
  // Chromium/Electron only builds that tree lazily once an AT client is detected; forcing it
  // on lets those tools see and target the terminal's focused input element.
  app.setAccessibilitySupportEnabled(true)

  // Only enforce a strict CSP in production: electron-vite's dev server injects inline
  // scripts for HMR/React-refresh that a strict script-src would otherwise block.
  if (!is.dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"]
        }
      })
    })
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  hookServer.start()
  gitPoller.start()
  createWindow()
  createTray()

  // Silent background check a few seconds after launch — errors/no-update states are only
  // surfaced when the user opens Settings themselves, this just gets the "update available"
  // notice in front of them without requiring a manual click every time.
  setTimeout(() => void updater.checkForUpdates(), 5000)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      mainWindow?.show()
      mainWindow?.focus()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', async (event) => {
  isQuitting = true
  if (quitting) return
  event.preventDefault()
  quitting = true
  gitPoller.stop()
  hookServer.stop()
  await ptyManager.stopAll()
  app.quit()
})
