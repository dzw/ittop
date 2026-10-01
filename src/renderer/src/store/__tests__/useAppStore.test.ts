import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../useAppStore'
import type { Terminal, Workspace } from '../../../../shared/types'

// The store's actions fire IPC through window.api; stub it so tests run in plain node
// without Electron (vitest's default environment has no window).
const apiStub = {
  updateSettings: vi.fn(async () => {}),
  reorderWorkspaces: vi.fn(async () => {}),
  markTerminalRead: vi.fn(async () => {}),
  renameTerminal: vi.fn(async () => {}),
  deleteTerminal: vi.fn(async () => {}),
  restartTerminal: vi.fn(async () => {})
}
vi.stubGlobal('window', { api: apiStub })

function terminal(id: string, order: number): Terminal {
  return {
    id,
    name: id,
    projectPath: '/tmp',
    startCommand: '',
    autoRunCommand: false,
    runCommand: '',
    buildCommand: '',
    order
  }
}

function workspace(id: string, order: number, terminals: Terminal[]): Workspace {
  return { id, name: id, order, terminals }
}

const wsA = workspace('ws-a', 0, [terminal('t-a1', 0), terminal('t-a2', 1)])
const wsB = workspace('ws-b', 1, [terminal('t-b1', 0)])

describe('restoreSession ("Restart sessions" after an app restart)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({
      workspaces: [wsA, wsB],
      openedWorkspaceIds: new Set(),
      createdPaneIds: new Set(),
      focusedTerminalId: null,
      settings: { ...useAppStore.getState().settings, activeWorkspaceId: null }
    })
  })

  it('recreates every pane of the last active workspace (a plain open would leave the grid empty)', () => {
    useAppStore.getState().restoreSession('ws-a')
    const state = useAppStore.getState()
    expect([...state.createdPaneIds].sort()).toEqual(['t-a1', 't-a2'])
    expect(state.openedWorkspaceIds.has('ws-a')).toBe(true)
    expect(state.settings.activeWorkspaceId).toBe('ws-a')
  })

  it('defaults focus to the first terminal so its session auto-starts on mount', () => {
    useAppStore.getState().restoreSession('ws-a')
    expect(useAppStore.getState().focusedTerminalId).toBe('t-a1')
  })

  it('keeps already-created panes instead of clobbering createdPaneIds', () => {
    useAppStore.setState({ createdPaneIds: new Set(['t-b1']) })
    useAppStore.getState().restoreSession('ws-a')
    expect([...useAppStore.getState().createdPaneIds].sort()).toEqual(['t-a1', 't-a2', 't-b1'])
  })

  it('plain openWorkspace still creates no panes — only restoreSession does', () => {
    useAppStore.getState().openWorkspace('ws-b')
    expect(useAppStore.getState().createdPaneIds.size).toBe(0)
  })

  it('ignores an unknown workspace id without throwing', () => {
    expect(() => useAppStore.getState().restoreSession('missing')).not.toThrow()
    expect(useAppStore.getState().createdPaneIds.size).toBe(0)
  })

  it('restores only the panes that were open at quit, not every terminal of the workspace', () => {
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, openPaneIds: ['t-a2'] } })
    useAppStore.getState().restoreSession('ws-a')
    expect([...useAppStore.getState().createdPaneIds]).toEqual(['t-a2'])
  })

  it('restores nothing when every pane had been closed before quitting', () => {
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, openPaneIds: [] } })
    useAppStore.getState().restoreSession('ws-a')
    expect(useAppStore.getState().createdPaneIds.size).toBe(0)
  })

  it('falls back to every terminal when no pane list was ever persisted', () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, openPaneIds: undefined }
    })
    useAppStore.getState().restoreSession('ws-a')
    expect([...useAppStore.getState().createdPaneIds].sort()).toEqual(['t-a1', 't-a2'])
  })
})

describe('openPaneIds persistence (what "Restart sessions" restores)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({
      workspaces: [wsA, wsB],
      openedWorkspaceIds: new Set(),
      createdPaneIds: new Set(),
      focusedTerminalId: null,
      settings: { ...useAppStore.getState().settings, activeWorkspaceId: null, openPaneIds: undefined }
    })
  })

  it('persists the pane list when a terminal is opened', () => {
    useAppStore.getState().focusTerminal('t-a1')
    expect(apiStub.updateSettings).toHaveBeenCalledWith({ openPaneIds: ['t-a1'] })
  })

  it('persists the shorter list when a pane is closed', () => {
    useAppStore.setState({ createdPaneIds: new Set(['t-a1', 't-a2']) })
    useAppStore.getState().closePane('t-a1')
    expect(apiStub.updateSettings).toHaveBeenCalledWith({ openPaneIds: ['t-a2'] })
  })

  it('drops ids of terminals that no longer exist', () => {
    useAppStore.setState({ createdPaneIds: new Set(['t-a1', 'gone']) })
    useAppStore.getState().focusTerminal('t-a1')
    expect(apiStub.updateSettings).toHaveBeenLastCalledWith({ openPaneIds: ['t-a1'] })
  })
})
