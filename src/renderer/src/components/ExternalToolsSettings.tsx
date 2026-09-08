import { v4 as uuidv4 } from 'uuid'
import type { ExternalTool } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'

// Settings page for the external tools that appear in terminal right-click menus (Workspaces
// sidebar items and terminal pane headers). Edits are committed straight into the settings store
// — the same immediate-persist pattern the sidebar width drag already uses.
export default function ExternalToolsSettings(): React.JSX.Element {
  const tools = useAppStore((s) => s.settings.externalTools)
  const updateAppSettings = useAppStore((s) => s.updateAppSettings)

  function commit(next: ExternalTool[]): void {
    updateAppSettings({ externalTools: next })
  }

  function updateTool(id: string, patch: Partial<ExternalTool>): void {
    commit(tools.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  return (
    <div className="external-tools">
      <p className="settings-update-status">
        External tools show up in a terminal&apos;s right-click menu (Workspaces list and pane
        header). Clicking one runs the command with the terminal&apos;s project folder appended as
        the last argument — or placed wherever you put <code>{'{path}'}</code> in the command.
      </p>
      {tools.map((tool) => (
        <div className="external-tool-row" key={tool.id}>
          <input
            className="external-tool-title"
            value={tool.title}
            placeholder="Menu title"
            title="Title shown in the right-click menu"
            onChange={(e) => updateTool(tool.id, { title: e.target.value })}
          />
          <input
            className="external-tool-command"
            value={tool.command}
            placeholder="Command, e.g. cursor"
            title="Command to run; the project folder is appended as the last argument (or {path})"
            onChange={(e) => updateTool(tool.id, { command: e.target.value })}
            spellCheck={false}
          />
          <button
            className="icon-button small"
            title="Remove tool"
            onClick={() => commit(tools.filter((t) => t.id !== tool.id))}
          >
            ✕
          </button>
        </div>
      ))}
      {tools.length === 0 && (
        <p className="settings-update-status">No external tools yet — add one below.</p>
      )}
      <button
        className="external-tool-add"
        onClick={() => commit([...tools, { id: uuidv4(), title: '', command: '' }])}
      >
        + Add tool
      </button>
    </div>
  )
}
