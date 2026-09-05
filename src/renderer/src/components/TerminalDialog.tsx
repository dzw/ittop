import { useState } from 'react'
import type { Terminal } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'

interface Props {
  workspaceId: string
  /** When provided the dialog edits this terminal instead of creating a new one. */
  terminal?: Terminal
  onClose: () => void
}

export default function TerminalDialog({ workspaceId, terminal, onClose }: Props): React.JSX.Element {
  const addTerminal = useAppStore((s) => s.addTerminal)
  const updateTerminal = useAppStore((s) => s.updateTerminal)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const defaultStartCommand = useAppStore((s) => s.settings.defaultStartCommand)
  const runtime = useAppStore((s) => s.runtime)
  const ptyStarted = terminal ? (runtime[terminal.id]?.ptyStarted ?? false) : false
  const [name, setName] = useState(terminal?.name ?? '')
  const [projectPath, setProjectPath] = useState(terminal?.projectPath ?? '')
  const [startCommand, setStartCommand] = useState(terminal?.startCommand ?? defaultStartCommand)
  const [autoRun, setAutoRun] = useState(terminal?.autoRunCommand ?? false)
  const [error, setError] = useState<string | null>(null)

  async function pickFolder(): Promise<void> {
    const folder = await window.api.pickFolder()
    if (!folder) return
    setProjectPath(folder)
    if (!name.trim()) {
      const parts = folder.split(/[\\/]/).filter(Boolean)
      setName(parts[parts.length - 1] ?? folder)
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!projectPath.trim()) {
      setError('Project folder is required.')
      return
    }
    if (terminal) {
      updateTerminal(workspaceId, terminal.id, {
        name: name.trim() || 'Terminal',
        projectPath: projectPath.trim(),
        startCommand: startCommand.trim() || defaultStartCommand,
        autoRunCommand: autoRun
      })
    } else {
      const created = await window.api.createTerminal({
        workspaceId,
        name: name.trim() || 'Terminal',
        projectPath: projectPath.trim(),
        startCommand: startCommand.trim() || defaultStartCommand,
        autoRunCommand: autoRun
      })
      if (!created) {
        setError('Could not add terminal — the workspace may have been deleted.')
        return
      }
      addTerminal(workspaceId, created)
      openWorkspace(workspaceId)
    }
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{terminal ? `Edit ${terminal.name}` : 'New terminal'}</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Frontend" />
        </label>
        <label>
          Project folder
          <div className="folder-row">
            <input
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder="C:\path\to\project"
            />
            <button onClick={() => void pickFolder()}>Browse…</button>
          </div>
        </label>
        <label>
          Start command
          <input value={startCommand} onChange={(e) => setStartCommand(e.target.value)} placeholder="claude" />
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
          Run the start command automatically when this terminal opens
        </label>
        {!autoRun && (
          <p className="modal-hint">
            Unchecked: the terminal opens a plain shell and the start command is left for you to run manually.
          </p>
        )}
        {ptyStarted && (
          <p className="modal-hint">This terminal has a running session — the changes apply the next time it starts.</p>
        )}
        {error && <div className="error-text">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void handleSubmit()}>
            {terminal ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}
