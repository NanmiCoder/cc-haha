# Claude Code Desktop App — 服务端架构设计

## 一、设计原则

1. **非侵入性**: 不修改现有 CLI 源代码，在 `src/server/` 下新建服务层
2. **数据一致性**: 读写与 CLI 完全相同的文件（JSONL 会话、JSON 设置、Cron 任务）
3. **CLI/UI 互通**: UI 的操作落盘到 CLI 的文件系统，CLI 的会话在 UI 可见
4. **渐进式**: 先实现核心 API，再扩展高级功能

## 二、技术栈

| 层 | 技术 | 理由 |
|----|------|------|
| HTTP Server | Bun.serve() | 原项目已用 Bun，零额外依赖 |
| WebSocket | Bun 原生 WebSocket | 已有 `ws` 依赖，Bun 原生更高效 |
| 验证 | Zod v4 | 已在依赖中 |
| 测试 | bun:test | Bun 内置，无需额外依赖 |
| API 风格 | REST + WebSocket | REST 用于 CRUD，WS 用于流式传输 |

## 三、目录结构

```
src/server/
├── index.ts                    # 服务器入口
├── router.ts                   # 路由注册
├── middleware/
│   ├── auth.ts                 # API Key 鉴权
│   ├── cors.ts                 # CORS 处理
│   └── errorHandler.ts         # 统一错误处理
├── api/
│   ├── sessions.ts             # 会话管理 API
│   ├── conversations.ts        # 对话/消息 API
│   ├── settings.ts             # 设置 API
│   ├── models.ts               # 模型选择 API
│   ├── scheduled-tasks.ts      # 定时任务 API
│   ├── search.ts               # 搜索 API
│   ├── agents.ts               # Agent 管理 API
│   ├── mcp.ts                  # MCP 服务器管理 API
│   └── status.ts               # 状态与诊断 API
├── ws/
│   ├── handler.ts              # WebSocket 连接管理
│   ├── chatStream.ts           # 对话流式传输
│   └── events.ts               # 事件类型定义
├── services/
│   ├── sessionService.ts       # 会话服务（封装 sessionStorage）
│   ├── conversationService.ts  # 对话服务（封装 query engine）
│   ├── settingsService.ts      # 设置服务（封装 settings）
│   ├── cronService.ts          # 定时任务服务（封装 cronTasks）
│   ├── searchService.ts        # 搜索服务（封装 ripgrep）
│   ├── agentService.ts         # Agent 服务
│   └── mcpService.ts           # MCP 服务
└── __tests__/
    ├── sessions.test.ts
    ├── conversations.test.ts
    ├── settings.test.ts
    ├── scheduled-tasks.test.ts
    ├── search.test.ts
    └── e2e/
        └── full-flow.test.ts
```

## 四、API 设计

### 4.1 会话管理 (Sessions)

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions` | 获取会话列表（支持分页、项目过滤） |
| GET | `/api/sessions/:id` | 获取会话详情（标题、消息数、时间） |
| POST | `/api/sessions` | 创建新会话 |
| DELETE | `/api/sessions/:id` | 删除会话 |
| PATCH | `/api/sessions/:id` | 更新会话（重命名） |
| GET | `/api/sessions/:id/messages` | 获取会话消息历史 |

**数据来源**: `~/.claude/projects/{proj}/{sid}.jsonl` (JSONL 格式)

**实现要点**:
- 调用 `loadMessageLogs()` 获取会话列表
- 调用 `loadTranscriptFile()` 解析 JSONL 消息
- 使用 `getProjectDir()` 定位项目目录
- 会话 ID 为 UUID v4

### 4.2 对话 (Conversations)

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/sessions/:id/chat` | 发送消息（返回任务 ID） |
| GET | `/api/sessions/:id/chat/status` | 获取对话状态 |
| POST | `/api/sessions/:id/chat/stop` | 停止生成 |

**WebSocket**: `ws://host:port/ws/chat/:sessionId`
- 发送消息 → 流式接收 AI 回复
- 实时推送工具调用进度
- 权限请求转发给前端

**WebSocket 消息格式**:
```typescript
// 客户端 → 服务器
type ClientMessage =
  | { type: 'user_message'; content: string; attachments?: Attachment[] }
  | { type: 'permission_response'; requestId: string; allowed: boolean }
  | { type: 'stop_generation' }

// 服务器 → 客户端
type ServerMessage =
  | { type: 'content_start'; blockType: 'text' | 'tool_use' }
  | { type: 'content_delta'; text?: string; toolInput?: string }
  | { type: 'tool_use_complete'; toolName: string; toolUseId: string }
  | { type: 'tool_result'; toolUseId: string; content: any; isError: boolean }
  | { type: 'permission_request'; requestId: string; toolName: string; input: any }
  | { type: 'message_complete'; usage: Usage }
  | { type: 'error'; message: string; code: string }
  | { type: 'status'; state: 'thinking' | 'tool_executing' | 'idle' }
```

### 4.3 设置 (Settings)

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/settings` | 获取合并后的设置 |
| GET | `/api/settings/user` | 获取用户级设置 |
| GET | `/api/settings/project` | 获取项目级设置 |
| PUT | `/api/settings/user` | 更新用户级设置 |
| PUT | `/api/settings/project` | 更新项目级设置 |
| GET | `/api/permissions/mode` | 获取当前权限模式 |
| PUT | `/api/permissions/mode` | 切换权限模式 |

**数据来源**: `~/.claude/settings.json` + `.claude/settings.json`

### 4.4 模型 (Models)

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/models` | 获取可用模型列表 |
| GET | `/api/models/current` | 获取当前选中模型 |
| PUT | `/api/models/current` | 切换模型 |
| GET | `/api/effort` | 获取当前 Effort 等级 |
| PUT | `/api/effort` | 设置 Effort 等级 |

### 4.5 定时任务 (Scheduled Tasks)

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/scheduled-tasks` | 获取定时任务列表 |
| POST | `/api/scheduled-tasks` | 创建定时任务 |
| PUT | `/api/scheduled-tasks/:id` | 更新定时任务 |
| DELETE | `/api/scheduled-tasks/:id` | 删除定时任务 |

**数据来源**: `.claude/scheduled_tasks.json`

### 4.6 搜索 (Search)

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/search` | 全局搜索（ripgrep） |
| POST | `/api/search/sessions` | 搜索会话历史 |

### 4.7 Agent 管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/agents` | 获取 Agent 定义列表 |
| GET | `/api/agents/:name` | 获取 Agent 详情 |
| POST | `/api/agents` | 创建 Agent 定义 |
| PUT | `/api/agents/:name` | 更新 Agent 定义 |
| DELETE | `/api/agents/:name` | 删除 Agent 定义 |
| GET | `/api/tasks` | 获取后台任务列表 |
| GET | `/api/tasks/:id` | 获取任务详情 |

### 4.8 MCP 服务器管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/mcp/servers` | 获取 MCP 服务器列表 |
| POST | `/api/mcp/servers` | 添加 MCP 服务器 |
| DELETE | `/api/mcp/servers/:name` | 移除 MCP 服务器 |
| GET | `/api/mcp/tools` | 获取 MCP 工具列表 |

### 4.9 状态与诊断

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/status` | 服务器状态（健康检查） |
| GET | `/api/status/diagnostics` | 系统诊断信息 |
| GET | `/api/status/usage` | Token 用量统计 |
| GET | `/api/status/user` | 用户信息 |

## 五、服务层设计

每个 Service 封装对现有工具函数的调用，提供统一的错误处理和数据转换：

```typescript
// 示例: SessionService
class SessionService {
  // 列出所有会话
  async listSessions(options: { project?: string; limit?: number; offset?: number }): Promise<SessionListResponse>
  
  // 获取会话消息
  async getSessionMessages(sessionId: string): Promise<Message[]>
  
  // 创建新会话
  async createSession(workDir: string): Promise<SessionInfo>
  
  // 删除会话
  async deleteSession(sessionId: string): Promise<void>
  
  // 重命名会话
  async renameSession(sessionId: string, title: string): Promise<void>
}
```

**关键实现**:
- `SessionService` 调用 `loadMessageLogs()` 和 `loadTranscriptFile()`
- `SettingsService` 调用 `getSettings()` 和 `updateSettingsForSource()`
- `CronService` 调用 `readCronTasks()` 和 `writeCronTasks()`
- `SearchService` 调用 ripgrep 流式搜索
- `ConversationService` 使用 `queryModelWithStreaming()` + `StreamingToolExecutor`

## 六、WebSocket 协议

### 连接流程

```
1. 客户端连接: ws://host:port/ws/chat/{sessionId}
   Headers: Authorization: Bearer {apiKey}

2. 服务器确认: { type: 'connected', sessionId: '...' }

3. 客户端发送消息: { type: 'user_message', content: '...' }

4. 服务器流式响应:
   { type: 'status', state: 'thinking' }
   { type: 'content_start', blockType: 'text' }
   { type: 'content_delta', text: 'Let me...' }
   { type: 'content_delta', text: ' help you...' }
   { type: 'content_start', blockType: 'tool_use', toolName: 'Bash' }
   { type: 'tool_use_complete', toolName: 'Bash', toolUseId: '...' }
   { type: 'permission_request', requestId: '...', toolName: 'Bash', input: {...} }
   
5. 客户端批准: { type: 'permission_response', requestId: '...', allowed: true }

6. 服务器继续:
   { type: 'tool_result', toolUseId: '...', content: '...', isError: false }
   { type: 'content_delta', text: 'Done!' }
   { type: 'message_complete', usage: { input_tokens: 1000, output_tokens: 500 } }
   { type: 'status', state: 'idle' }
```

## 七、鉴权方案

- 本地运行: 简单 API Key 验证（从 .env 读取）
- Header: `Authorization: Bearer {ANTHROPIC_API_KEY}`
- WebSocket: 首次连接时通过 URL query 或首条消息验证
- 不做复杂的用户系统，依赖 Anthropic API Key 鉴权

## 八、测试策略

### 单元测试
- 每个 Service 独立测试
- Mock 文件系统操作
- 验证输入输出格式

### 集成测试
- 启动测试服务器
- 发送 HTTP 请求验证响应
- WebSocket 连接和消息流测试

### E2E 测试
- 完整对话流程（创建会话 → 发消息 → 收回复 → 停止 → 查看历史）
- 定时任务 CRUD
- 设置读写
- 搜索功能
