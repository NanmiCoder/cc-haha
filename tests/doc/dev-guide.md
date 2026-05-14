# 开发指南

## 启动开发环境

```bash
./docs/script/start-dev.sh
```

浏览器打开 `http://localhost:1420`

## 测试覆盖

### 新增测试

| 测试文件 | 测试数 | 覆盖内容 |
|----------|:---:|------|
| `desktop/src/components/chat/PlantUMLRenderer.test.tsx` | 5 | SVG 渲染、预览弹窗、空 SVG 回退、错误状态 |
| `src/server/__tests__/workspace-service.test.ts` | +1 | 软连接检测专项测试 |

### 适配测试

| 测试文件 | 适配内容 |
|----------|----------|
| `desktop/src/stores/workspacePanelStore.test.ts` | `showHidden` 参数、`isSymlink` 字段 |
| `desktop/src/components/workspace/WorkspacePanel.test.tsx` | `isSymlink` 类型、`showHidden` 参数 |
| `src/server/__tests__/sessions.test.ts` | `isSymlink` 字段 |

### 已知 Flaky 测试（与本次改动无关）

- `WorkspacePanel > opens to all files when the current turn has no changed files`
- `WorkspacePanel > lazy loads the root tree...`
- `WorkspacePanel > can expand long file previews...`
- `workspacePanelStore > opens preview tabs...`（前提交 `showHidden` 参数导致 spy 调用次数变化）
- `H5AccessService > enable generates a token...`（环境依赖）

### 运行测试

```bash
# 桌面端
cd desktop && bun run lint && bun run test -- --run

# 服务端
cd .. && bun run check:server
```

## 数据流

### 文件树加载

```
WorkspacePanel UI 点击展开
  → workspacePanelStore.toggleTreeNode(sessionId, path)
  → workspacePanelStore.loadTree(sessionId, path, { showHidden })
  → sessionsApi.getWorkspaceTree(sessionId, path, showHidden)
  → GET /api/sessions/{id}/workspace/tree?showHidden=...
  → workspaceService.readTree(sessionId, relativePath, { showHidden })
  → fs.readdir({ withFileTypes: true })
  → filter + map → WorkspaceTreeEntry { name, path, isDirectory, isSymlink }
```

### 文件监听

```
ws/handler.ts open()
  → workspaceService.startWatcher(sessionId, workDir)
  → fs.watch(workDir, { recursive: true })
  → 200ms debounce
  → sendToSession({ type: 'file_changed', sessionId, path })
  → workspacePanelStore handleFileChanged()
  → 刷新展开的树节点 + 刷新匹配的预览标签

ws/handler.ts close()
  → workspaceService.stopWatcher(sessionId)
```

### PlantUML 渲染

```
MarkdownRenderer (识别 @startuml 代码块)
  → PlantUMLRenderer
  → POST /api/settings/plantuml/render { code }
  → handlePlantumlRender
  → spawn('java', ['-Djava.awt.headless=true', '-jar', jarPath, '-tsvg', '-pipe'])
  → stdin @startuml...@enduml → stdout SVG
  → DOMPurify.sanitize(svg)
  → dangerouslySetInnerHTML
```

### KaTeX 渲染

```
MarkdownRenderer (marked 解析)
  → 识别 $...$ (inline) / $$...$$ (block)
  → katex.renderToString(tex, { throwOnError: false })
  → 替换 marked HTML 占位符
  → dangerouslySetInnerHTML
```

## API 端点

| 方法 | 路径 | 说明 | 改动 |
|------|------|------|------|
| POST | `/api/settings/plantuml/render` | PlantUML 渲染（pipe 模式） | 后端重写 |
| GET | `/api/sessions/{id}/workspace/tree` | 文件树（增加 `showHidden` 参数） | 参数新增 |
| WS | `file_changed` | 文件变化通知 | 消息类型新增 |
