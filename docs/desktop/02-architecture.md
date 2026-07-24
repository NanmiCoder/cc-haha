# 桌面端架构

> 本页面向维护者，说明 Claude Code Haha 桌面端当前的 Electron、Bun Server 和 CLI 运行边界。

## 架构概览

桌面端不是把 CLI 直接嵌进 React。它由四类进程协作：

```text
Electron main
├── Chromium renderer（React UI）
├── claude-sidecar server
│   ├── Bun.serve HTTP API
│   ├── Bun WebSocket 会话网关
│   └── 按会话启动 CLI 子进程
└── claude-sidecar adapters（按平台独立启动）
    ├── Telegram
    ├── Feishu
    ├── WeChat
    ├── DingTalk
    └── WhatsApp
```

- **Electron main** 负责窗口、系统对话框、更新、终端、原生预览、宠物窗口和 Sidecar 生命周期。
- **Renderer** 只负责界面，通过 preload 暴露的 `window.desktopHost` 使用原生能力。
- **Server Sidecar** 是桌面端和 H5 共用的本地服务，提供 REST、WebSocket、Provider 代理和会话管理。
- **CLI 子进程** 执行模型请求、工具调用和 Agent 编排。
- **Adapter Sidecar** 把 IM 平台消息桥接到同一套 Server/CLI 会话。

`desktop/src-tauri/` 目前只是保留打包资源和历史代码的位置，不是桌面运行时。当前桌面 Host 是 Electron。

## 当前技术栈

| 层 | 主要技术 | 用途 |
|---|---|---|
| Renderer | React 18、Vite 8、TypeScript、Zustand 5 | 桌面 UI 与状态管理 |
| 样式与内容 | Tailwind CSS 4、Marked、DOMPurify、Shiki 4、Mermaid、KaTeX | 布局、Markdown、代码和图表 |
| Diff | `react-diff-viewer-continued` | 对话和工作区中的 Diff 展示 |
| Electron Host | Electron、electron-builder、electron-updater | 原生窗口、打包和更新 |
| 终端 | node-pty、xterm.js | 原生 PTY 与终端渲染 |
| 本地服务 | Bun、`Bun.serve` | HTTP API 与 WebSocket |

版本以 `desktop/package.json` 为准。本页只列会影响架构理解的主版本，避免复制完整依赖清单。

## Electron Host

核心入口与边界：

| 路径 | 职责 |
|---|---|
| `desktop/electron/main.ts` | Electron main 入口、窗口与 IPC 注册 |
| `desktop/electron/preload.ts` | 向主 renderer 暴露类型化 Host API |
| `desktop/electron/preview-preload.ts` | 原生网页预览的隔离桥接 |
| `desktop/electron/pet-preload.ts` | 宠物窗口的最小能力桥接 |
| `desktop/electron/ipc/` | IPC channel 注册和 payload 校验 |
| `desktop/electron/services/` | Sidecar、更新、终端、预览、窗口、代理等系统服务 |

Renderer 不应直接导入 Electron，也不应自行拼接任意 IPC channel。新增原生能力时，应同时更新 Host contract、main 侧校验和相关测试。

### 启动流程

1. Electron 解析默认或便携存储模式，并准备应用配置目录。
2. Host 选择可用端口，启动统一的 `claude-sidecar server` 二进制。
3. Sidecar 从 `src/server/index.ts` 进入 `startServer()`，使用 `Bun.serve` 同时承载 HTTP 和 WebSocket。
4. 健康检查通过后，Renderer 获取 loopback Server URL 并加载会话与设置。
5. Host 根据已配置的平台启动对应 Adapter Sidecar。
6. Server 在用户开始会话时按需启动 CLI 子进程。

Server 可绑定局域网可访问地址以支持 H5，但桌面 Renderer 使用 loopback 控制地址。H5、远程访问和宠物窗口分别经过其对应的 Token 与能力限制，不能因为本地 Server 已启动就假定所有来源都可信。

### Sidecar 入口

`desktop/sidecars/claude-sidecar.ts` 是统一入口：

```text
claude-sidecar server   --app-root <path> --host <host> --port <port>
claude-sidecar cli      --app-root <path> [CLI arguments]
claude-sidecar adapters --app-root <path> --telegram|--feishu|--wechat|--dingtalk|--whatsapp
```

Sidecar 在导入业务模块前设置 `CLAUDE_APP_ROOT`、`CALLER_DIR` 和启动参数，因为 Server、CLI 与 Adapter 的顶层模块会读取这些值。

## Server Sidecar

真实 Server 入口是 `src/server/index.ts`，不是单独的 `server.ts` 包装层。

```text
src/server/
├── index.ts          # Bun.serve、鉴权、CORS、升级和静态 H5
├── router.ts         # REST 资源路由
├── api/              # API 边界
├── services/         # 会话、Provider、索引、诊断等业务服务
├── ws/               # WebSocket 协议与会话生命周期
├── proxy/            # Provider 协议与流式响应转换
├── middleware/       # Auth、CORS 和错误边界
└── config/           # Provider 预设
```

`Bun.serve` 的同一个 `fetch` 边界处理：

- `/api/*` REST 请求
- `/ws/:sessionId` 桌面、H5 和宠物客户端连接
- `/sdk/:sessionId` CLI 内部连接
- OAuth 回调
- 受限的预览与本地文件访问
- 打包后的 H5 静态资源

鉴权规则按客户端能力区分。新增路由时，必须先确定它属于本地桌面、H5、宠物、内部 SDK 还是公开静态资源，再放进对应的认证和 CORS 边界。

## WebSocket 语义

Renderer 为每个会话维护一条连接：

```text
ws://<server>/ws/<sessionId>
```

如果 Server 启用了认证，客户端会把 Token 放在连接查询参数中。连接成功后，Server 会发送当前会话标识、尚未处理的权限请求快照和运行状态。

### 心跳与重连

当前 `desktop/src/api/websocket.ts` 的行为是：

- 连接后每 30 秒发送一次 `ping`。
- 10 秒内没有收到 `pong`，客户端主动关闭连接并进入重连。
- 重连延迟从 1 秒开始指数增长，最高封顶 30 秒。
- 自动重连没有固定的最大尝试次数；显式关闭会话才停止。
- 断线期间发送的消息进入内存队列。
- 重连成功后先发送队列中的消息，再发送 `sync_state` 获取 Server 的权威运行状态。

因此，不应把旧文档里的“最多重试 10 次”当成当前语义。

### 客户端断开不等于停止任务

最后一个客户端断开后：

- 正在运行的前台回合或后台任务继续执行。
- 工作结束后才进入空闲宽限期。
- 客户端在宽限期内重连会取消清理。
- 超过宽限期且没有客户端，Server 才停止对应 CLI。
- 等待权限的会话有独立的有界清理策略，避免永久占用进程。

这让手机锁屏、Renderer 刷新或短暂网络切换不会直接中断正在运行的任务。

## CLI 与 Provider 代理

Server 按会话启动 CLI，并通过内部协议转发输出、权限请求、工具结果和后台任务状态。会话的 Provider、模型、effort 和权限模式由 Server/CLI 共同维护，Renderer 不是唯一真相来源。

`src/server/proxy/` 处理支持的 Provider 协议：

- Anthropic Messages
- OpenAI Chat Completions
- OpenAI Responses

Provider 的模型映射、认证方式和上下文设置以实际 Provider 配置为准，不应在架构文档中硬编码厂商清单。

## IM Adapter

每个平台使用独立 Adapter Sidecar，避免一个平台的凭据或启动失败拖垮其他平台。

```text
IM 平台
  → adapters/<platform>
  → adapters/common WebSocket bridge
  → Server Sidecar
  → CLI 会话
```

共享层位于 `adapters/common/`，负责配置、配对、会话映射、消息缓冲、去重、附件和 Server WebSocket 桥接。当前平台目录包括：

- `adapters/telegram/`
- `adapters/feishu/`
- `adapters/wechat/`
- `adapters/dingtalk/`
- `adapters/whatsapp/`

## 持久化边界

不同数据不共享同一个存储：

| 数据 | 主要边界 |
|---|---|
| Renderer UI 偏好与打开标签 | 浏览器存储及其迁移 |
| 会话与消息 | Server/CLI 管理的本地会话数据 |
| Provider、H5、Computer Use 等设置 | Server 管理的配置文件 |
| Electron 窗口和原生状态 | Electron user data / 应用模式目录 |
| IM 配置和配对状态 | Adapter 配置与各平台状态目录 |

任何 JSON、`localStorage` 或应用配置形状变化都必须带前向迁移和旧数据回归测试。不要直接覆盖用户的共享 Claude 配置，也不要在测试中读取真实用户目录。

## 构建与验证

桌面构建由 `desktop/package.json` 的脚本编排：

```bash
cd desktop
bun run build:sidecars
bun run build
bun run build:electron
```

`electron:package` 在此基础上运行 electron-builder。打包产物验证只能证明资源和安装包结构正确；涉及窗口、权限、终端、预览、更新或 Computer Use 的用户流程，还需要真实桌面 Smoke 验证。
