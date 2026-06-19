# 桌面端文档

> 图形化的 AI Code Editor，支持多会话、多标签、IM 接入的完整桌面体验。

![桌面端界面](../images/desktop_ui/01_full_ui.png)

---

## 文档目录

### [快速上手](./01-quick-start.md)

面向用户的桌面端使用指南：界面布局、对话操作、多标签、权限控制、项目管理、模型配置、IM 适配器、定时任务。

### [架构设计](./02-architecture.md)

面向开发者的技术架构：三层架构（Electron Host → Server → CLI）、WebSocket 协议、HTTP API、状态管理、协议代理、适配器桥接、目录结构。

### [功能详解](./03-features.md)

深入每个功能模块：聊天引擎、代码展示、工具调用、Agent Teams、提供商管理、技能/Agent、定时任务、IM 适配器、设计系统。

### [安装指南](./04-installation.md)

下载安装、macOS/Windows 常见问题、Web UI 模式。

### [H5 访问](./06-h5-access.md)

面向个人和团队的可选浏览器访问：开启 H5、生成 Token、配置允许来源、通过局域网或反向代理在手机上访问聊天界面。

### [Tauri 迁移 Electron 调研索引](./07-electron-migration-research.md)

桌面端从 Tauri 2 迁移到 Electron 的系统能力盘点、React 复用边界、目标架构、安全要求和迁移路径。

### [Electron 迁移任务清单](./08-electron-migration-tasks.md)

逐阶段执行清单：host adapter、Electron main/preload、系统能力、build/release、跨平台 smoke 和 Computer Use 验收。

### [Electron 迁移验证清单](./09-electron-migration-validation-checklist.md)

迁移收口验证：自动化证据、Review 收口项、macOS Computer Use smoke、Windows/Linux 实机验收边界。

### [Electron 发布与自动更新](./10-release-auto-update.md)

维护者发版 runbook：Developer ID 签名、GitHub Release metadata、`v0.4.3 -> v0.4.4` 自动更新验证路径。

### [Electron 迁移交互式验收清单](/desktop/electron-migration-qa-checklist.html)

本地浏览器可直接打开的验收 checklist，支持勾选进度、记录问题、导出 Markdown。

### [本地 MCP 端到端测试（浏览器路径）](./10-local-mcp-testing.md)

绕开 Electron 容器，用 Chrome DevTools MCP 直接驱动桌面 UI 做端到端烟雾的工作流：Vite proxy 同源化、可测/不可测清单、`feat/agent-routing-hardening` 改动的对应复现配方、故障字典。

---

## 快速开始

### 用户

1. 阅读 [安装指南](./04-installation.md) 下载安装
2. 阅读 [快速上手](./01-quick-start.md) 了解界面和操作
3. 配置 AI 模型提供商，开始对话

### 开发者

1. 阅读 [架构设计](./02-architecture.md) 理解三层架构
2. 关键源码位置：
   - `desktop/src/` — React 前端
   - `desktop/electron/` — Electron main/preload/系统能力 host
   - `desktop/src-tauri/` — 历史资源目录，当前仅作为 sidecar、图标和 preview agent 的 Electron 打包输入
   - `desktop/sidecars/` — Sidecar 入口
   - `src/server/` — Express API 服务端
   - `adapters/` — IM 适配器

---

## 核心概念

| 概念 | 说明 |
|------|------|
| **Electron Host** | 跨平台桌面壳层，管理窗口、系统能力、Sidecar 进程和更新 |
| **Sidecar** | 随主进程启动的后台服务，运行 API 服务器 |
| **Session** | 一次对话会话，绑定工作目录，通过 WebSocket 通信 |
| **Tab** | 标签页，对应一个 Session 或特殊页面 |
| **Provider** | AI 模型提供商，支持 Anthropic/OpenAI 兼容接口 |
| **Adapter** | IM 适配器，Telegram/飞书接入 Claude Code |
| **Store** | Zustand 状态容器，按领域拆分管理 |
