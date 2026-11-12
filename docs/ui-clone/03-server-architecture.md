# Claude Code Desktop App — Server architecture design

## 1. Design principles

1. **Non-invasive**: do not modify the existing CLI source; build a new service layer under `src/server/`
2. **Data consistency**: read and write exactly the same files as the CLI (JSONL sessions, JSON settings, cron tasks)
3. **CLI/UI interoperability**: UI actions land in the CLI's file system, and CLI sessions are visible in the UI
4. **Incremental**: implement the core APIs first, then extend with advanced features

## 2. Tech stack

| Layer | Technology | Reason |
|----|------|------|
| HTTP Server | Bun.serve() | The project already uses Bun; zero extra dependencies |
| WebSocket | Bun native WebSocket | `ws` is already a dependency, but Bun native is more efficient |
| Validation | Zod v4 | Already a dependency |
| Testing | bun:test | Built into Bun; no extra dependency |
| API style | REST + WebSocket | REST for CRUD, WS for streaming |

## 3. Directory structure

```
src/server/
├── index.ts                    # server entry
├── router.ts                   # route registration
├── middleware/
│   ├── auth.ts                 # API key auth
│   ├── cors.ts                 # CORS handling
│   └── errorHandler.ts         # unified error handling
├── api/
│   ├── sessions.ts             # session management API
│   ├── conversations.ts        # conversation/message API
│   ├── settings.ts             # settings API
│   ├── models.ts               # model selection API
│   ├── scheduled-tasks.ts      # scheduled task API
│   ├── search.ts               # search API
│   ├── agents.ts               # agent management API
│   ├── mcp.ts                  # MCP server management API
│   └── status.ts               # status and diagnostics API
├── ws/
│   ├── handler.ts              # WebSocket connection management
│   ├── chatStream.ts           # conversation streaming
│   └── events.ts               # event type definitions
├── services/
│   ├── sessionService.ts       # session service (wraps sessionStorage)
│   ├── conversationService.ts  # conversation service (wraps the query engine)
│   ├── settingsService.ts      # settings service (wraps settings)
│   ├── cronService.ts          # scheduled task service (wraps cronTasks)
│   ├── searchService.ts        # search service (wraps ripgrep)
│   ├── agentService.ts         # agent service
│   └── mcpService.ts           # MCP service
└── __tests__/
    ├── sessions.test.ts
    ├── conversations.test.ts
    ├── settings.test.ts
    ├── scheduled-tasks.test.ts
    ├── search.test.ts
    └── e2e/
        └── full-flow.test.ts
```

## 4. API design

### 4.1 Sessions

| Method | Path | Description |
|------|------|------|
| GET | `/api/sessions` | List sessions (pagination, project filter) |
| GET | `/api/sessions/:id` | Session details (title, message count, timestamps) |
| POST | `/api/sessions` | Create a new session |
| DELETE | `/api/sessions/:id` | Delete a session |
| PATCH | `/api/sessions/:id` | Update a session (rename) |
| GET | `/api/sessions/:id/messages` | Session message history |

**Data source**: `~/.claude/projects/{proj}/{sid}.jsonl` (JSONL format)

**Implementation notes**:
- Call `loadMessageLogs()` to get the session list
- Call `loadTranscriptFile()` to parse JSONL messages
- Use `getProjectDir()` to locate the project directory
- Session IDs are UUID v4

### 4.2 Conversations

| Method | Path | Description |
|------|------|------|
| POST | `/api/sessions/:id/chat` | Not implemented, returns 501; send messages with `user_message` over the session WebSocket |
| GET | `/api/sessions/:id/chat/status` | Conversation status |
| POST | `/api/sessions/:id/chat/stop` | Stop generation |

**WebSocket**: `ws://host:port/ws/chat/:sessionId`
- Send a message → receive the AI reply as a stream
- Live tool call progress
- Permission requests forwarded to the front end

**WebSocket message format**:
```typescript
// client → server
type ClientMessage =
  | { type: 'user_message'; content: string; attachments?: Attachment[] }
  | { type: 'permission_response'; requestId: string; allowed: boolean }
  | { type: 'stop_generation' }

// server → client
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

### 4.3 Settings

| Method | Path | Description |
|------|------|------|
| GET | `/api/settings` | Merged settings |
| GET | `/api/settings/user` | User-level settings |
| GET | `/api/settings/project` | Project-level settings |
| PUT | `/api/settings/user` | Update user-level settings |
| PUT | `/api/settings/project` | Update project-level settings |
| GET | `/api/permissions/mode` | Current permission mode |
| PUT | `/api/permissions/mode` | Switch permission mode |

**Data source**: `~/.claude/settings.json` + `.claude/settings.json`

### 4.4 Models

| Method | Path | Description |
|------|------|------|
| GET | `/api/models` | Available models |
| GET | `/api/models/current` | Currently selected model |
| PUT | `/api/models/current` | Switch model |
| GET | `/api/effort` | Current effort level |
| PUT | `/api/effort` | Set effort level |

### 4.5 Scheduled tasks

| Method | Path | Description |
|------|------|------|
| GET | `/api/scheduled-tasks` | List scheduled tasks |
| POST | `/api/scheduled-tasks` | Create a scheduled task |
| PUT | `/api/scheduled-tasks/:id` | Update a scheduled task |
| DELETE | `/api/scheduled-tasks/:id` | Delete a scheduled task |

**Data source**: `.claude/scheduled_tasks.json`

### 4.6 Search

| Method | Path | Description |
|------|------|------|
| POST | `/api/search` | Global search (ripgrep) |
| POST | `/api/search/sessions` | Search session history |

### 4.7 Agent management

| Method | Path | Description |
|------|------|------|
| GET | `/api/agents` | List agent definitions |
| GET | `/api/agents/:name` | Agent details |
| POST | `/api/agents` | Create an agent definition |
| PUT | `/api/agents/:name` | Update an agent definition |
| DELETE | `/api/agents/:name` | Delete an agent definition |
| GET | `/api/tasks` | List background tasks |
| GET | `/api/tasks/:id` | Task details |

### 4.8 MCP server management

| Method | Path | Description |
|------|------|------|
| GET | `/api/mcp/servers` | List MCP servers |
| POST | `/api/mcp/servers` | Add an MCP server |
| DELETE | `/api/mcp/servers/:name` | Remove an MCP server |
| GET | `/api/mcp/tools` | List MCP tools |

### 4.9 Status and diagnostics

| Method | Path | Description |
|------|------|------|
| GET | `/api/status` | Server status (health check) |
| GET | `/api/status/diagnostics` | System diagnostics |
| GET | `/api/status/usage` | Token usage statistics |
| GET | `/api/status/user` | User info |

## 5. Service layer design

Each service wraps calls to existing utility functions, providing unified error handling and data conversion:

```typescript
// Example: SessionService
class SessionService {
  // List all sessions
  async listSessions(options: { project?: string; limit?: number; offset?: number }): Promise<SessionListResponse>

  // Get session messages
  async getSessionMessages(sessionId: string): Promise<Message[]>

  // Create a new session
  async createSession(workDir: string): Promise<SessionInfo>

  // Delete a session
  async deleteSession(sessionId: string): Promise<void>

  // Rename a session
  async renameSession(sessionId: string, title: string): Promise<void>
}
```

**Key implementation**:
- `SessionService` calls `loadMessageLogs()` and `loadTranscriptFile()`
- `SettingsService` calls `getSettings()` and `updateSettingsForSource()`
- `CronService` calls `readCronTasks()` and `writeCronTasks()`
- `SearchService` calls ripgrep streaming search
- `ConversationService` uses `queryModelWithStreaming()` + `StreamingToolExecutor`

## 6. WebSocket protocol

### Connection flow

```
1. Client connects: ws://host:port/ws/chat/{sessionId}
   Headers: Authorization: Bearer {apiKey}

2. Server acknowledges: { type: 'connected', sessionId: '...' }

3. Client sends a message: { type: 'user_message', content: '...' }

4. Server streams the response:
   { type: 'status', state: 'thinking' }
   { type: 'content_start', blockType: 'text' }
   { type: 'content_delta', text: 'Let me...' }
   { type: 'content_delta', text: ' help you...' }
   { type: 'content_start', blockType: 'tool_use', toolName: 'Bash' }
   { type: 'tool_use_complete', toolName: 'Bash', toolUseId: '...' }
   { type: 'permission_request', requestId: '...', toolName: 'Bash', input: {...} }

5. Client approves: { type: 'permission_response', requestId: '...', allowed: true }

6. Server continues:
   { type: 'tool_result', toolUseId: '...', content: '...', isError: false }
   { type: 'content_delta', text: 'Done!' }
   { type: 'message_complete', usage: { input_tokens: 1000, output_tokens: 500 } }
   { type: 'status', state: 'idle' }
```

## 7. Authentication

- Local runs: simple API key check (read from .env)
- Header: `Authorization: Bearer {ANTHROPIC_API_KEY}`
- WebSocket: verified via URL query or the first message on connect
- No complex user system; rely on Anthropic API key authentication

## 8. Testing strategy

### Unit tests
- Test each service in isolation
- Mock file system operations
- Verify input/output formats

### Integration tests
- Start a test server
- Send HTTP requests and verify responses
- WebSocket connection and message flow tests

### E2E tests
- Full conversation flow (create session → send message → receive reply → stop → view history)
- Scheduled task CRUD
- Settings read/write
- Search
