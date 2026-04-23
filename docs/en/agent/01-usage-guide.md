# Claude Code Multi-Agent System — Usage Guide

> Let Claude Code orchestrate multiple specialized agents to handle complex tasks in parallel.

<p align="center">
<a href="#1-what-is-the-multi-agent-system">Multi-Agent System</a> · <a href="#2-six-built-in-agents">Six Built-in Agents</a> · <a href="#3-how-to-spawn-agents">Spawning Agents</a> · <a href="#4-background-task-management">Background Tasks</a> · <a href="#5-agent-teams--multi-agent-collaboration">Agent Teams</a> · <a href="#6-custom-agents">Custom Agents</a> · <a href="#7-permission-modes">Permission Modes</a> · <a href="#8-quick-reference">Quick Reference</a>
</p>

![Multi-Agent System Overview](./images/01-agent-overview.png)

---

## 1. What Is the Multi-Agent System?

Claude Code's multi-agent system is an **intelligent task orchestration framework** that enables the primary agent to spawn multiple specialized subagents, each executing different tasks independently, then aggregating results for the user.

Core philosophy: **Break large tasks into specialized subtasks, execute them in parallel, and boost efficiency.**

| Scenario | Traditional Approach | Multi-Agent Approach |
|----------|---------------------|---------------------|
| Research 5 module architectures | Explore them one by one | 5 Explore agents scan in parallel |
| Implement + Test + Document | Complete sequentially | Team members each handle one part |
| Code review | Single-threaded, file by file | Multiple reviewers in parallel |
| Debug a complex bug | Try one hypothesis at a time | Multiple debuggers verify in parallel |

---

## 2. Six Built-in Agents

![Six Built-in Agents](./images/02-agent-types.png)

Claude Code ships with 6 specialized agent types, each with a specific tool pool and intended use case:

### 2.1 general-purpose (General Agent)

**Use case**: Complex multi-step research, code search, tasks requiring full tool access.

```
Agent({
  description: "Research auth module",
  prompt: "Analyze all files under src/auth/ for the authentication flow...",
  subagent_type: "general-purpose"
})
```

- **Tool pool**: All tools (`*`)
- **Model**: Inherited from parent
- **Characteristics**: The all-rounder — choose this when you are unsure which agent type to use

### 2.2 Explore (Exploration Agent)

**Use case**: Quickly search files, find code patterns, answer questions about codebase structure.

```
Agent({
  description: "Search API endpoints",
  prompt: "Find all REST API endpoint definitions...",
  subagent_type: "Explore"
})
```

- **Tool pool**: Read-only tools (Glob, Grep, Read, Bash)
- **Model**: Haiku (fast, low cost)
- **Characteristics**: Cannot modify files; fast; ideal for research

### 2.3 Plan (Planning Agent)

**Use case**: Design implementation plans, analyze architectural trade-offs, generate step-by-step plans.

```
Agent({
  description: "Plan refactoring",
  prompt: "Design a plan to split the monolith into microservices...",
  subagent_type: "Plan"
})
```

- **Tool pool**: Read-only tools (same as Explore)
- **Model**: Inherited from parent (requires strong reasoning)
- **Characteristics**: Outputs structured plans including key files and dependency analysis

### 2.4 verification (Verification Agent)

**Use case**: Independently verify that an implementation is correct, run tests, perform boundary checks.

```
Agent({
  description: "Verify login feature",
  prompt: "Verify the newly implemented login feature works correctly...",
  subagent_type: "verification"
})
```

- **Tool pool**: Read-only tools
- **Model**: Inherited from parent
- **Characteristics**: Always runs in the background; outputs PASS/FAIL/PARTIAL verdicts; displayed with a red badge

### 2.5 claude-code-guide (Guide Agent)

**Use case**: Answer questions about Claude Code, Agent SDK, or the Claude API.

```
Agent({
  description: "Query Claude API usage",
  prompt: "How do I use the tool_use feature...",
  subagent_type: "claude-code-guide"
})
```

- **Tool pool**: Bash, Read, WebFetch, WebSearch
- **Model**: Haiku
- **Characteristics**: Focused on documentation queries; uses the dontAsk permission mode

### 2.6 statusline-setup (Status Bar Configuration Agent)

**Use case**: Configure the Claude Code status bar display.

- **Tool pool**: Read + Edit only
- **Model**: Sonnet
- **Characteristics**: Highly specialized with an extremely narrow scope

### Agent Type Comparison

| Agent | Access | Tool Pool | Model | Purpose |
|-------|--------|-----------|-------|---------|
| general-purpose | Read/Write | All | Inherited | General tasks |
| Explore | Read-only | Search + Read | Haiku | Quick exploration |
| Plan | Read-only | Search + Read | Inherited | Architecture planning |
| verification | Read-only | Search + Read | Inherited | Independent verification |
| claude-code-guide | Read-only | Search + Web | Haiku | Documentation guide |
| statusline-setup | Read/Write | Read + Edit | Sonnet | Status bar config |

---

## 3. How to Spawn Agents

### Parameters

The Agent tool accepts the following parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `description` | string | Yes | 3-5 word task summary |
| `prompt` | string | Yes | Full task description |
| `subagent_type` | string | No | Agent type (see table above) |
| `model` | string | No | Model override: sonnet/opus/haiku |
| `run_in_background` | boolean | No | Whether to run in background |
| `name` | string | No | Name the agent so it can be addressed via SendMessage |
| `team_name` | string | No | Join a specified team |
| `mode` | string | No | Permission mode |
| `isolation` | string | No | Isolation mode: worktree |

### Foreground Synchronous Execution (Default)

The simplest usage — the agent completes and returns its result:

```
Agent({
  description: "Analyze error logs",
  prompt: "Read the latest error logs under logs/ and summarize common error patterns"
})
```

The primary agent waits for the subagent to finish, then receives the result and continues working.

### Background Asynchronous Execution

Suitable for time-consuming tasks where the primary agent can continue with other work:

```
Agent({
  description: "Full code review",
  prompt: "Review all TypeScript files under src/ for code quality...",
  run_in_background: true
})
```

- The agent immediately returns an `async_launched` status with a taskId
- The primary agent continues working without waiting
- When the agent completes, a `<task-notification>` is delivered automatically
- The notification includes task status, output file path, and a result summary

### Spawning Multiple Agents in Parallel

Spawn multiple independent agents in a single message for true parallelism:

```
// Launch 3 explore agents simultaneously
Agent({ description: "Explore frontend", prompt: "...", subagent_type: "Explore", run_in_background: true })
Agent({ description: "Explore backend", prompt: "...", subagent_type: "Explore", run_in_background: true })
Agent({ description: "Explore database", prompt: "...", subagent_type: "Explore", run_in_background: true })
```

### Worktree Isolation

Let an agent work in an isolated git worktree without affecting the main workspace:

```
Agent({
  description: "Experimental refactor",
  prompt: "Try refactoring module X into...",
  isolation: "worktree"
})
```

- Automatically creates a git worktree (on an independent branch)
- The agent can freely modify files in the isolated environment
- If changes were made, returns the worktree path and branch name on completion
- If no changes were made, cleans up automatically

---

## 4. Background Task Management

![Agent Spawn Flow](./images/03-spawn-flow.png)

### Task States

Background agents have four possible states:

| State | Description |
|-------|-------------|
| `running` | Currently executing |
| `completed` | Finished successfully |
| `failed` | Execution failed |
| `killed` | Manually terminated |

### Progress Tracking

Background agent progress updates in real time:

- **Token usage**: Input/output token counts
- **Tool usage**: Number of tools invoked
- **Recent activity**: Descriptions of the last 5 tool calls (circular buffer)
- **Last activity time**: Used to detect stuck tasks

### Completion Notifications

When a background agent finishes, the primary agent receives an XML-formatted notification:

```xml
<task-notification>
  <task-id>abc123</task-id>
  <status>completed</status>
  <summary>Agent "Explore frontend" completed</summary>
  <output-file>~/.claude/temp/.../tasks/abc123.output</output-file>
</task-notification>
```

### Automatic Backgrounding

When the `tengu_auto_background_agents` feature flag is enabled, foreground agents that run for more than **120 seconds** are automatically moved to background execution, freeing the primary agent to continue working.

---

## 5. Agent Teams — Multi-Agent Collaboration

![Agent Teams Collaboration](./images/04-agent-teams.png)

Agent Teams is an advanced multi-agent collaboration mode where multiple agents work as a team, coordinating tasks through message-based communication.

### Creating a Team

```
TeamCreate({
  team_name: "feature-team",
  description: "Develop user authentication feature"
})
```

After team creation:
- A team configuration file is generated: `~/.claude/teams/{team_name}/config.json`
- A shared task directory is created: `~/.claude/tasks/{team_name}/`
- The current agent automatically becomes the **Team Lead**

### Adding Team Members

Spawn teammates by specifying `name` and `team_name` in the Agent tool:

```
Agent({
  description: "Frontend development",
  prompt: "Implement the login page React components...",
  name: "frontend-dev",
  team_name: "feature-team"
})

Agent({
  description: "Backend development",
  prompt: "Implement the authentication API endpoints...",
  name: "backend-dev",
  team_name: "feature-team"
})
```

### Teammate Communication

Send messages using the SendMessage tool:

```
// Send to a specific teammate
SendMessage({
  to: "frontend-dev",
  message: "API interface is ready, the format is...",
  summary: "Notify API interface format"
})

// Broadcast to all teammates
SendMessage({
  to: "*",
  message: "Everyone pause, requirements have changed...",
  summary: "Broadcast requirements change"
})
```

### Shutdown Coordination

When the task is complete, the Team Lead requests teammates to shut down:

```
// 1. Send shutdown request
SendMessage({
  to: "frontend-dev",
  message: { type: "shutdown_request", reason: "Task completed" }
})

// 2. Teammate responds with approval
SendMessage({
  to: "team-lead",
  message: { type: "shutdown_response", request_id: "...", approve: true }
})

// 3. After all teammates shut down, clean up the team
TeamDelete()
```

### Execution Backends

Agent Teams supports two execution backends:

| Backend | Description | Use Case |
|---------|-------------|----------|
| **in-process** | Runs in the same process, isolated via AsyncLocalStorage | Default mode; lightweight and efficient |
| **tmux** | Runs in a separate tmux pane | When an independent terminal view is needed |
| **iTerm2** | Runs in a separate iTerm2 window | For macOS iTerm2 users |

---

## 6. Custom Agents

In addition to built-in agents, you can create your own specialized agents.

### Definition Format

Create a `.md` file in the `.claude/agents/` directory:

```markdown
---
name: code-reviewer
description: Professional code review agent
tools:
  - Read
  - Grep
  - Glob
  - Bash
model: sonnet
permissionMode: dontAsk
maxTurns: 10
---

You are a professional code reviewer. Check the following aspects:

1. Code quality and readability
2. Potential security vulnerabilities
3. Performance issues
4. Adherence to best practices
```

### Configurable Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Agent type name |
| `description` | string | Description of when to use this agent |
| `tools` | string[] | Allowed tool list (`['*']` for all) |
| `disallowedTools` | string[] | Disallowed tool list |
| `model` | string | Model to use (sonnet/opus/haiku/inherit) |
| `permissionMode` | string | Permission mode |
| `maxTurns` | number | Maximum conversation turns |
| `mcpServers` | object[] | Required MCP servers |
| `hooks` | object | Agent-specific hooks |
| `skills` | string[] | Available skills |
| `memory` | string | Memory scope (user/project/local) |
| `isolation` | string | Isolation mode (worktree/remote) |
| `background` | boolean | Whether to run in background by default |

### Loading Priority

Custom agents are loaded according to the following priority:

1. **Built-in agents** (built-in) — System predefined
2. **Plugin agents** (plugin) — Registered via plugins
3. **User agents** (user) — `~/.claude/agents/`
4. **Project agents** (project) — `.claude/agents/` (project-level)
5. **Flag agents** (flag) — Registered via API
6. **Policy agents** (policy) — Organization policies

Agents with the same name are overridden according to priority.

---

## 7. Permission Modes

Each agent can be configured with a different permission mode:

| Mode | Description |
|------|-------------|
| `default` | Normal permission requests requiring user confirmation |
| `plan` | All operations require explicit approval |
| `acceptEdits` | File edits are auto-approved; other operations require confirmation |
| `bypassPermissions` | Skip all permission checks |
| `dontAsk` | Reject all operations not pre-approved |
| `auto` | AI-driven permission classification (Anthropic internal only) |
| `bubble` | Permission prompts bubble up to the parent agent's terminal |

---

## 8. Quick Reference

| Action | Method |
|--------|--------|
| Spawn a subagent | `Agent({ prompt: "...", subagent_type: "Explore" })` |
| Run in background | `Agent({ ..., run_in_background: true })` |
| Spawn in parallel | Send multiple Agent calls in a single message |
| Worktree isolation | `Agent({ ..., isolation: "worktree" })` |
| Create a team | `TeamCreate({ team_name: "..." })` |
| Send a message | `SendMessage({ to: "name", message: "..." })` |
| Broadcast a message | `SendMessage({ to: "*", message: "..." })` |
| Request shutdown | `SendMessage({ to: "name", message: { type: "shutdown_request" } })` |
| Delete a team | `TeamDelete()` |
| Custom agent | Create a definition file in `.claude/agents/*.md` |
| Specify a model | `Agent({ ..., model: "haiku" })` |
| Name an agent | `Agent({ ..., name: "researcher" })` |
