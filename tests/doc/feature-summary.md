# 功能改动说明

## 分支：feature/workspace-enhancements

### 一、文件树增强

#### 1.1 隐藏文件控制

**入口**：文件树工具栏 `👁` 按钮

**行为**：
- 默认关闭（`showHiddenFiles: false`），不显示 `.` 开头的文件/目录
- 开启后仅过滤 `.git`，其余隐藏文件可见
- 状态通过 `workspacePanelStore.showHiddenFiles` 管理
- 传递给后端 `readTree` 的 `showHidden` 参数

**涉及文件**：

| 文件 | 改动 |
|------|------|
| `src/server/services/workspaceService.ts` | `readTree` 添加 `showHidden` 参数，默认 `false` 过滤 `.` 前缀，`true` 仅过滤 `.git` |
| `src/server/api/sessions.ts` | 从 query string 读取 `showHidden` 参数传给 `readTree` |
| `desktop/src/api/sessions.ts` | `getWorkspaceTree` 添加 `showHidden` 参数，拼接到请求 query |
| `desktop/src/stores/workspacePanelStore.ts` | 添加 `showHiddenFiles` 状态 + `toggleShowHiddenFiles` 方法，`loadTree` 传递参数 |
| `desktop/src/components/workspace/WorkspacePanel.tsx` | 工具栏区域添加 `👁` 按钮 |

#### 1.2 软连接支持

**行为**：
- 文件树中软连接条目显示 `🔗` (link) 图标
- 通过 `Dirent.isSymbolicLink()` 检测，无需额外 stat 调用

**涉及文件**：

| 文件 | 改动 |
|------|------|
| `src/server/services/workspaceService.ts` | `WorkspaceTreeEntry` 添加 `isSymlink: boolean`，`readTree` 中调用 `entry.isSymbolicLink()` |
| `desktop/src/api/sessions.ts` | 前端 `WorkspaceTreeEntry` 类型同步添加 `isSymlink` |
| `desktop/src/components/workspace/WorkspacePanel.tsx` | 文件节点和目录节点添加 `link` 图标（`isSymlink` 为 `true` 时） |

#### 1.3 文件监听

**行为**：
- WebSocket 连接建立后，对会话 workDir 启动 `fs.watch({ recursive: true })`
- 文件变化 200ms 防抖后通过 `sendToSession` 推送 `{ type: 'file_changed', sessionId, path }`
- 前端收到后自动刷新展开的树节点和预览标签
- 不监听 `node_modules`

**涉及文件**：

| 文件 | 改动 |
|------|------|
| `src/server/ws/events.ts` | `ServerMessage` 添加 `file_changed` 消息类型 |
| `src/server/services/workspaceService.ts` | 新增 `startWatcher(sessionId, workDir)` / `stopWatcher(sessionId)` 方法 |
| `src/server/ws/handler.ts` | `open()` 中启动 watcher，`close()` 中停止 watcher |
| `desktop/src/stores/workspacePanelStore.ts` | 注册 `file_changed` handler，刷新树和预览标签 |

---

### 二、PlantUML 渲染

#### 2.1 前端渲染组件

**行为**：
- Markdown 中 `@@@plantuml` / `@startuml ... @enduml` 代码块自动渲染为 SVG 图表
- 渲染结果经过 `DOMPurify.sanitize()` 安全清洗
- 渲染失败时显示错误信息

**涉及文件**：

| 文件 | 改动 |
|------|------|
| `desktop/src/components/chat/PlantUMLRenderer.tsx` | 渲染组件：调用后端 API 获取 SVG，DOMPurify 清洗，error 状态 |
| `desktop/src/components/markdown/MarkdownRenderer.tsx` | 添加 `shouldRenderAsPlantUML` 判定，分发到 PlantUMLRenderer |
| `desktop/src/components/chat/PlantUMLRenderer.test.tsx` | 5 个测试：SVG 渲染、头部、预览弹窗、空 SVG 回退、错误状态 |

#### 2.2 后端 Pipe 渲染

**行为**：
- 从 `execFile + 临时文件` 改为 `spawn -pipe` 模式
- stdin 写入 PlantUML 源码，stdout 读取 SVG
- `-Djava.awt.headless=true` 避免 macOS Dock 图标
- 去掉临时文件 I/O

**涉及文件**：

| 文件 | 改动 |
|------|------|
| `src/server/api/settings.ts` | `handlePlantumlRender` 改用 `spawn('java', ['-Djava.awt.headless=true', '-jar', jarPath, '-tsvg', '-pipe'])` |

---

### 三、KaTeX 公式渲染

**行为**：
- Markdown 中 `$...$` 行内公式和 `$$...$$` 块级公式自动渲染
- 通过 `marked` 标记扩展在渲染 Pipeline 中处理

**涉及文件**：

| 文件 | 改动 |
|------|------|
| `desktop/src/components/markdown/MarkdownRenderer.tsx` | 添加 KaTeX 渲染逻辑，`katex.renderToString` 处理行内/块级公式 |

---

### 四、开发工具

#### 4.1 start-dev.sh

**位置**：`docs/script/start-dev.sh`

**行为**：
- 启动后端 `bun run src/server/index.ts` (port 3456)
- 启动前端 `cd desktop && bun run dev` (Vite port 1420)
- 浏览器打开 `http://localhost:1420`

#### 4.2 Vite Proxy

**位置**：`desktop/vite.config.ts`

**行为**：
- `/api/*`, `/health` → `http://127.0.0.1:3456`
- `/ws` → `ws://127.0.0.1:3456`
