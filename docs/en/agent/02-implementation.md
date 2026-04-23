# Claude Code Multi-Agent System — Implementation Details

> A deep dive into the architecture, spawn flow, context passing, and collaboration mechanisms of multi-agent orchestration.

<p align="center">
<a href="#1-architecture-overview">Architecture</a> · <a href="#2-agent-spawn-flow--four-paths">Spawn Flow</a> · <a href="#3-tool-pool-system--three-layer-filtering">Tool Pool</a> · <a href="#4-context-passing-mechanism">Context Passing</a> · <a href="#5-agent-teams-internals">Teams Internals</a> · <a href="#6-background-task-engine">Task Engine</a> · <a href="#7-dreamtask--automatic-memory-consolidation">DreamTask</a> · <a href="#8-worktree-isolation-implementation">Worktree Isolation</a> · <a href="#9-permission-synchronization">Permission Sync</a> · <a href="#10-agent-lifecycle-end-to-end-data-flow">Lifecycle Data Flow</a> · <a href="#11-key-source-file-index">Source Index</a> · <a href="#12-feature-flags">Feature Flags</a>
</p>

![Implementation Architecture Overview](./images/05-architecture.png)

---

## 1. Architecture Overview

Claude Code's multi-agent system consists of the following core modules:

### 5 Core Modules

| Module | Responsibility | Key Files |
|--------|---------------|-----------|
| **Agent Tool** | Primary entry point, routing & dispatch, parameter parsing | `src/tools/AgentTool/AgentTool.tsx` |
| **Execution Engine** | Agent lifecycle management, query loop | `src/tools/AgentTool/runAgent.ts` |
| **Context Manager** | System prompt construction, cache-safe parameters | `src/utils/forkedAgent.ts` |
| **Task System** | State tracking, progress updates, notification queue | `src/tasks/LocalAgentTask/` |
| **Swarm Infrastructure** | Team management, mailbox communication, permission sync | `src/utils/swarm/` |

### 5 Agent Categories

```
┌─────────────────────────────────────────────────┐
│                  Agent Tool                      │
│            (Entry & Route Dispatch)              │
├───────────┬───────────┬───────────┬─────────────┤
│  Subagent │  Fork     │ Teammate  │   Remote    │
│           │           │           │             │
│ Standalone│ Inherited │ Team      │   CCR       │
│  context  │  context  │  collab   │ environment │
│ Type-based│  Cache    │  Mailbox  │   Remote    │
│ tool pool │  sharing  │  comms    │  execution  │
│           │ Byte-level│ Permission│   Poll for  │
│           │ consistent│   sync    │   results   │
└───────────┴───────────┴───────────┴─────────────┘
                        │
                  ┌─────┴─────┐
                  │ DreamTask │
                  │ (Memory   │
                  │  Consolidation) │
                  │ Scheduled │
                  │ background│
                  └───────────┘
```

---

## 2. Agent Spawn Flow — Four Paths

### Entry Point: `AgentTool.call()`

The `call()` function in `src/tools/AgentTool/AgentTool.tsx` is the entry point for all agent spawning. Based on input parameters, it routes to one of four spawn paths:

```
AgentTool.call(input)
  │
  ├─ team_name + name? ──────→ Path 1: spawnTeammate()
  │
  ├─ run_in_background?  ────→ Path 2: registerAsyncAgent()
  │     └─ agent.background?
  │
  ├─ subagent_type omitted? ─→ Path 3: Fork (buildForkedMessages())
  │     └─ fork experiment on?
  │
  └─ default ────────────────→ Path 4: runAgent() synchronous execution
```

### Path 1: Teammate Spawn

**Trigger**: Both `team_name` and `name` are present

**Entry function**: `spawnTeammate()` — `src/tools/shared/spawnMultiAgent.ts`

**Flow**:

1. Detect execution backend (tmux / iTerm2 / in-process)
2. Generate a unique `agentId` for the teammate: `formatAgentId(name, teamName)`
3. Assign a color (from a predefined palette)
4. Create the execution environment:
   - **in-process**: Start in the same process via `spawnInProcessTeammate()`
   - **tmux**: Create a new pane via `TmuxBackend`
   - **iTerm2**: Create a new window via `ITerm2Backend`
5. Write to the TeamFile member list
6. Return `TeammateSpawnedOutput` (including pane ID, agent ID, etc.)

**In-Process Teammate Isolation**:

```typescript
// src/utils/swarm/spawnInProcess.ts
export async function spawnInProcessTeammate(config, context) {
  // 1. Independent AbortController (not tied to leader's cancellation)
  const abortController = new AbortController()
  
  // 2. AsyncLocalStorage context isolation
  runWithTeammateContext(teammateContext, async () => {
    // 3. Independent task state
    // 4. Independent message loop
    // 5. Shared permission pipeline (via mailbox)
  })
}
```

### Path 2: Async Subagent

**Trigger**: `run_in_background=true` or `background: true` in the agent definition

**Flow**:

```
registerAsyncAgent()
  │
  ├─ Create LocalAgentTask (status: 'running')
  ├─ Register in agentNameRegistry (if named)
  ├─ Create output file symlink
  ├─ Create AbortController (linked to parent)
  ├─ Emit SDK event: task_started
  │
  └─ void runAsyncAgentLifecycle()  ← fire-and-forget async
       │
       ├─ Create ProgressTracker
       ├─ Iterate makeStream() generator
       │   ├─ Append messages to agentMessages[]
       │   ├─ Update progress (tokens, tools, activities)
       │   └─ Emit SDK progress events
       │
       └─ On completion:
           ├─ finalizeAgentTool() (extract result)
           ├─ completeAgentTask() (mark complete)
           ├─ Clean up worktree (if isolated)
           └─ enqueuePendingNotification() (notify primary agent)
```

**Key implementation**: `src/tools/AgentTool/agentToolUtils.ts` — `runAsyncAgentLifecycle()`

### Path 3: Fork Subagent

**Trigger**: `subagent_type` is omitted and the fork experiment is enabled

**Core optimization**: Achieves **prompt cache hits** through byte-level consistent API request prefixes.

![Fork Cache Optimization](./images/10-fork-cache.png)

**Flow**:

```
buildForkedMessages(directive, assistantMessage)
  │
  ├─ Preserve parent agent's complete assistant message (all tool_use blocks)
  ├─ Build user message:
  │   ├─ Create placeholder tool_result for each tool_use (byte-consistent)
  │   └─ Append per-child directive (the only divergent part)
  │
  └─ Result: byte-level consistent API prefix → prompt cache hit!
```

**Fork child behavioral constraints** (injected via `FORK_BOILERPLATE_TAG`):

```
1. You are a forked worker process, not the primary agent
2. Do not converse, ask questions, or suggest next steps
3. Use tools directly (Bash, Read, Write, etc.)
4. If you modify files, commit changes before reporting
5. Do not output text between tool calls
6. Stay strictly within the scope of your directive
7. Keep your report under 500 words
8. Your response must begin with "Scope:"
```

**Anti-recursion protection**: `isInForkChild()` detects whether execution is inside a fork child, preventing nested forks.

### Path 4: Synchronous Subagent

**Trigger**: Default path (no team_name, no background, not a fork)

**Flow**:

```
runAgent(promptMessages, toolUseContext, options)
  │
  ├─ Resolve agent definition (getSystemPrompt, tools, permissions)
  ├─ Build system prompt (buildEffectiveSystemPrompt)
  ├─ Create isolated ToolUseContext (createSubagentContext)
  ├─ Start query loop (query() async generator)
  │   ├─ Send API request
  │   ├─ Process streaming events
  │   ├─ Execute tool calls
  │   └─ Accumulate messages and usage
  │
  └─ Return AgentToolResult
       ├─ content: text from the last assistant message
       ├─ totalToolUseCount
       ├─ totalDurationMs
       └─ totalTokens
```

---

## 3. Tool Pool System — Three-Layer Filtering

![Tool Pool System](./images/07-tool-pool.png)

### Layer 1: Global Disallow List

`ALL_AGENT_DISALLOWED_TOOLS` — tools disallowed for all agents:

| Tool | Reason for Disallowing |
|------|----------------------|
| TaskOutput | Only the primary agent may read task output |
| ExitPlanMode | Only the primary agent may exit plan mode |
| EnterPlanMode | Only the primary agent may enter plan mode |
| AskUserQuestion | Subagents should not directly ask the user |
| TaskStop | Only the primary agent may terminate tasks |
| Agent | Prevent recursive spawning (Anthropic internal exception) |

### Layer 2: Agent Type Filtering

`filterToolsForAgent()` — tool filtering based on agent type:

```typescript
// src/tools/AgentTool/agentToolUtils.ts
function filterToolsForAgent(tools, agentDef) {
  // 1. Remove ALL_AGENT_DISALLOWED_TOOLS
  // 2. If not a built-in agent, also remove CUSTOM_AGENT_DISALLOWED_TOOLS
  // 3. If async agent, restrict to ASYNC_AGENT_ALLOWED_TOOLS
  // 4. MCP tools are always allowed
}
```

**ASYNC_AGENT_ALLOWED_TOOLS** (15 tools):

```
Read, WebSearch, TodoWrite, Grep, WebFetch, Glob,
Bash/PowerShell, FileEdit, FileWrite, NotebookEdit,
Skill, SyntheticOutput, ToolSearch, EnterWorktree, ExitWorktree
```

### Layer 3: Agent Definition Filtering

`resolveAgentTools()` — tool resolution based on agent definition:

```typescript
function resolveAgentTools(agentDef, availableTools) {
  if (tools === ['*'] || undefined)  → wildcard, allow all
  if (tools === ['Read', 'Grep'])    → allow only listed tools
  if (disallowedTools === ['Agent']) → subtract from available tools
}
```

**Filtering Pipeline**:

```
All available tools
  │
  ├─ Subtract ALL_AGENT_DISALLOWED_TOOLS ──→ Global disallow
  │
  ├─ Not built-in? Subtract CUSTOM_AGENT_DISALLOWED_TOOLS ──→ Custom restrictions
  │
  ├─ Async? Restrict to ASYNC_AGENT_ALLOWED_TOOLS ──→ Async allowlist
  │
  ├─ Has tools list? Intersect ──→ Agent allowlist
  │
  ├─ Has disallowedTools? Subtract ──→ Agent denylist
  │
  └─ Final tool pool
```

---

## 4. Context Passing Mechanism

![Context Passing](./images/06-context-passing.png)

### CacheSafeParams — Cache-Safe Parameters

```typescript
// src/utils/forkedAgent.ts
export type CacheSafeParams = {
  systemPrompt: SystemPrompt       // System prompt
  userContext: { [k: string]: string }  // Directory structure, CLAUDE.md, etc.
  systemContext: { [k: string]: string } // Git status, environment info
  toolUseContext: ToolUseContext    // Tool configuration, model, options
  forkContextMessages: Message[]   // Fork context messages (for cache sharing)
}
```

**Cache Sharing Principle**:

Fork agents reuse prompt cache by keeping API request prefixes byte-level consistent:

```
┌─────────────────────────────────────────┐
│      Shared Prefix (byte-consistent)    │
│  ┌──────────────────────────────────┐   │
│  │ System Prompt                    │   │
│  │ User Context                     │   │
│  │ System Context                   │   │
│  │ Tool Use Context                 │   │
│  │ Conversation History Messages    │   │
│  │ Assistant Message (all tool_use) │   │
│  │ User Message (placeholder results│)  │
│  └──────────────────────────────────┘   │
├─────────────────────────────────────────┤
│  Only divergence: per-child directive   │
└─────────────────────────────────────────┘
```

### System Prompt Construction

`buildEffectiveSystemPrompt()` — `src/utils/systemPrompt.ts`

**Priority chain** (highest to lowest):

```
Override System Prompt     ← Highest priority, full replacement
  ↓
Coordinator System Prompt  ← Coordinator mode only
  ↓
Agent System Prompt        ← agentDefinition.getSystemPrompt()
  ↓                          - proactive mode: appended to default
  ↓                          - otherwise: replaces default
Custom System Prompt       ← --system-prompt argument
  ↓
Default System Prompt      ← Standard Claude Code prompt
  ↓
Append System Prompt       ← Appended to the end
```

**Agent-specific system prompt enhancement**:

```typescript
// src/tools/AgentTool/runAgent.ts
function getAgentSystemPrompt(agentDef, toolUseContext) {
  let prompt = agentDef.getSystemPrompt({ toolUseContext })
  prompt = enhanceSystemPromptWithEnvDetails(prompt)
  // Adds: working directory, enabled tools list, model info, environment variables
  return prompt
}
```

### SubagentContext — Subagent Context Isolation

```typescript
// src/utils/forkedAgent.ts
export type SubagentContextOverrides = {
  options?: ToolUseContext['options']           // Custom tools, model
  agentId?: AgentId                            // Subagent ID
  agentType?: string                           // Agent type
  messages?: Message[]                         // Custom message history
  readFileState?: ToolUseContext['readFileState'] // File read cache
  abortController?: AbortController            // Abort controller

  // Explicit opt-in sharing (isolated by default)
  shareSetAppState?: boolean                   // Share AppState writes
  shareSetResponseLength?: boolean             // Share response length metrics
  shareAbortController?: boolean               // Share abort controller

  // Experimental injection
  criticalSystemReminder_EXPERIMENTAL?: string // Re-injected each turn
  contentReplacementState?: ContentReplacementState
}
```

**Isolation vs. Sharing**:

| Resource | Default | Description |
|----------|---------|-------------|
| readFileState | Cloned | File read cache is independent |
| messages | New | Message history is independent |
| abortController | New (linked to parent) | Child is cancelled when parent cancels |
| setAppState | No-op | Does not affect parent state by default |
| contentReplacementState | Cloned | Content replacement state is independent |

### Model Resolution

`getAgentModel()` — `src/utils/model/agent.ts`

**Priority chain**:

```
CLAUDE_CODE_SUBAGENT_MODEL env var  ← Highest
  ↓
Agent({ model: 'opus' }) parameter  ← Specified via tool
  ↓
agentDefinition.model               ← Agent definition
  ↓
'inherit'                           ← Inherit parent model
```

---

## 5. Agent Teams Internals

### TeamFile Structure

```typescript
// Storage path: ~/.claude/teams/{team_name}/config.json
{
  name: string                        // Team name
  description?: string                // Team description
  createdAt: number                   // Creation timestamp
  leadAgentId: string                 // Team Lead's Agent ID
  leadSessionId?: string              // Lead's session UUID
  hiddenPaneIds?: string[]            // Panes hidden in UI
  teamAllowedPaths?: TeamAllowedPath[] // Team-level shared permissions
  members: Array<{
    agentId: string                   // Member Agent ID
    name: string                      // Display name
    agentType?: string                // Role type
    model?: string                    // Model used
    prompt?: string                   // Initial task
    color?: string                    // UI color
    planModeRequired?: boolean        // Whether plan approval is required
    joinedAt: number                  // Join timestamp
    tmuxPaneId: string                // Terminal pane ID
    cwd: string                       // Working directory
    worktreePath?: string             // Worktree path
    sessionId?: string                // Session ID
    subscriptions: string[]           // Message subscriptions
    backendType?: 'tmux'|'iterm2'|'in-process'
    isActive?: boolean                // false=idle, true/undefined=active
    mode?: PermissionMode             // Current permission mode
  }>
}
```

### Mailbox System

![Teams Mailbox System](./images/09-teams-mailbox.png)

**Storage path**: `~/.claude/teams/{team_name}/inboxes/{agent_name}.json`

```typescript
// src/utils/teammateMailbox.ts
type TeammateMessage = {
  from: string        // Sender name
  text: string        // Message content (plain text or JSON)
  timestamp: string   // ISO timestamp
  read: boolean       // Whether the message has been read
  color?: string      // Sender's color
  summary?: string    // 5-10 word summary
}
```

**Concurrency safety**: Uses `proper-lockfile` file locks with 10 retries and 5-100ms exponential backoff.

**Message Types**:

| Message | Format | Purpose |
|---------|--------|---------|
| Plain text | `string` | Regular conversation messages |
| shutdown_request | `{ type, reason }` | Request a teammate to shut down |
| shutdown_response | `{ type, request_id, approve }` | Approve/reject shutdown |
| plan_approval_response | `{ type, request_id, approve }` | Approve a plan |
| permission_request | `{ type, toolName, path }` | Permission request |
| idle_notification | Special format | Idle notification |

### Inbox Polling

```typescript
// src/hooks/useInboxPoller.ts
// Poll interval: 1000ms

useEffect(() => {
  const interval = setInterval(async () => {
    const messages = await readUnreadMessages(agentName, teamName)
    
    for (const msg of messages) {
      if (isShutdownRequest(msg.text)) {
        // Handle shutdown request
      } else if (isPlanApprovalResponse(msg.text)) {
        // Handle plan approval
      } else if (isPermissionRequest(msg.text)) {
        // Route to permission system
      } else {
        // Plain text message → submit as new conversation turn
        onSubmitMessage(formatted)
      }
    }
  }, INBOX_POLL_INTERVAL_MS)
}, [])
```

**Message Processing States**:

| State | Description |
|-------|-------------|
| `pending` | Newly received, awaiting processing |
| `processing` | Currently being processed (e.g., permission requests) |
| `processed` | Processing complete |

### Message Routing

```
SendMessage({ to, message })
  │
  ├─ to === "*" → Broadcast
  │   └─ Iterate all teammates, write to each mailbox
  │
  ├─ agentNameRegistry.has(to) → In-process subagent
  │   └─ Route via AppState pending messages queue
  │
  ├─ teamFile.members.find(to) → Process-level teammate
  │   └─ writeToMailbox(to, message, teamName)
  │
  ├─ to.startsWith("bridge:") → Remote session
  │   └─ postInterClaudeMessage(sessionId, message)
  │
  └─ to.startsWith("uds:") → Unix Domain Socket
      └─ sendToUdsSocket(socketPath, message)
```

---

## 6. Background Task Engine

![Background Task Engine](./images/08-background-task.png)

### LocalAgentTask State Machine

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx
type LocalAgentTaskState = {
  type: 'local_agent'
  agentId: AgentId                // Unique identifier
  status: 'running' | 'completed' | 'failed' | 'killed'
  isBackgrounded: boolean         // Foreground vs. background
  
  progress: {
    latestInputTokens: number     // Latest input tokens
    cumulativeOutputTokens: number // Cumulative output tokens
    toolUseCount: number          // Tool invocation count
    recentActivities: ToolActivity[] // Last 5 activities
    lastActivity: number          // Last activity timestamp
  }
  
  result?: AgentToolResult        // Final result
  abortController: AbortController // Abort controller
  retain: boolean                 // UI retention flag
  evictAfter?: number             // Delayed eviction timestamp
}
```

**State Transitions**:

```
              ┌──────────────────────────┐
              │                          │
  register    │    ┌──── killed ←── abort()
    │         │    │
    ▼         │    │
 running ─────┼────┼──── completed ← finalizeAgentTool()
              │    │
              │    └──── failed ← error / timeout
              │
              └──── evict ← notified && endTime > grace
```

### Progress Tracking

```typescript
// ProgressTracker
function updateProgressFromMessage(tracker, message) {
  // 1. Track input tokens (take latest value)
  tracker.latestInputTokens = message.usage?.input_tokens
  
  // 2. Accumulate output tokens
  tracker.cumulativeOutputTokens += message.usage?.output_tokens
  
  // 3. Count tool invocations
  tracker.toolUseCount += countToolUses(message)
  
  // 4. Maintain recent activities (circular buffer, max 5)
  tracker.recentActivities = [...activities].slice(-5)
}
```

### Notification System

```typescript
// src/utils/messageQueueManager.ts
function enqueuePendingNotification(taskId, result) {
  // 1. Atomically set notified flag (prevent duplicates)
  if (task.notified) return
  task.notified = true
  
  // 2. Format XML notification
  const notification = `
    <task-notification>
      <task-id>${taskId}</task-id>
      <status>${status}</status>
      <summary>${summary}</summary>
      <output-file>${outputPath}</output-file>
    </task-notification>
  `
  
  // 3. Enqueue for primary agent consumption
  pendingNotifications.push(notification)
}
```

### Output Management

**Storage path**: `~/.claude/temp/{sessionId}/tasks/{taskId}.output`

| Parameter | Value |
|-----------|-------|
| Max capacity | 5GB / file |
| Circular buffer | 1000 lines |
| Poll interval | 1 second |
| Terminal state retention | 3 seconds (30 seconds for task panel) |
| Write method | Asynchronous queue writes to prevent memory buildup |
| Safety measure | O_NOFOLLOW to prevent symlink attacks |

---

## 7. DreamTask — Automatic Memory Consolidation

DreamTask is a special background agent used for cross-session memory consolidation.

### Trigger Conditions

```typescript
// src/services/autoDream/autoDream.ts
function executeAutoDream() {
  // Four gates:
  if (hoursSinceLastConsolidation < minHours) return  // Time gate: default 24h
  if (sessionsSinceLastConsolidation < minSessions) return // Session gate: default 5
  if (otherProcessConsolidating) return               // Lock gate: mutual exclusion
  if (timeSinceLastScan < 10min) return               // Scan throttle: 10 minutes
}
```

### DreamTask State

```typescript
type DreamTaskState = {
  type: 'dream'
  phase: 'starting' | 'updating'  // updating = has started editing files
  sessionsReviewing: number       // Number of sessions being reviewed
  filesTouched: string[]          // File paths that have been edited
  turns: DreamTurn[]              // Conversation turn records
}
```

---

## 8. Worktree Isolation Implementation

### Creation Flow

```typescript
// src/utils/worktree.ts
async function createAgentWorktree(slug) {
  // 1. Validate slug (prevent directory traversal attacks)
  validateWorktreeSlug(slug)
  
  // 2. Create git worktree
  git worktree add {path} -b {branch}
  
  // 3. Symlink large directories (save disk space)
  symlink(node_modules, worktree/node_modules)
  
  // 4. Apply sparse-checkout (if configured)
  if (sparseCheckoutPaths) {
    git sparse-checkout set {paths}
  }
  
  // 5. Return WorktreeSession
  return { worktreePath, worktreeBranch, headCommit }
}
```

### Cleanup Mechanism

- After agent completion, automatically checks for changes (`hasWorktreeChanges()`)
- If changes exist: returns the worktree path and branch name to the user
- If no changes: automatically deletes the worktree (`removeAgentWorktree()`)
- On abnormal exit: cleanup is ensured via `registerTeamForSessionCleanup()`

---

## 9. Permission Synchronization

### Team-Level Permissions

```typescript
type TeamAllowedPath = {
  path: string        // Absolute directory path
  toolName: string    // Applicable tool (e.g., "Edit", "Write")
  addedBy: string     // Who added it
  addedAt: number     // When it was added
}
```

Teammates automatically inherit team-level permission rules on startup.

### Bubble Mode

Fork agents use the `bubble` permission mode — permission prompts bubble up to the parent agent's terminal:

```
Fork Agent needs permission
  │
  └─ bubble mode → Permission request sent to parent agent
       │
       └─ Parent agent's ToolUseConfirm dialog is displayed
            │
            ├─ User approves → Result relayed back to Fork Agent
            └─ User denies → Fork Agent receives denial
```

### In-Process Teammate Permissions

```
Teammate needs permission
  │
  ├─ Has UI bridge → Displayed directly in Leader's confirmation dialog
  │     └─ With worker badge indicating source
  │
  └─ No UI bridge → Queued via mailbox
        └─ Handled by Leader's useSwarmPermissionPoller
```

---

## 10. Agent Lifecycle End-to-End Data Flow

```
1. User triggers Agent Tool
   │
2. AgentTool.call() routes and dispatches
   │
3. Resolve agent definition
   ├─ Look up agent type (built-in > plugin > user > project)
   ├─ Load system prompt
   ├─ Resolve tool pool (three-layer filtering)
   └─ Determine permission mode and model
   │
4. Create isolated context
   ├─ createSubagentContext() (clone readFileState)
   ├─ Generate agentId
   ├─ Create AbortController
   └─ Optional: create worktree
   │
5. Register task state
   ├─ registerAsyncAgent() or registerAgentForeground()
   ├─ Emit SDK event: task_started
   └─ Register Perfetto trace
   │
6. Execute query loop
   ├─ query() async generator
   │   ├─ Build API request (with CacheSafeParams)
   │   ├─ Process streaming response
   │   ├─ Execute tool calls
   │   └─ Accumulate usage metrics
   ├─ Update progress (ProgressTracker)
   └─ Record transcript
   │
7. Completion handling
   ├─ finalizeAgentTool() (extract result text)
   ├─ completeAgentTask() (mark complete)
   ├─ Clean up resources
   │   ├─ Release file state cache
   │   ├─ Close MCP connections
   │   └─ Delete worktree (if applicable)
   ├─ enqueuePendingNotification() (notify primary agent)
   └─ Emit SDK event: task_completed
   │
8. Primary agent consumes result
   ├─ Synchronous: directly receives AgentToolResult
   └─ Asynchronous: processes after receiving <task-notification>
```

---

## 11. Key Source File Index

### Agent Tool Core

| File | Responsibility |
|------|---------------|
| `src/tools/AgentTool/AgentTool.tsx` | Main tool implementation, routing & dispatch |
| `src/tools/AgentTool/runAgent.ts` | Execution engine, query loop |
| `src/tools/AgentTool/agentToolUtils.ts` | Tool pool resolution, result finalization |
| `src/tools/AgentTool/forkSubagent.ts` | Fork semantics, message inheritance |
| `src/tools/AgentTool/loadAgentsDir.ts` | Agent definition types, parsing & loading |
| `src/tools/AgentTool/builtInAgents.ts` | Built-in agent registry |
| `src/tools/AgentTool/prompt.ts` | Agent tool schema and documentation |
| `src/tools/AgentTool/agentMemory.ts` | Agent persistent memory |

### Swarm Infrastructure

| File | Responsibility |
|------|---------------|
| `src/tools/TeamCreateTool/TeamCreateTool.ts` | Team creation |
| `src/tools/TeamDeleteTool/TeamDeleteTool.ts` | Team cleanup |
| `src/tools/SendMessageTool/SendMessageTool.ts` | Inter-agent communication |
| `src/tools/shared/spawnMultiAgent.ts` | Teammate spawn entry point |
| `src/utils/swarm/spawnInProcess.ts` | In-process teammate spawning |
| `src/utils/swarm/teamHelpers.ts` | Team file read/write |
| `src/utils/swarm/constants.ts` | Constant definitions |
| `src/utils/swarm/teammateInit.ts` | Teammate initialization |
| `src/utils/swarm/permissionSync.ts` | Permission synchronization |
| `src/utils/teammate.ts` | Teammate identity resolution |
| `src/utils/teammateMailbox.ts` | Mailbox message queue |
| `src/utils/teamDiscovery.ts` | Team discovery |
| `src/hooks/useInboxPoller.ts` | Inbox polling |

### Context Management

| File | Responsibility |
|------|---------------|
| `src/utils/forkedAgent.ts` | Cache-safe parameters, subagent context |
| `src/utils/systemPrompt.ts` | System prompt priority construction |
| `src/utils/model/agent.ts` | Agent model resolution |
| `src/utils/worktree.ts` | Git worktree isolation |

### Task System

| File | Responsibility |
|------|---------------|
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | Local agent task |
| `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` | Remote agent task |
| `src/tasks/InProcessTeammateTask/` | In-process teammate task |
| `src/tasks/DreamTask/DreamTask.ts` | Memory consolidation task |
| `src/utils/task/framework.ts` | Task registration, state updates |
| `src/utils/task/diskOutput.ts` | Task output file management |
| `src/utils/messageQueueManager.ts` | Notification queue |

### Coordinator

| File | Responsibility |
|------|---------------|
| `src/coordinator/coordinatorMode.ts` | Coordinator mode configuration |

---

## 12. Feature Flags

| Flag | Controls |
|------|----------|
| `FORK_SUBAGENT` | Enable fork path (when subagent_type is omitted) |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | Enable Explore/Plan agents |
| `VERIFICATION_AGENT` | Enable verification agent |
| `COORDINATOR_MODE` | Enable coordinator mode |
| `KAIROS` | Enable cwd parameter |
| `tengu_auto_background_agents` | Auto-background after 120 seconds |
| `tengu_slim_subagent_claudemd` | Omit CLAUDE.md for read-only agents |
| `tengu_agent_list_attach` | Inject agent list via attachment |
