import { create } from 'zustand'
import type {
  AppSettings,
  Terminal,
  TerminalRuntimeState,
  TerminalStatus,
  UpdateTerminalInput,
  Workspace
} from '../../../shared/types'

interface AppState {
  loaded: boolean
  workspaces: Workspace[]
  runtime: Record<string, TerminalRuntimeState>
  gitBranches: Record<string, string | null>
  settings: AppSettings
  openedWorkspaceIds: Set<string>
  /** Terminals whose pane has been created (clicked once). Panes are lazy: opening a
   * workspace only creates the panes the user has actually opened by clicking their item. */
  createdPaneIds: Set<string>
  focusedTerminalId: string | null
  previews: Record<string, string>
  previewUpdatedAt: Record<string, number>
  hookServerPort: number | null
  lastHookEventAt: number | null
  settingsModalOpen: boolean

  load: () => Promise<void>
  reloadWorkspaces: () => Promise<void>
  addWorkspace: (workspace: Workspace) => void
  renameWorkspace: (id: string, name: string) => void
  removeWorkspace: (id: string) => void
  reorderWorkspaces: (orderedIds: string[]) => void
  openWorkspace: (id: string) => void
  closeWorkspace: (id: string) => void

  addTerminal: (workspaceId: string, terminal: Terminal) => void
  updateTerminal: (workspaceId: string, terminalId: string, patch: UpdateTerminalInput) => void
  renameTerminal: (workspaceId: string, terminalId: string, name: string) => void
  removeTerminal: (workspaceId: string, terminalId: string) => void
  /** Closes a terminal's pane without deleting the terminal: stops its pty session, unmounts
   * the pane (dropping scrollback), and prunes its runtime state. Reopening re-runs ptyStart. */
  closePane: (terminalId: string) => void
  reorderTerminals: (workspaceId: string, orderedTerminalIds: string[]) => void
  focusTerminal: (terminalId: string) => void

  setSidebarWidth: (width: number) => void
  setFilePanelWidth: (width: number) => void
  toggleSidebarCollapsed: () => void
  setStatus: (id: string, status: TerminalStatus, unreadCount: number) => void
  setGitBranch: (id: string, branch: string | null) => void
  markPtyStarted: (id: string) => void
  setPreview: (id: string, text: string) => void
  setHookServerPort: (port: number) => void
  markHookEventReceived: (timestamp: number) => void
  updateAppSettings: (patch: Partial<AppSettings>) => void
  setSettingsModalOpen: (open: boolean) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  loaded: false,
  workspaces: [],
  runtime: {},
  gitBranches: {},
  settings: {
    sidebarWidth: 280,
    sidebarCollapsed: false,
    filePanelWidth: 340,
    activeWorkspaceId: null,
    theme: 'dark',
    notificationsEnabled: true,
    defaultStartCommand: 'claude',
    idleDebounceMs: 1200,
    paneColFractions: [],
    paneRowFractions: [],
    autoFocusRowZoom: true,
    externalTools: []
  },
  openedWorkspaceIds: new Set(),
  createdPaneIds: new Set(),
  focusedTerminalId: null,
  previews: {},
  previewUpdatedAt: {},
  hookServerPort: null,
  lastHookEventAt: null,
  settingsModalOpen: false,

  load: async () => {
    const [result, hookInfo] = await Promise.all([window.api.getWorkspaces(), window.api.getHookServerInfo()])
    const sorted = [...result.workspaces].sort((a, b) => a.order - b.order)
    set({
      workspaces: sorted,
      runtime: result.runtime,
      settings: result.settings,
      hookServerPort: hookInfo.port,
      loaded: true
    })
  },

  reloadWorkspaces: async () => {
    const result = await window.api.getWorkspaces()
    const sorted = [...result.workspaces].sort((a, b) => a.order - b.order)
    set({ workspaces: sorted, runtime: result.runtime })
  },

  addWorkspace: (workspace) => set((state) => ({ workspaces: [...state.workspaces, workspace] })),

  renameWorkspace: (id, name) =>
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, name } : w))
    })),

  removeWorkspace: (id) =>
    set((state) => {
      const removedWorkspace = state.workspaces.find((w) => w.id === id)
      const workspaces = state.workspaces.filter((w) => w.id !== id)
      const settings = { ...state.settings }
      if (settings.activeWorkspaceId === id) {
        settings.activeWorkspaceId = workspaces[0]?.id ?? null
        void window.api.updateSettings({ activeWorkspaceId: settings.activeWorkspaceId })
      }
      const openedWorkspaceIds = new Set(state.openedWorkspaceIds)
      openedWorkspaceIds.delete(id)
      const createdPaneIds = new Set(state.createdPaneIds)
      for (const t of removedWorkspace?.terminals ?? []) createdPaneIds.delete(t.id)
      const terminalMaps = pruneTerminalMaps(state, removedWorkspace?.terminals.map((t) => t.id) ?? [])
      return { workspaces, settings, openedWorkspaceIds, createdPaneIds, ...terminalMaps }
    }),

  reorderWorkspaces: (orderedIds) => {
    void window.api.reorderWorkspaces(orderedIds)
    set((state) => {
      const byId = new Map(state.workspaces.map((w) => [w.id, w]))
      const workspaces = orderedIds
        .map((id, index) => {
          const w = byId.get(id)
          return w ? { ...w, order: index } : null
        })
        .filter((w): w is Workspace => w !== null)
      return { workspaces }
    })
  },

  // Opening a workspace mounts (and lazily starts the ptys of) all of its terminals, tiled
  // together, and hides every other workspace's terminals — they keep running in the
  // background, mounted but invisible, so switching back doesn't lose scrollback or restart.
  openWorkspace: (id) => {
    void window.api.updateSettings({ activeWorkspaceId: id })
    // Most-recently-opened workspace floats to the top of the sidebar list (persisted
    // through the same reorder path as drag-and-drop, so the order survives restarts).
    const current = get().workspaces
    if (current.length > 0 && current[0].id !== id && current.some((w) => w.id === id)) {
      get().reorderWorkspaces([id, ...current.map((w) => w.id).filter((wid) => wid !== id)])
    }
    const workspace = get().workspaces.find((w) => w.id === id)
    set((state) => {
      // Keep whichever terminal was already focused if it belongs to this workspace (e.g.
      // switching back to a workspace you were already using); otherwise default to its first.
      const stillValid = workspace?.terminals.some((t) => t.id === state.focusedTerminalId)
      const focusedTerminalId = stillValid
        ? state.focusedTerminalId
        : ([...(workspace?.terminals ?? [])].sort((a, b) => a.order - b.order)[0]?.id ?? null)
      return {
        openedWorkspaceIds: new Set(state.openedWorkspaceIds).add(id),
        settings: { ...state.settings, activeWorkspaceId: id },
        focusedTerminalId
      }
    })
    if (workspace) {
      for (const terminal of workspace.terminals) void window.api.markTerminalRead(terminal.id)
    }
  },

  closeWorkspace: (id) => {
    const workspace = get().workspaces.find((w) => w.id === id)
    if (workspace) {
      for (const terminal of workspace.terminals) void window.api.restartTerminal(terminal.id)
    }
    set((state) => {
      const openedWorkspaceIds = new Set(state.openedWorkspaceIds)
      openedWorkspaceIds.delete(id)
      const settings = { ...state.settings }
      if (settings.activeWorkspaceId === id) {
        const remaining = state.workspaces.filter((w) => w.id !== id)
        settings.activeWorkspaceId = remaining[0]?.id ?? null
        void window.api.updateSettings({ activeWorkspaceId: settings.activeWorkspaceId })
      }
      return { openedWorkspaceIds, settings }
    })
  },

  addTerminal: (workspaceId, terminal) =>
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, terminals: [...w.terminals, terminal] } : w
      ),
      createdPaneIds: new Set(state.createdPaneIds).add(terminal.id)
    })),

  renameTerminal: (workspaceId, terminalId, name) => {
    void window.api.renameTerminal(terminalId, name)
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === workspaceId
          ? { ...w, terminals: w.terminals.map((t) => (t.id === terminalId ? { ...t, name } : t)) }
          : w
      )
    }))
  },

  updateTerminal: (workspaceId, terminalId, patch) => {
    void window.api.updateTerminal(terminalId, patch)
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === workspaceId
          ? { ...w, terminals: w.terminals.map((t) => (t.id === terminalId ? { ...t, ...patch } : t)) }
          : w
      )
    }))
  },

  removeTerminal: (workspaceId, terminalId) => {
    void window.api.deleteTerminal(terminalId)
    set((state) => {
      const createdPaneIds = new Set(state.createdPaneIds)
      createdPaneIds.delete(terminalId)
      return {
        workspaces: state.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, terminals: w.terminals.filter((t) => t.id !== terminalId) } : w
        ),
        createdPaneIds,
        ...pruneTerminalMaps(state, [terminalId])
      }
    })
  },

  reorderTerminals: (workspaceId, orderedTerminalIds) => {
    void window.api.reorderTerminals(workspaceId, orderedTerminalIds)
    set((state) => ({
      workspaces: state.workspaces.map((w) => {
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
    }))
  },

  // Closing a pane is not deleting a terminal: the terminal stays in its workspace (and in the
  // sidebar), only its session and mounted pane go away — the same teardown ptyStop does, plus
  // unmounting via createdPaneIds so a later reopen starts a fresh pty with fresh scrollback.
  closePane: (terminalId) => {
    void window.api.restartTerminal(terminalId)
    set((state) => {
      const createdPaneIds = new Set(state.createdPaneIds)
      createdPaneIds.delete(terminalId)
      const focusedTerminalId =
        state.focusedTerminalId === terminalId
          ? (state.workspaces
              .find((w) => w.terminals.some((t) => t.id === terminalId))
              ?.terminals.filter((t) => t.id !== terminalId && createdPaneIds.has(t.id))
              .sort((a, b) => a.order - b.order)[0]?.id ?? null)
          : state.focusedTerminalId
      return { createdPaneIds, focusedTerminalId, ...pruneTerminalMaps(state, [terminalId]) }
    })
  },

  // Typing directly into a pane (or a notification click) should make it — and its parent
  // workspace — the active one, even if you got there without clicking the sidebar first.
  focusTerminal: (terminalId) => {
    const workspace = get().workspaces.find((w) => w.terminals.some((t) => t.id === terminalId))
    if (!workspace) return
    get().openWorkspace(workspace.id)
    // Clicking a terminal item (sidebar row / notification / focus request) is what creates
    // its pane in the first place — nothing mounts until the user opens that terminal.
    set((state) => ({
      focusedTerminalId: terminalId,
      createdPaneIds: new Set(state.createdPaneIds).add(terminalId)
    }))
  },

  setSidebarWidth: (width) => {
    void window.api.updateSettings({ sidebarWidth: width })
    set((state) => ({ settings: { ...state.settings, sidebarWidth: width } }))
  },

  setFilePanelWidth: (width) => {
    void window.api.updateSettings({ filePanelWidth: width })
    set((state) => ({ settings: { ...state.settings, filePanelWidth: width } }))
  },

  toggleSidebarCollapsed: () => {
    const next = !get().settings.sidebarCollapsed
    void window.api.updateSettings({ sidebarCollapsed: next })
    set((state) => ({ settings: { ...state.settings, sidebarCollapsed: next } }))
  },

  setStatus: (id, status, unreadCount) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        [id]: { ...(state.runtime[id] ?? defaultRuntime()), status, unreadCount }
      }
    })),

  setGitBranch: (id, branch) => set((state) => ({ gitBranches: { ...state.gitBranches, [id]: branch } })),

  markPtyStarted: (id) => {
    const state = get()
    set({
      runtime: {
        ...state.runtime,
        [id]: { ...(state.runtime[id] ?? defaultRuntime()), ptyStarted: true }
      }
    })
  },

  setPreview: (id, text) =>
    set((state) => ({
      previews: { ...state.previews, [id]: text },
      previewUpdatedAt: { ...state.previewUpdatedAt, [id]: Date.now() }
    })),

  setHookServerPort: (port) => set({ hookServerPort: port }),

  markHookEventReceived: (timestamp) => set({ lastHookEventAt: timestamp }),

  updateAppSettings: (patch) => {
    void window.api.updateSettings(patch)
    set((state) => ({ settings: { ...state.settings, ...patch } }))
  },

  setSettingsModalOpen: (open) => set({ settingsModalOpen: open })
}))

function defaultRuntime(): TerminalRuntimeState {
  return { status: 'idle', unreadCount: 0, ptyStarted: false }
}

// Deleting a terminal (or a whole workspace, cascading to its terminals) must also drop its
// entries from every per-terminal map — otherwise these grow by a few keys per delete and are
// never reclaimed for the rest of the app's runtime, across however many terminals get created
// and deleted over a long session.
function pruneTerminalMaps(
  state: Pick<AppState, 'runtime' | 'gitBranches' | 'previews' | 'previewUpdatedAt'>,
  terminalIds: string[]
): Pick<AppState, 'runtime' | 'gitBranches' | 'previews' | 'previewUpdatedAt'> {
  if (terminalIds.length === 0) {
    return {
      runtime: state.runtime,
      gitBranches: state.gitBranches,
      previews: state.previews,
      previewUpdatedAt: state.previewUpdatedAt
    }
  }
  const remove = new Set(terminalIds)
  const omit = <T,>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !remove.has(id)))
  return {
    runtime: omit(state.runtime),
    gitBranches: omit(state.gitBranches),
    previews: omit(state.previews),
    previewUpdatedAt: omit(state.previewUpdatedAt)
  }
}
