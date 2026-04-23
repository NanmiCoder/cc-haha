# Claude Code 多 Agent 系统文档

> 完整的多 Agent 编排使用指南和实现原理文档

---

## 📚 文档目录

### [01-usage-guide.md](./01-usage-guide.md) — 使用指南

面向用户的完整使用手册，涵盖：

- **Agent 工具**：参数详解、生成方式、后台运行
- **六种内置 Agent**：general-purpose、Explore、Plan、verification、claude-code-guide、statusline-setup
- **后台任务**：异步执行、进度追踪、完成通知
- **Agent Teams**：团队创建、成员协作、消息通信
- **Worktree 隔离**：独立环境、分支管理、安全上下文
- **自定义 Agent**：定义格式、工具池配置、系统提示词

**适合人群**：所有 Claude Code 用户

---

### [02-implementation.md](./02-implementation.md) — 实现原理

面向开发者的技术深度解析，涵盖：

- **架构总览**：5 大 Agent 类别、4 条生成路径
- **Agent 生成流程**：同步/异步/Fork/Teammate 四种路径详解
- **工具池系统**：三层过滤、常量定义、权限映射
- **上下文传递**：CacheSafeParams、系统提示词构建、Fork 缓存优化
- **Teams 内部机制**：TeamFile 结构、邮箱系统、收件箱轮询、消息路由
- **后台任务引擎**：LocalAgentTask 生命周期、进度追踪、通知队列
- **权限同步**：团队级权限、模式传播、bubble 模式
- **完整数据流**：从 Agent Tool 调用到结果回传

**适合人群**：贡献者、架构师、想深入了解实现的开发者

---

### [03-agent-framework.md](./03-agent-framework.md) — Agent 框架深度解析

从源码视角剖析 Claude Code 底层 Agent 架构的设计哲学，涵盖：

- **核心 Agent 循环**：AsyncGenerator 状态机、五阶段 while(true) 循环
- **系统提示词工程**：分层构建、缓存边界、CLAUDE.md 加载机制
- **工具系统设计**：完整生命周期管理、三阶段注册、七步执行管道
- **上下文管理与压缩**：四级渐进式压缩、系统上下文注入、系统提醒
- **技能与插件生态**：技能定义与发现、插件系统、钩子系统、MCP 集成
- **权限与安全体系**：分层权限模型、规则模式匹配
- **故障恢复机制**：6 种内置恢复策略、模型降级
- **与 LangChain/ReAct 对比**：架构范式差异、为什么不用 ReAct
- **为什么 Claude Code 能做到这么好**：7 大核心设计原则

**适合人群**：想理解 AI Agent 框架设计的架构师、AI 应用开发者、技术研究者

---

## 🖼️ 配图说明

所有配图采用深色背景（#1a1a2e）+ Anthropic 品牌橙铜色（#D97757）风格，与 Claude Code 官方文档一致。

| 图片 | 说明 | 所属文档 |
|------|------|----------|
| `01-agent-overview.png` | 多 Agent 系统概览 — 架构全景 | 使用指南 |
| `02-agent-types.png` | 六种内置 Agent — 类型对比矩阵 | 使用指南 |
| `03-spawn-flow.png` | Agent 生成流程 — 四条路径决策树 | 使用指南 |
| `04-agent-teams.png` | Agent Teams 协作 — 团队通信拓扑 | 使用指南 |
| `05-architecture.png` | 实现架构总览 — 核心模块关系 | 实现原理 |
| `06-context-passing.png` | 上下文传递 — CacheSafeParams 数据流 | 实现原理 |
| `07-tool-pool.png` | 工具池系统 — 三层过滤流程 | 实现原理 |
| `08-background-task.png` | 后台任务引擎 — 生命周期状态机 | 实现原理 |
| `09-teams-mailbox.png` | Teams 邮箱系统 — 消息路由拓扑 | 实现原理 |
| `10-fork-cache.png` | Fork 缓存优化 — 字节级一致共享 | 实现原理 |
| `11-agent-framework-overview.png` | Agent 框架架构总览 — 核心组件关系 | 框架解析 |
| `12-agent-core-loop.png` | 核心 Agent 循环 — 五阶段状态机 | 框架解析 |
| `13-system-prompt-pipeline.png` | 系统提示词构建 — 分层缓存流水线 | 框架解析 |
| `14-context-compression.png` | 上下文压缩 — 四级渐进式策略 | 框架解析 |

---

## 🚀 快速开始

### 用户

1. 阅读 [使用指南](./01-usage-guide.md)
2. 了解六种内置 Agent 及其适用场景
3. 尝试在对话中使用 Agent 工具生成子代理
4. 探索 Agent Teams 多代理协作

### 开发者

1. 阅读 [实现原理](./02-implementation.md)
2. 查看源码位置：
   - `src/tools/AgentTool/` — Agent 工具实现
   - `src/tools/TeamCreateTool/` — 团队创建
   - `src/tools/SendMessageTool/` — 代理间通信
   - `src/utils/swarm/` — Swarm 协作基础设施
   - `src/utils/forkedAgent.ts` — Fork 代理上下文
   - `src/tasks/` — 任务管理系统
3. 理解四条生成路径和上下文传递机制

---

## 📝 核心概念速查

| 概念 | 说明 |
|------|------|
| **Agent Tool** | 主入口工具，接受 prompt + subagent_type 生成子代理 |
| **Subagent** | 独立执行任务的子代理，有自己的工具池和权限 |
| **Fork Agent** | 继承父代理完整上下文的分叉代理，共享 prompt cache |
| **Teammate** | Agent Teams 中的协作成员，通过邮箱通信 |
| **Worktree** | Git worktree 隔离模式，独立文件环境 |
| **LocalAgentTask** | 本地代理任务状态，追踪 running/completed/failed |
| **DreamTask** | 自动记忆整合任务，定期后台运行 |
| **CacheSafeParams** | 缓存安全参数，确保 API 请求前缀字节级一致 |
| **TeamFile** | 团队配置文件，存储成员列表和权限 |
| **Mailbox** | 基于文件的消息队列，支持队友间异步通信 |

---

## 🔗 相关资源

- [Claude Code Haha 主页](/)
- [记忆系统文档](/memory/01-usage-guide)
- [Agent Tool 源码](https://github.com/NanmiCoder/cc-haha/tree/main/src/tools/AgentTool/)
- [Swarm 基础设施](https://github.com/NanmiCoder/cc-haha/tree/main/src/utils/swarm/)
- [任务管理系统](https://github.com/NanmiCoder/cc-haha/tree/main/src/tasks/)
- [GitHub Issues](https://github.com/NanmiCoder/cc-haha/issues)
