---
title: 多 Agent 使用指南
nav_title: 多 Agent 使用
description: 内置 Agent、生成方式、后台任务、Agent Teams 与自定义 Agent 的写法。
order: 4
---

# 多 Agent 使用指南

让 Claude Code 同时调度多个专业 Agent，并行处理复杂任务。

![多 Agent 系统概览](./images/01-agent-overview.png)

## 什么是多 Agent 系统？

Claude Code 的多 Agent 系统是一套**智能任务编排框架**，让主 Agent 能够生成多个专业化的子 Agent（Subagent），各自独立执行不同的任务，最终将结果汇总给用户。

核心理念：**把大任务拆分为多个专业小任务，并行执行，提高效率。**

| 场景 | 传统方式 | 多 Agent 方式 |
|------|----------|---------------|
| 调研 5 个模块的架构 | 逐个串行探索 | 5 个 Explore agent 并行扫描 |
| 实现 + 测试 + 文档 | 顺序完成 | Team 成员各自负责一块 |
| 代码审查 | 单线程逐文件看 | 多个 reviewer 并行审查 |
| 调试复杂 bug | 一个假设一个假设试 | 多个 debugger 并行验证 |

## 六种内置 Agent

![六种内置 Agent](./images/02-agent-types.png)

Claude Code 内置了 6 种专业 Agent，每种都有特定的工具池和适用场景：

### 1. general-purpose（通用型）

**适用场景**：复杂的多步骤研究、代码搜索、需要完整工具访问的任务。

```
Agent({
  description: "调研认证模块",
  prompt: "分析 src/auth/ 下所有文件的认证流程...",
  subagent_type: "general-purpose"
})
```

- **工具池**：全部工具（`*`）
- **模型**：继承父 Agent
- **特点**：万能型，不确定用哪个 agent 时选它

### 2. Explore（探索型）

**适用场景**：快速搜索文件、搜索代码模式、回答代码库结构问题。

```
Agent({
  description: "搜索 API 端点",
  prompt: "找到所有 REST API 端点的定义...",
  subagent_type: "Explore"
})
```

- **工具池**：除 Agent、ExitPlanMode、Edit、Write、NotebookEdit 外的全部工具。**注意 Bash 在内**——它不能改文件，但能跑任意命令
- **模型**：Haiku（快速低成本）
- **特点**：不能修改文件，速度快，适合调研

### 3. Plan（规划型）

**适用场景**：设计实现方案、分析架构权衡、生成分步计划。

```
Agent({
  description: "规划重构方案",
  prompt: "设计将 monolith 拆分为微服务的方案...",
  subagent_type: "Plan"
})
```

- **工具池**：同 Explore，同一组禁用清单
- **模型**：继承父 Agent（需要强推理能力）
- **特点**：输出结构化计划，包含关键文件和依赖分析

### 4. verification（验证型）

**适用场景**：独立验证实现是否正确，运行测试，边界检查。

```
Agent({
  description: "验证登录功能",
  prompt: "验证新实现的登录功能是否正确...",
  subagent_type: "verification"
})
```

- **工具池**：同 Explore；系统提示额外允许在 tmp 下写临时测试脚本
- **模型**：继承父 Agent
- **特点**：始终在后台运行，输出 PASS/FAIL/PARTIAL 判定，红色标识

### 5. claude-code-guide（指南型）

**适用场景**：回答关于 Claude Code、Agent SDK、Claude API 的问题。

```
Agent({
  description: "查询 Claude API 用法",
  prompt: "如何使用 tool_use 功能...",
  subagent_type: "claude-code-guide"
})
```

- **工具池**：Glob、Grep、Read、WebFetch、WebSearch（内部构建下换成 Bash + Read + WebFetch + WebSearch）
- **模型**：Haiku
- **特点**：专注文档查询，dontAsk 权限模式

### 6. statusline-setup（状态栏配置）

**适用场景**：配置 Claude Code 状态栏显示。

- **工具池**：仅 Read + Edit
- **模型**：Sonnet
- **特点**：高度专业化，范围极小

### Agent 类型对比表

| Agent | 读写 | 工具池 | 模型 | 用途 |
|-------|------|--------|------|------|
| general-purpose | 读写 | 全部 | 继承 | 通用任务 |
| Explore | 不能改文件 | 全部工具减去编辑类 | Haiku | 快速探索 |
| Plan | 不能改文件 | 同 Explore | 继承 | 架构规划 |
| verification | 不能改项目文件 | 同 Explore | 继承 | 独立验证 |
| claude-code-guide | 只读 | 搜索+网络 | Haiku | 文档指南 |
| statusline-setup | 读写 | Read+Edit | Sonnet | 状态栏配置 |

## 如何生成 Agent

### 基本参数

Agent 工具接受以下参数：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `description` | string | 是 | 3-5 词任务简述 |
| `prompt` | string | 是 | 完整的任务描述 |
| `subagent_type` | string | 否 | Agent 类型（见上表） |
| `model` | string | 否 | 模型覆盖：sonnet/opus/haiku |
| `run_in_background` | boolean | 否 | 是否后台运行 |
| `name` | string | 否 | 命名后可通过 SendMessage 寻址 |
| `team_name` | string | 否 | 加入指定团队 |
| `mode` | string | 否 | 权限模式 |
| `isolation` | string | 否 | 隔离模式：worktree |

### 前台同步执行（默认）

最简单的用法，Agent 执行完毕后返回结果：

```
Agent({
  description: "分析错误日志",
  prompt: "读取 logs/ 下最近的错误日志，总结常见错误模式"
})
```

主 Agent 会等待子 Agent 完成，然后收到结果继续工作。

### 后台异步执行

适合耗时任务，主 Agent 可以继续做其他事情：

```
Agent({
  description: "全面代码审查",
  prompt: "审查 src/ 下所有 TypeScript 文件的代码质量...",
  run_in_background: true
})
```

- Agent 立即返回 `async_launched` 状态和 taskId
- 主 Agent 继续工作，不需要等待
- Agent 完成后自动收到 `<task-notification>` 通知
- 通知包含任务状态、输出文件路径和结果摘要

### 并行生成多个 Agent

在一条消息中生成多个独立的 Agent，实现真正的并行：

```
// 同时启动 3 个探索 agent
Agent({ description: "探索前端", prompt: "...", subagent_type: "Explore", run_in_background: true })
Agent({ description: "探索后端", prompt: "...", subagent_type: "Explore", run_in_background: true })
Agent({ description: "探索数据库", prompt: "...", subagent_type: "Explore", run_in_background: true })
```

### Worktree 隔离

让 Agent 在独立的 git worktree 中工作，不影响主工作区：

```
Agent({
  description: "实验性重构",
  prompt: "尝试将模块 X 重构为...",
  isolation: "worktree"
})
```

- 自动创建 git worktree（独立分支）
- Agent 在隔离环境中自由修改文件
- 完成后如有改动，返回 worktree 路径和分支名
- 无改动则自动清理

## 后台任务管理

![Agent 生成流程](./images/03-spawn-flow.png)

### 任务状态

后台 Agent 有四种状态：

| 状态 | 说明 |
|------|------|
| `running` | 正在执行中 |
| `completed` | 执行成功 |
| `failed` | 执行失败 |
| `killed` | 被手动终止 |

### 进度追踪

后台 Agent 的进度实时更新：

- **Token 消耗**：输入/输出 token 计数
- **工具使用**：已使用的工具次数
- **最近活动**：最近 5 个工具调用描述（循环缓冲区）
- **最后活动时间**：用于检测卡住的任务

### 完成通知

当后台 Agent 完成时，主 Agent 收到 XML 格式的通知：

```xml
<task-notification>
  <task-id>abc123</task-id>
  <status>completed</status>
  <summary>Agent "探索前端" completed</summary>
  <output-file>~/.claude/temp/.../tasks/abc123.output</output-file>
</task-notification>
```

### 自动后台化

当 `tengu_auto_background_agents` 特性开启时，前台 Agent 运行超过 **120 秒**会自动转为后台执行，释放主 Agent 继续工作。

## Agent Teams — 多 Agent 协作

![Agent Teams 协作](./images/04-agent-teams.png)

Agent Teams 是更高级的多 Agent 协作模式，多个 Agent 以团队形式工作，通过消息通信协调任务。

### 创建团队

```
TeamCreate({
  team_name: "feature-team",
  description: "开发用户认证功能"
})
```

团队创建后：
- 生成团队配置文件：`~/.claude/teams/{team_name}/config.json`
- 创建共享任务目录：`~/.claude/tasks/{team_name}/`
- 当前 Agent 自动成为 **Team Lead**（团队负责人）

### 添加团队成员

通过 Agent 工具指定 `name` 和 `team_name` 生成队友：

```
Agent({
  description: "前端开发",
  prompt: "负责实现登录页面的 React 组件...",
  name: "frontend-dev",
  team_name: "feature-team"
})

Agent({
  description: "后端开发",
  prompt: "负责实现认证 API 端点...",
  name: "backend-dev",
  team_name: "feature-team"
})
```

### 队友通信

通过 SendMessage 工具发送消息：

```
// 发送给特定队友
SendMessage({
  to: "frontend-dev",
  message: "API 接口已就绪，格式是...",
  summary: "通知 API 接口格式"
})

// 广播给所有队友
SendMessage({
  to: "*",
  message: "大家暂停，需求变更了...",
  summary: "广播需求变更"
})
```

### 关停协调

当任务完成后，Team Lead 请求队友关停：

```
// 1. 发送关停请求
SendMessage({
  to: "frontend-dev",
  message: { type: "shutdown_request", reason: "任务已完成" }
})

// 2. 队友回复批准
SendMessage({
  to: "team-lead",
  message: { type: "shutdown_response", request_id: "...", approve: true }
})

// 3. 所有队友关停后，清理团队
TeamDelete()
```

### 执行后端

Agent Teams 支持两种执行后端：

| 后端 | 说明 | 适用场景 |
|------|------|----------|
| **in-process** | 同进程运行，AsyncLocalStorage 隔离 | 默认模式，轻量高效 |
| **tmux** | 独立 tmux pane 运行 | 需要独立终端视图 |
| **iTerm2** | 独立 iTerm2 窗口运行 | macOS iTerm2 用户 |

## 自定义 Agent

除了内置 Agent，你还可以创建自己的专业 Agent。

### 桌面端管理与作用域

桌面端入口是 **设置 → Agents**。这里和 CLI 使用同一份 Agent 定义文件，不会再把配置复制到数据库或 `localStorage`：

| 作用域 | 唯一事实源 | 用途 |
|--------|------------|------|
| **用户** | `~/.claude/agents/*.md` | 在所有项目中可用 |
| **项目** | `<项目目录>/.claude/agents/*.md` | 只在当前项目中可用；同名时覆盖用户 Agent |

用户和项目 Agent 可以在桌面端创建、编辑和删除，保存结果会直接写回对应的 Markdown 文件。内置、插件、托管策略和 CLI 参数等其他来源也会显示在列表中，但只能查看，不能从桌面端改写其来源文件。

当桌面端连接着当前运行会话时，创建、编辑或删除 Agent 会原地热重载该会话，下一次 spawn 立即使用新定义。如果没有可用的运行时，或热重载失败，文件保存仍然成功；桌面端会显示不阻塞操作的警告，并在下次启动时自动读取已保存的定义。

### 定义格式

在用户或项目的 `agents` 目录下创建 `.md` 文件：

```markdown
---
name: code-reviewer
description: 专业代码审查代理
tools:
  - Read
  - Grep
  - Glob
  - Bash
model: sonnet
effort: high
permissionMode: dontAsk
maxTurns: 10
---

你是一个专业的代码审查员。请检查以下方面：

1. 代码质量和可读性
2. 潜在的安全漏洞
3. 性能问题
4. 最佳实践遵循
```

### 可配置字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | Agent 类型名称 |
| `description` | string | 何时使用的说明 |
| `tools` | string[] | 允许的工具列表（`['*']` 表示全部） |
| `disallowedTools` | string[] | 禁止的工具列表 |
| `model` | string | 使用的模型（`fable`/`opus`/`sonnet`/`haiku`、完整模型 ID 或 `inherit`） |
| `effort` | string | 推理强度（`low`/`medium`/`high`/`xhigh`/`max`），以模型能力为准 |
| `permissionMode` | string | 权限模式 |
| `maxTurns` | number | 最大对话轮数 |
| `mcpServers` | object[] | 需要的 MCP 服务器 |
| `hooks` | object | Agent 特定的钩子 |
| `color` | string | Agent 的界面标识颜色 |
| `skills` | string[] | 可使用的技能 |
| `memory` | string | 记忆作用域（user/project/local） |
| `isolation` | string | 隔离模式（worktree/remote） |
| `background` | boolean | 是否默认后台运行 |

### 模型、推理强度与 Thinking

要继承当前会话，最清楚的写法是**省略对应字段**：不写 `model` 就继承主会话模型，不写 `effort` 就继承当前会话的推理强度。`model: inherit` 是模型字段的等价显式写法；`effort` 没有 `inherit` 值。

模型的解析优先级从高到低为：

1. `CLAUDE_CODE_SUBAGENT_MODEL` 的具体模型值（设为 `inherit` 时不锁定模型）
2. 本次 `Agent({ ..., model: "..." })` 调用指定的模型
3. Agent Markdown frontmatter 中的 `model`
4. 主会话模型

推理强度的解析优先级从高到低为：

1. `CLAUDE_CODE_EFFORT_LEVEL`
2. Agent Markdown frontmatter 中的 `effort`
3. 当前会话的 effort
4. 模型默认值

`Agent` 工具没有单次调用的 `effort` 参数，因此应在 Agent 定义或会话层设置。`low`、`medium`、`high`、`xhigh`、`max` 是否可用取决于解析后的真实模型及提供商能力；Claude 模型会向下回退到可用档位，其他提供商按各自的模型目录规范化，不支持 effort 的模型不会应用该字段。

整数形式的 `effort` 仅为既有 SDK/JSON 与内部配置兼容而保留，不属于推荐的官方 Agent 配置；桌面端 Agent 管理器只写入以上五个命名档位。

子 Agent 通常继承主会话的扩展思考（extended thinking）开关，但解析后的模型强制要求优先；例如 Fable 5 会规范化为 adaptive thinking。目前不支持在单个 Agent frontmatter 中设置 `thinking` 或 `thinkingBudget`；`effort` 也不是固定的 thinking token 预算。

### 同名 Agent 的来源优先级

当多个来源定义了同名 Agent 时，cc-haha 按以下优先级选择实际生效的定义（从高到低）：

1. **策略 Agent**（policy）— 组织托管策略
2. **CLI 参数 Agent**（flag）— 通过 `--agents` 注册
3. **项目 Agent**（project）— `<项目目录>/.claude/agents/`
4. **用户 Agent**（user）— `~/.claude/agents/`
5. **插件 Agent**（plugin）— 由插件提供
6. **内置 Agent**（built-in）— 系统预定义

桌面端仍会展示被覆盖的定义及其来源，但真正 spawn 时使用优先级最高的活动定义。

## 权限模式

每个 Agent 可以设置不同的权限模式：

| 模式 | 说明 |
|------|------|
| `default` | 正常权限请求，需要用户确认 |
| `plan` | 所有操作需要显式审批 |
| `acceptEdits` | 自动接受文件编辑，其他操作需确认 |
| `bypassPermissions` | 跳过所有权限检查 |
| `dontAsk` | 拒绝所有未预批准的操作 |
| `auto` | AI 驱动的权限分类（仅 Ant 内部） |
| `bubble` | 权限提示冒泡到父 Agent 终端 |

## 快速参考

| 操作 | 方法 |
|------|------|
| 生成子 Agent | `Agent({ prompt: "...", subagent_type: "Explore" })` |
| 后台运行 | `Agent({ ..., run_in_background: true })` |
| 并行生成 | 单条消息中发送多个 Agent 调用 |
| Worktree 隔离 | `Agent({ ..., isolation: "worktree" })` |
| 创建团队 | `TeamCreate({ team_name: "..." })` |
| 发送消息 | `SendMessage({ to: "name", message: "..." })` |
| 广播消息 | `SendMessage({ to: "*", message: "..." })` |
| 请求关停 | `SendMessage({ to: "name", message: { type: "shutdown_request" } })` |
| 删除团队 | `TeamDelete()` |
| 管理自定义 Agent | 桌面端 **设置 → Agents**，或直接编辑 `~/.claude/agents/*.md` / `<项目目录>/.claude/agents/*.md` |
| 指定模型 | `Agent({ ..., model: "haiku" })` |
| 指定推理强度 | 在 Agent Markdown frontmatter 中设置 `effort: high` |
| 命名 Agent | `Agent({ ..., name: "researcher" })` |
