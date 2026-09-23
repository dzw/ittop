import { useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

interface Props {
  x: number
  y: number
  projectPath: string
  /** Opens the edit-terminal dialog for the clicked terminal; omit to hide the Edit item. */
  onEdit?: () => void
  /** Closes the clicked terminal's pane (stops its session, unmounts the pane); omit to hide the Close item. */
  onClosePane?: () => void
  onClose: () => void
}

// The right-click menu for a terminal's project folder, shared by the Workspaces sidebar items
// and the terminal pane headers: the built-in folder actions plus the external tools configured
// in Settings → External tools, each invoked with the directory as its argument.
export default function TerminalContextMenu({ x, y, projectPath, onEdit, onClosePane, onClose }: Props): React.JSX.Element {
  const tools = useAppStore((s) => s.settings.externalTools)
  const usableTools = tools.filter((t) => t.title.trim() !== '' && t.command.trim() !== '')

  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  // Panes live at the window's bottom-right, so a menu opened there would overflow the window;
  // measure the rendered menu once and pull it back inside the viewport.
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({
      x: Math.max(0, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(0, Math.min(y, window.innerHeight - rect.height - 8))
    })
  }, [x, y])

  return (
    <>
      <div
        className="context-menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        className="context-menu"
        style={{ left: pos.x, top: pos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {onClosePane && (
          <>
            <button
              title="Stop this terminal's session and close its pane"
              onClick={() => {
                onClosePane()
                onClose()
              }}
            >
              ✕ Close
            </button>
            <div className="context-menu-separator" />
          </>
        )}
        <button
          title="Open the project folder in the system file manager"
          onClick={() => {
            void window.api.revealFolder(projectPath)
            onClose()
          }}
        >
          Explorer
        </button>
        <button
          title="Open an independent PowerShell window in the project folder"
          onClick={() => {
            void window.api.openPowerShell(projectPath)
            onClose()
          }}
        >
          PS
        </button>
        <button
          title="Open the project folder in VS Code"
          onClick={() => {
            void window.api.openInVSCode(projectPath)
            onClose()
          }}
        >
          Open in VS Code
        </button>
        <button
          title="Copy the full path to the clipboard"
          onClick={() => {
            void navigator.clipboard.writeText(projectPath)
            onClose()
          }}
        >
          Copy path
        </button>
        {usableTools.length > 0 && <div className="context-menu-separator" />}
        {usableTools.map((tool) => (
          <button
            key={tool.id}
            title={tool.command}
            onClick={() => {
              void window.api.runExternalTool(tool.id, projectPath)
              onClose()
            }}
          >
            {tool.title}
          </button>
        ))}
        {onEdit && (
          <>
            <div className="context-menu-separator" />
            <button
              onClick={() => {
                onEdit()
                onClose()
              }}
            >
              ✎ Edit
            </button>
          </>
        )}
      </div>
    </>
  )
}
