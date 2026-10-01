# MEMORY

## ittop (d:/aws/ittop) 项目要点
- Electron 43 + React 19 + electron-vite 3 + node-pty + zustand 的 Windows 多工作区管理器(并行运行 Claude Code/Codex 等终端 Agent)。
- 结构: `src/main`(主进程/pty/存储)、`src/preload`、`src/renderer`(React UI)、`src/shared/types.ts`(IPC 类型)。
- 终端面板布局逻辑集中在 `src/renderer/src/App.tsx`: `cols`/`rows` + `cellPlacement()`,列宽/行高用 fr 数组(`paneColFractions`/`paneRowFractions` 存设置),分隔线为绝对定位的 `.column-resizer`/`.row-resizer`。
- 约定: 3 个面板 = 品字形(上 1 整宽 + 下 2 并排);面板组件 `TerminalPane` 通过 `gridSpan` 跨列。
- 命令: `npm run dev`(默认渲染进程端口 5173)、`npm run build`、`npm run build:win`。`.vscode/tasks.json` 与 `launch.json` 已配置构建/运行/调试(2026-09-05 添加)。
- 已知遗留: `src/renderer/src/store/__tests__/useAppStore.test.ts`(未跟踪)类型检查报 `buildCommand` 缺失。
