---
title: 架构总览
nav_title: 架构总览
description: 五层代码怎么分工，一条消息怎么流过它们，以及改动某块功能该从哪篇读起。
order: 0
---

# 架构总览

Claude Code Haha 看着是一个桌面应用，实际是五块可以各自独立运行的代码拼起来的。想读源码或者提 PR，先把这五块的边界分清楚，后面每一篇都会落在其中一块里。

```text
desktop/src/          前端 —— React + Zustand，只画界面，不碰系统能力
desktop/electron/     桌面壳 —— Electron 主进程，管窗口、更新、终端、原生预览
src/server/           本地 Server —— Bun.serve 的 REST + WebSocket，桌面端和手机端共用
src/                  CLI 内核 —— Agent 循环、工具系统、权限、记忆、Skills
adapters/             IM 接入 —— 每个平台一个独立 sidecar，桥回同一套会话
```

三条事实值得先记住：

- **CLI 内核是唯一执行方**。桌面端每开一个会话，Server 就拉起一个 CLI 子进程；前端点的每个按钮最后都变成发给它的一条消息。
- **本地 Server 是唯一入口**。桌面端、手机 H5、IM adapter 走的是同一套 REST 与 WebSocket，只是鉴权等级不同。
- **Electron 是当前桌面主路径**，`desktop/src-tauri/` 只保留打包资源和历史代码作回滚，不是运行时。

## CLI 内核怎么分层

![CLI 内核的整体分层](../images/01-overall-architecture.png)

入口层做完初始化后分成两侧：左侧是把一次请求跑完的主链路（终端界面 → 查询引擎 → 工具系统 → 子 Agent），右侧是被主链路调用的横切能力（状态管理、Skills 与插件、MCP / OAuth / 记忆等服务）。桌面端接管了终端界面那一格，其余部分原样复用。

## 一条消息经过什么

![一次请求的生命周期](../images/02-request-lifecycle.png)

用户输入被解析、组装上下文后发给模型，流式返回里一旦出现工具调用，就先过权限校验再执行，结果回填进上下文继续下一轮，直到模型不再请求工具。桌面端看到的「工具调用卡」「权限询问卡」，就是这条链路上两个节点的可视化。

## 工具和权限的关系

![工具系统与权限门](../images/03-tool-system.png)

所有工具在同一个注册中心登记，按能力分成文件、命令、系统、子 Agent、外部集成和通信几类。真正决定安全边界的是下面那条固定管线：任何一次调用都要先过参数校验和权限门，再进沙箱执行。加新工具时，接进注册中心不难，难的是想清楚它落在权限门的哪一侧。

## 我想改 X，该看哪篇

| 你想动的东西 | 从这篇开始 |
|---|---|
| 窗口、托盘、自动更新、内嵌终端、原生预览 | [桌面端架构](./desktop.md) |
| REST 接口、WebSocket 事件、鉴权、Provider 代理 | [本地 Server 与 API](./server.md) |
| 不知道某个功能的代码在哪个目录 | [项目结构](./structure.md) |
| 子 Agent 的行为、内置 Agent、Agent Teams | [多 Agent 使用指南](./agent.md) |
| 子 Agent 的生成路径、工具池过滤、后台任务引擎 | [多 Agent 实现原理](./agent-internals.md) |
| Agent 主循环、系统提示词、上下文压缩 | [Agent 框架深度解析](./agent-framework.md) |
| Skill 的写法、来源优先级、触发方式 | [Skills 使用指南](./skills.md) |
| Skill 的发现、注入、fork 执行 | [Skills 实现原理](./skills-internals.md) |
| 记忆存在哪、什么时候写 | [记忆系统使用指南](./memory.md) |
| 记忆的注入、提取、检索、团队同步 | [记忆系统实现原理](./memory-internals.md) |
| 后台自动整合记忆 | [AutoDream 记忆整合](./autodream.md) |
| 屏幕控制的工具、授权、坐标换算 | [Computer Use 架构](./computer-use.md) |
| IM 消息协议、访问控制、权限中继 | [Channel 系统](./channel.md) |
| 提 PR 前要跑哪些检查、发版流程 | [参与贡献与质量门禁](./contributing.md) |
| 在终端里跑 CLI、写自动化脚本 | [CLI 安装与启动](../cli/index.md) |

产品功能怎么用不在这个分区，从 [开始使用](../start/index.md) 和 [桌面端功能](../desktop/index.md) 进。
