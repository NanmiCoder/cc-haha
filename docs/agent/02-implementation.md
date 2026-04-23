# Claude Code 多 Agent 系统 — 实现原理

> 深入剖析多 Agent 编排的架构设计、生成流程、上下文传递和协作机制。

<p align="center">
<a href="#一架构总览">架构总览</a> · <a href="#二agent-生成流程--四条路径">生成流程</a> · <a href="#三工具池系统--三层过滤">工具池系统</a> · <a href="#四上下文传递机制">上下文传递</a> · <a href="#五agent-teams-内部机制">Teams 内部机制</a> · <a href="#六后台任务引擎">后台任务引擎</a> · <a href="#七dreamtask--自动记忆整合">DreamTask</a> · <a href="#八worktree-隔离实现">Worktree 隔离</a> · <a href="#九权限同步机制">权限同步</a> · <a href="#十agent-生命周期完整数据流">生命周期数据流</a> · <a href="#十一关键源文件索引">源文件索引</a> · <a href="#十二feature-flags">Feature Flags</a>
</p>

![实现架构总览](./images/05-architecture.png)

---

## 一、架构总览

Claude Code 的多 Agent 系统由以下核心模块组成：

### 5 大核心模块

| 模块 | 职责 | 关键文件 |
|------|------|----------|
| **Agent Tool** | 主入口，路由分发，参数解析 | `src/tools/AgentTool/AgentTool.tsx` |
| **执行引擎** | Agent 生命周期管理，查询循环 | `src/tools/AgentTool/runAgent.ts` |
| **上下文管理** | 系统提示词构建，缓存安全参数 | `src/utils/forkedAgent.ts` |
| **任务系统** | 状态追踪，进度更新，通知队列 | `src/tasks/LocalAgentTask/` |
| **Swarm 基础设施** | 团队管理，邮箱通信，权限同步 | `src/utils/swarm/` |

### 5 大 Agent 类别

```
┌─────────────────────────────────────────────────┐
│                  Agent Tool                      │
│              (入口 & 路由分发)                    │
├───────────┬───────────┬───────────┬─────────────┤
│  Subagent │  Fork     │ Teammate  │   Remote    │
│  (子代理)  │ (分叉)    │ (队友)    │   (远程)    │
│           │           │           │             │
│ 独立上下文 │ 继承上下文 │ 团队协作   │ CCR 环境   │
│ 按类型过滤 │ 缓存共享   │ 邮箱通信   │ 远程执行   │
│ 工具池     │ 字节一致   │ 权限同步   │ 轮询结果   │
└───────────┴───────────┴───────────┴─────────────┘
                        │
                  ┌─────┴─────┐
                  │ DreamTask │
                  │ (记忆整合)  │
                  │ 定时后台   │
                  └───────────┘
```

---

## 二、Agent 生成流程 — 四条路径

### 入口：`AgentTool.call()`

`src/tools/AgentTool/AgentTool.tsx` 中的 `call()` 函数是所有 Agent 生成的入口。根据输入参数，路由到四条不同的生成路径：

```
AgentTool.call(input)
  │
  ├─ team_name + name? ──────→ 路径1: spawnTeammate()
  │
  ├─ run_in_background?  ────→ 路径2: registerAsyncAgent()
  │     └─ agent.background?
  │
  ├─ 省略 subagent_type? ───→ 路径3: Fork (buildForkedMessages())
  │     └─ fork 实验开启?
  │
  └─ 默认 ───────────────────→ 路径4: runAgent() 同步执行
```

### 路径 1：Teammate 生成

**触发条件**：`team_name` 和 `name` 同时存在

**入口函数**：`spawnTeammate()` — `src/tools/shared/spawnMultiAgent.ts`

**流程**：

1. 检测执行后端（tmux / iTerm2 / in-process）
2. 为队友生成唯一 `agentId`：`formatAgentId(name, teamName)`
3. 分配颜色（从预定义调色板）
4. 创建执行环境：
   - **in-process**：通过 `spawnInProcessTeammate()` 在同进程中启动
   - **tmux**：通过 `TmuxBackend` 创建新 pane
   - **iTerm2**：通过 `ITerm2Backend` 创建新窗口
5. 写入 TeamFile 成员列表
6. 返回 `TeammateSpawnedOutput`（包含 pane ID、agent ID 等）

**In-Process 队友的隔离**：

```typescript
// src/utils/swarm/spawnInProcess.ts
export async function spawnInProcessTeammate(config, context) {
  // 1. 独立的 AbortController（不随 leader 中断）
  const abortController = new AbortController()
  
  // 2. AsyncLocalStorage 上下文隔离
  runWithTeammateContext(teammateContext, async () => {
    // 3. 独立的任务状态
    // 4. 独立的消息循环
    // 5. 共享的权限管道（通过 mailbox）
  })
}
```

### 路径 2：异步 Subagent

**触发条件**：`run_in_background=true` 或 Agent 定义中 `background: true`

**流程**：

```
registerAsyncAgent()
  │
  ├─ 创建 LocalAgentTask（status: 'running'）
  ├─ 注册到 agentNameRegistry（如有 name）
  ├─ 创建输出文件符号链接
  ├─ 创建 AbortController（链接到父代理）
  ├─ 发射 SDK event: task_started
  │
  └─ void runAsyncAgentLifecycle()  ← 异步分离执行
       │
       ├─ 创建 ProgressTracker
       ├─ 遍历 makeStream() 生成器
       │   ├─ 追加消息到 agentMessages[]
       │   ├─ 更新进度（tokens、tools、activities）
       │   └─ 发射 SDK progress events
       │
       └─ 完成时：
           ├─ finalizeAgentTool()（提取结果）
           ├─ completeAgentTask()（标记完成）
           ├─ 清理 worktree（如有隔离）
           └─ enqueuePendingNotification()（通知主代理）
```

**关键实现**：`src/tools/AgentTool/agentToolUtils.ts` — `runAsyncAgentLifecycle()`

### 路径 3：Fork Subagent

**触发条件**：省略 `subagent_type` 且 Fork 实验开启

**核心优化**：通过字节级一致的 API 请求前缀，实现 **prompt cache 命中**。

![Fork 缓存优化](./images/10-fork-cache.png)

**流程**：

```
buildForkedMessages(directive, assistantMessage)
  │
  ├─ 保留父代理完整的 assistant message（所有 tool_use 块）
  ├─ 构建 user message：
  │   ├─ 对每个 tool_use 创建占位 tool_result（字节一致）
  │   └─ 追加 per-child directive（唯一差异部分）
  │
  └─ 结果：字节级一致的 API 前缀 → prompt cache 命中！
```

**Fork 子代理的行为约束**（通过 `FORK_BOILERPLATE_TAG` 注入）：

```
1. 你是分叉的工作进程，不是主代理
2. 不要对话、提问或建议后续步骤
3. 直接使用工具（Bash、Read、Write 等）
4. 如修改文件，在报告前提交更改
5. 工具调用之间不要输出文本
6. 严格限制在指令范围内
7. 报告控制在 500 词以内
8. 响应必须以 "Scope:" 开头
```

**防递归保护**：`isInForkChild()` 检测是否在 fork 子进程中，防止嵌套 fork。

### 路径 4：同步 Subagent

**触发条件**：默认路径（无 team_name、无 background、非 fork）

**流程**：

```
runAgent(promptMessages, toolUseContext, options)
  │
  ├─ 解析 Agent 定义（getSystemPrompt、tools、permissions）
  ├─ 构建系统提示词（buildEffectiveSystemPrompt）
  ├─ 创建隔离的 ToolUseContext（createSubagentContext）
  ├─ 启动查询循环（query() async generator）
  │   ├─ 发送 API 请求
  │   ├─ 处理流式事件
  │   ├─ 执行工具调用
  │   └─ 累积消息和 usage
  │
  └─ 返回 AgentToolResult
       ├─ content: 最后 assistant 消息的文本
       ├─ totalToolUseCount
       ├─ totalDurationMs
       └─ totalTokens
```

---

## 三、工具池系统 — 三层过滤

![工具池系统](./images/07-tool-pool.png)

### 第一层：全局禁止

`ALL_AGENT_DISALLOWED_TOOLS` — 对所有 Agent 禁止的工具：

| 工具 | 禁止原因 |
|------|----------|
| TaskOutput | 仅主代理可读取任务输出 |
| ExitPlanMode | 仅主代理可退出计划模式 |
| EnterPlanMode | 仅主代理可进入计划模式 |
| AskUserQuestion | 子代理不应直接问用户 |
| TaskStop | 仅主代理可终止任务 |
| Agent | 防止递归生成（Ant 内部例外） |

### 第二层：Agent 类型过滤

`filterToolsForAgent()` — 基于 Agent 类型的工具过滤：

```typescript
// src/tools/AgentTool/agentToolUtils.ts
function filterToolsForAgent(tools, agentDef) {
  // 1. 移除 ALL_AGENT_DISALLOWED_TOOLS
  // 2. 如果非内置 Agent，额外移除 CUSTOM_AGENT_DISALLOWED_TOOLS
  // 3. 如果是异步 Agent，限制为 ASYNC_AGENT_ALLOWED_TOOLS
  // 4. MCP 工具始终允许
}
```

**ASYNC_AGENT_ALLOWED_TOOLS**（15 个）：

```
Read, WebSearch, TodoWrite, Grep, WebFetch, Glob,
Bash/PowerShell, FileEdit, FileWrite, NotebookEdit,
Skill, SyntheticOutput, ToolSearch, EnterWorktree, ExitWorktree
```

### 第三层：Agent 定义过滤

`resolveAgentTools()` — 基于 Agent 定义的工具解析：

```typescript
function resolveAgentTools(agentDef, availableTools) {
  if (tools === ['*'] || undefined)  → 通配符，全部允许
  if (tools === ['Read', 'Grep'])    → 仅允许列表中的工具
  if (disallowedTools === ['Agent']) → 从可用工具中减去
}
```

**过滤流程图**：

```
所有可用工具
  │
  ├─ 减去 ALL_AGENT_DISALLOWED_TOOLS ──→ 通用禁止
  │
  ├─ 非内置？减去 CUSTOM_AGENT_DISALLOWED_TOOLS ──→ 自定义限制
  │
  ├─ 异步？限制为 ASYNC_AGENT_ALLOWED_TOOLS ──→ 异步白名单
  │
  ├─ 有 tools 列表？取交集 ──→ Agent 白名单
  │
  ├─ 有 disallowedTools？取差集 ──→ Agent 黑名单
  │
  └─ 最终工具池
```

---

## 四、上下文传递机制

![上下文传递](./images/06-context-passing.png)

### CacheSafeParams — 缓存安全参数

```typescript
// src/utils/forkedAgent.ts
export type CacheSafeParams = {
  systemPrompt: SystemPrompt       // 系统提示词
  userContext: { [k: string]: string }  // 目录结构、CLAUDE.md 等
  systemContext: { [k: string]: string } // git status、环境信息
  toolUseContext: ToolUseContext    // 工具配置、模型、选项
  forkContextMessages: Message[]   // Fork 上下文消息（用于缓存共享）
}
```

**缓存共享原理**：

Fork Agent 通过保持 API 请求前缀字节级一致来复用 prompt cache：

```
┌─────────────────────────────────────────┐
│         共享前缀（字节一致）              │
│  ┌──────────────────────────────────┐   │
│  │ System Prompt                    │   │
│  │ User Context                     │   │
│  │ System Context                   │   │
│  │ Tool Use Context                 │   │
│  │ 对话历史 Messages                │   │
│  │ Assistant Message (all tool_use) │   │
│  │ User Message (placeholder results│)  │
│  └──────────────────────────────────┘   │
├─────────────────────────────────────────┤
│  唯一差异：per-child directive text      │
└─────────────────────────────────────────┘
```

### 系统提示词构建

`buildEffectiveSystemPrompt()` — `src/utils/systemPrompt.ts`

**优先级链**（从高到低）：

```
Override System Prompt     ← 最高优先级，完全替换
  ↓
Coordinator System Prompt  ← 协调器模式专用
  ↓
Agent System Prompt        ← agentDefinition.getSystemPrompt()
  ↓                          - proactive 模式：追加到默认
  ↓                          - 其他：替换默认
Custom System Prompt       ← --system-prompt 参数
  ↓
Default System Prompt      ← Claude Code 标准提示词
  ↓
Append System Prompt       ← 追加到末尾
```

**Agent 特有的系统提示词增强**：

```typescript
// src/tools/AgentTool/runAgent.ts
function getAgentSystemPrompt(agentDef, toolUseContext) {
  let prompt = agentDef.getSystemPrompt({ toolUseContext })
  prompt = enhanceSystemPromptWithEnvDetails(prompt)
  // 添加：工作目录、启用工具列表、模型信息、环境变量
  return prompt
}
```

### SubagentContext — 子代理上下文隔离

```typescript
// src/utils/forkedAgent.ts
export type SubagentContextOverrides = {
  options?: ToolUseContext['options']           // 自定义工具、模型
  agentId?: AgentId                            // 子代理 ID
  agentType?: string                           // Agent 类型
  messages?: Message[]                         // 自定义消息历史
  readFileState?: ToolUseContext['readFileState'] // 文件读取缓存
  abortController?: AbortController            // 中止控制器

  // 显式 opt-in 共享（默认隔离）
  shareSetAppState?: boolean                   // 共享 AppState 写入
  shareSetResponseLength?: boolean             // 共享响应长度度量
  shareAbortController?: boolean               // 共享中止控制器

  // 实验性注入
  criticalSystemReminder_EXPERIMENTAL?: string // 每轮重新注入的提醒
  contentReplacementState?: ContentReplacementState
}
```

**隔离 vs 共享**：

| 资源 | 默认 | 说明 |
|------|------|------|
| readFileState | 克隆 | 文件读取缓存独立 |
| messages | 新建 | 消息历史独立 |
| abortController | 新建（链接父） | 父取消时子也取消 |
| setAppState | No-op | 默认不影响父状态 |
| contentReplacementState | 克隆 | 内容替换状态独立 |

### 模型解析

`getAgentModel()` — `src/utils/model/agent.ts`

**优先级链**：

```
CLAUDE_CODE_SUBAGENT_MODEL 环境变量  ← 最高
  ↓
Agent({ model: 'opus' }) 参数       ← 工具指定
  ↓
agentDefinition.model               ← Agent 定义
  ↓
'inherit'                           ← 继承父代理模型
```

---

## 五、Agent Teams 内部机制

### TeamFile 结构

```typescript
// 存储路径：~/.claude/teams/{team_name}/config.json
{
  name: string                        // 团队名称
  description?: string                // 团队描述
  createdAt: number                   // 创建时间戳
  leadAgentId: string                 // Team Lead 的 Agent ID
  leadSessionId?: string              // Lead 的会话 UUID
  hiddenPaneIds?: string[]            // UI 中隐藏的 pane
  teamAllowedPaths?: TeamAllowedPath[] // 团队级共享权限
  members: Array<{
    agentId: string                   // 成员 Agent ID
    name: string                      // 显示名称
    agentType?: string                // 角色类型
    model?: string                    // 使用的模型
    prompt?: string                   // 初始任务
    color?: string                    // UI 颜色
    planModeRequired?: boolean        // 是否需要 plan 审批
    joinedAt: number                  // 加入时间
    tmuxPaneId: string                // 终端 pane ID
    cwd: string                       // 工作目录
    worktreePath?: string             // Worktree 路径
    sessionId?: string                // 会话 ID
    subscriptions: string[]           // 消息订阅
    backendType?: 'tmux'|'iterm2'|'in-process'
    isActive?: boolean                // false=空闲, true/undefined=活跃
    mode?: PermissionMode             // 当前权限模式
  }>
}
```

### 邮箱系统

![Teams 邮箱系统](./images/09-teams-mailbox.png)

**存储路径**：`~/.claude/teams/{team_name}/inboxes/{agent_name}.json`

```typescript
// src/utils/teammateMailbox.ts
type TeammateMessage = {
  from: string        // 发送者名称
  text: string        // 消息内容（纯文本或 JSON）
  timestamp: string   // ISO 时间戳
  read: boolean       // 是否已读
  color?: string      // 发送者颜色
  summary?: string    // 5-10 词摘要
}
```

**并发安全**：使用 `proper-lockfile` 文件锁，10 次重试，5-100ms 指数退避。

**消息类型**：

| 消息 | 格式 | 用途 |
|------|------|------|
| 纯文本 | `string` | 普通对话消息 |
| shutdown_request | `{ type, reason }` | 请求队友关停 |
| shutdown_response | `{ type, request_id, approve }` | 批准/拒绝关停 |
| plan_approval_response | `{ type, request_id, approve }` | 审批 plan |
| permission_request | `{ type, toolName, path }` | 权限请求 |
| idle_notification | 特殊格式 | 空闲通知 |

### 收件箱轮询

```typescript
// src/hooks/useInboxPoller.ts
// 轮询间隔：1000ms

useEffect(() => {
  const interval = setInterval(async () => {
    const messages = await readUnreadMessages(agentName, teamName)
    
    for (const msg of messages) {
      if (isShutdownRequest(msg.text)) {
        // 处理关停请求
      } else if (isPlanApprovalResponse(msg.text)) {
        // 处理 plan 审批
      } else if (isPermissionRequest(msg.text)) {
        // 路由到权限系统
      } else {
        // 纯文本消息 → 提交为新对话轮
        onSubmitMessage(formatted)
      }
    }
  }, INBOX_POLL_INTERVAL_MS)
}, [])
```

**消息处理状态**：

| 状态 | 说明 |
|------|------|
| `pending` | 新收到，等待处理 |
| `processing` | 正在处理（权限请求等） |
| `processed` | 已处理完毕 |

### 消息路由

```
SendMessage({ to, message })
  │
  ├─ to === "*" → 广播
  │   └─ 遍历所有队友，逐个写入 mailbox
  │
  ├─ agentNameRegistry.has(to) → in-process 子代理
  │   └─ 通过 AppState pending messages 队列路由
  │
  ├─ teamFile.members.find(to) → 进程级队友
  │   └─ writeToMailbox(to, message, teamName)
  │
  ├─ to.startsWith("bridge:") → 远程会话
  │   └─ postInterClaudeMessage(sessionId, message)
  │
  └─ to.startsWith("uds:") → Unix Domain Socket
      └─ sendToUdsSocket(socketPath, message)
```

---

## 六、后台任务引擎

![后台任务引擎](./images/08-background-task.png)

### LocalAgentTask 状态机

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx
type LocalAgentTaskState = {
  type: 'local_agent'
  agentId: AgentId                // 唯一标识
  status: 'running' | 'completed' | 'failed' | 'killed'
  isBackgrounded: boolean         // 前台 vs 后台
  
  progress: {
    latestInputTokens: number     // 最新输入 tokens
    cumulativeOutputTokens: number // 累计输出 tokens
    toolUseCount: number          // 工具使用次数
    recentActivities: ToolActivity[] // 最近 5 个活动
    lastActivity: number          // 最后活动时间戳
  }
  
  result?: AgentToolResult        // 最终结果
  abortController: AbortController // 中止控制器
  retain: boolean                 // UI 保持标志
  evictAfter?: number             // 延迟清除时间戳
}
```

**状态转换**：

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

### 进度追踪

```typescript
// ProgressTracker
function updateProgressFromMessage(tracker, message) {
  // 1. 累积输入 tokens（取最新值）
  tracker.latestInputTokens = message.usage?.input_tokens
  
  // 2. 累加输出 tokens
  tracker.cumulativeOutputTokens += message.usage?.output_tokens
  
  // 3. 统计工具使用
  tracker.toolUseCount += countToolUses(message)
  
  // 4. 维护最近活动（循环缓冲区，max 5）
  tracker.recentActivities = [...activities].slice(-5)
}
```

### 通知系统

```typescript
// src/utils/messageQueueManager.ts
function enqueuePendingNotification(taskId, result) {
  // 1. 原子设置 notified 标志（防重复）
  if (task.notified) return
  task.notified = true
  
  // 2. 格式化 XML 通知
  const notification = `
    <task-notification>
      <task-id>${taskId}</task-id>
      <status>${status}</status>
      <summary>${summary}</summary>
      <output-file>${outputPath}</output-file>
    </task-notification>
  `
  
  // 3. 入队等待主代理消费
  pendingNotifications.push(notification)
}
```

### 输出管理

**存储路径**：`~/.claude/temp/{sessionId}/tasks/{taskId}.output`

| 参数 | 值 |
|------|----|
| 最大容量 | 5GB / 文件 |
| 循环缓冲区 | 1000 行 |
| 轮询间隔 | 1 秒 |
| 终态保持时间 | 3 秒（任务面板 30 秒） |
| 写入方式 | 队列异步写入，防内存堆积 |
| 安全措施 | O_NOFOLLOW 防符号链接攻击 |

---

## 七、DreamTask — 自动记忆整合

DreamTask 是特殊的后台 Agent，用于跨会话记忆整合。

### 触发条件

```typescript
// src/services/autoDream/autoDream.ts
function executeAutoDream() {
  // 四重门控：
  if (hoursSinceLastConsolidation < minHours) return  // 时间门：默认 24h
  if (sessionsSinceLastConsolidation < minSessions) return // 会话门：默认 5 次
  if (otherProcessConsolidating) return               // 锁门：互斥
  if (timeSinceLastScan < 10min) return               // 扫描节流：10 分钟
}
```

### DreamTask 状态

```typescript
type DreamTaskState = {
  type: 'dream'
  phase: 'starting' | 'updating'  // updating = 已开始编辑文件
  sessionsReviewing: number       // 正在审查的会话数
  filesTouched: string[]          // 编辑过的文件路径
  turns: DreamTurn[]              // 对话轮次记录
}
```

---

## 八、Worktree 隔离实现

### 创建流程

```typescript
// src/utils/worktree.ts
async function createAgentWorktree(slug) {
  // 1. 校验 slug（防目录逃逸攻击）
  validateWorktreeSlug(slug)
  
  // 2. 创建 git worktree
  git worktree add {path} -b {branch}
  
  // 3. 符号链接大目录（节省磁盘）
  symlink(node_modules, worktree/node_modules)
  
  // 4. 应用 sparse-checkout（如配置）
  if (sparseCheckoutPaths) {
    git sparse-checkout set {paths}
  }
  
  // 5. 返回 WorktreeSession
  return { worktreePath, worktreeBranch, headCommit }
}
```

### 清理机制

- Agent 完成后自动检测是否有改动（`hasWorktreeChanges()`）
- 有改动：返回 worktree 路径和分支名给用户
- 无改动：自动删除 worktree（`removeAgentWorktree()`）
- 异常退出：通过 `registerTeamForSessionCleanup()` 确保清理

---

## 九、权限同步机制

### 团队级权限

```typescript
type TeamAllowedPath = {
  path: string        // 绝对目录路径
  toolName: string    // 适用的工具（如 "Edit", "Write"）
  addedBy: string     // 添加者名称
  addedAt: number     // 添加时间
}
```

队友启动时，自动继承团队级权限规则。

### Bubble 模式

Fork Agent 使用 `bubble` 权限模式 — 权限提示冒泡到父代理终端：

```
Fork Agent 需要权限
  │
  └─ bubble 模式 → 权限请求发送到父代理
       │
       └─ 父代理的 ToolUseConfirm 对话框显示
            │
            ├─ 用户批准 → 结果回传给 Fork Agent
            └─ 用户拒绝 → Fork Agent 收到拒绝
```

### In-Process 队友权限

```
队友需要权限
  │
  ├─ 有 UI bridge → 直接显示在 Leader 的确认对话框
  │     └─ 带 worker badge 标识来源
  │
  └─ 无 UI bridge → 通过 mailbox 排队
        └─ Leader 的 useSwarmPermissionPoller 处理
```

---

## 十、Agent 生命周期完整数据流

```
1. 用户触发 Agent Tool
   │
2. AgentTool.call() 路由分发
   │
3. 解析 Agent 定义
   ├─ 查找 Agent 类型（内置 > 插件 > 用户 > 项目）
   ├─ 加载系统提示词
   ├─ 解析工具池（三层过滤）
   └─ 确定权限模式和模型
   │
4. 创建隔离上下文
   ├─ createSubagentContext()（克隆 readFileState）
   ├─ 生成 agentId
   ├─ 创建 AbortController
   └─ 可选：创建 worktree
   │
5. 注册任务状态
   ├─ registerAsyncAgent() 或 registerAgentForeground()
   ├─ 发射 SDK event: task_started
   └─ Perfetto trace 注册
   │
6. 执行查询循环
   ├─ query() async generator
   │   ├─ 构建 API 请求（含 CacheSafeParams）
   │   ├─ 流式处理响应
   │   ├─ 执行工具调用
   │   └─ 累积 usage 指标
   ├─ 更新进度（ProgressTracker）
   └─ 记录 transcript
   │
7. 完成处理
   ├─ finalizeAgentTool()（提取结果文本）
   ├─ completeAgentTask()（标记完成）
   ├─ 清理资源
   │   ├─ 释放文件状态缓存
   │   ├─ 关闭 MCP 连接
   │   └─ 删除 worktree（如有）
   ├─ enqueuePendingNotification()（通知主代理）
   └─ 发射 SDK event: task_completed
   │
8. 主代理消费结果
   ├─ 同步：直接获取 AgentToolResult
   └─ 异步：收到 <task-notification> 后处理
```

---

## 十一、关键源文件索引

### Agent Tool 核心

| 文件 | 职责 |
|------|------|
| `src/tools/AgentTool/AgentTool.tsx` | 主工具实现，路由分发 |
| `src/tools/AgentTool/runAgent.ts` | 执行引擎，查询循环 |
| `src/tools/AgentTool/agentToolUtils.ts` | 工具池解析，结果终结 |
| `src/tools/AgentTool/forkSubagent.ts` | Fork 语义，消息继承 |
| `src/tools/AgentTool/loadAgentsDir.ts` | Agent 定义类型，解析加载 |
| `src/tools/AgentTool/builtInAgents.ts` | 内置 Agent 注册表 |
| `src/tools/AgentTool/prompt.ts` | Agent 工具 schema 和文档 |
| `src/tools/AgentTool/agentMemory.ts` | Agent 持久记忆 |

### Swarm 基础设施

| 文件 | 职责 |
|------|------|
| `src/tools/TeamCreateTool/TeamCreateTool.ts` | 团队创建 |
| `src/tools/TeamDeleteTool/TeamDeleteTool.ts` | 团队清理 |
| `src/tools/SendMessageTool/SendMessageTool.ts` | 代理间通信 |
| `src/tools/shared/spawnMultiAgent.ts` | 队友生成入口 |
| `src/utils/swarm/spawnInProcess.ts` | 进程内队友生成 |
| `src/utils/swarm/teamHelpers.ts` | 团队文件读写 |
| `src/utils/swarm/constants.ts` | 常量定义 |
| `src/utils/swarm/teammateInit.ts` | 队友初始化 |
| `src/utils/swarm/permissionSync.ts` | 权限同步 |
| `src/utils/teammate.ts` | 队友身份解析 |
| `src/utils/teammateMailbox.ts` | 邮箱消息队列 |
| `src/utils/teamDiscovery.ts` | 团队发现 |
| `src/hooks/useInboxPoller.ts` | 收件箱轮询 |

### 上下文管理

| 文件 | 职责 |
|------|------|
| `src/utils/forkedAgent.ts` | 缓存安全参数，子代理上下文 |
| `src/utils/systemPrompt.ts` | 系统提示词优先级构建 |
| `src/utils/model/agent.ts` | Agent 模型解析 |
| `src/utils/worktree.ts` | Git worktree 隔离 |

### 任务系统

| 文件 | 职责 |
|------|------|
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | 本地 Agent 任务 |
| `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` | 远程 Agent 任务 |
| `src/tasks/InProcessTeammateTask/` | 进程内队友任务 |
| `src/tasks/DreamTask/DreamTask.ts` | 记忆整合任务 |
| `src/utils/task/framework.ts` | 任务注册、状态更新 |
| `src/utils/task/diskOutput.ts` | 任务输出文件管理 |
| `src/utils/messageQueueManager.ts` | 通知队列 |

### 协调器

| 文件 | 职责 |
|------|------|
| `src/coordinator/coordinatorMode.ts` | 协调器模式配置 |

---

## 十二、Feature Flags

| Flag | 控制内容 |
|------|----------|
| `FORK_SUBAGENT` | 启用 Fork 路径（省略 subagent_type） |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 启用 Explore/Plan Agent |
| `VERIFICATION_AGENT` | 启用 verification Agent |
| `COORDINATOR_MODE` | 启用协调器模式 |
| `KAIROS` | 启用 cwd 参数 |
| `tengu_auto_background_agents` | 120 秒后自动后台化 |
| `tengu_slim_subagent_claudemd` | 只读 Agent 省略 CLAUDE.md |
| `tengu_agent_list_attach` | Agent 列表通过 attachment 注入 |
