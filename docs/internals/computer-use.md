---
title: Computer Use 架构
nav_title: Computer Use
description: macOS 原生引擎、Windows/Linux agent-desktop 接入、会话与输入边界。
order: 12
---

# Computer Use 架构

Computer Use 通过内置 MCP 把界面观察与桌面操作交给 Coding Agent。macOS 保留现有 JavaScript 会话与 Swift `cu-helper` 引擎；Windows 和 Linux 使用本仓库固定版本的 Vercel Labs `agent-desktop`。开启步骤见[使用指南](../desktop/computer-use.md)。

## 调用路径

```text
模型 / MCP client
  → setup.ts：平台、原生二进制、全局启用状态
  → MCP 工具定义与 wrapper.tsx：参数、取消信号、当前 Agent 上下文
  → 产品 Computer Use 会话锁
      ├─ macOS：JS / AX 语义工具 → cu-helper daemon → AX / 定向输入 / 窗口截图
      └─ Windows / Linux：desktop 工具 → agentDesktopBridge → agent-desktop CLI
                                                    ├─ Windows：UI Automation
                                                    └─ Linux：AT-SPI / X11 / Wayland 能力
```

`setupComputerUseMCP()` 只在受支持的平台且对应二进制可解析时注册工具。设置 API 另行执行真实的原生状态探测：Windows/Linux 返回 `engine: "agent-desktop"`、`runtime: "agent-desktop"` 与 `agentDesktop` 状态。缺二进制、辅助功能服务拒绝或 Linux 总线无响应都不能显示为就绪。就绪表示运行组件可用，不保证每个命令或每个应用都受支持。

桌面会话逐轮刷新 Computer Use 工具。显式指定 Computer Use 时，CLI 在发起模型请求前检查最终工具清单。不可用时返回具体原因。可用时，本轮的桌面动作通过原生工具执行。

## 一个全局应用授权入口

用户在设置中开启 Computer Use 并确认一次 consent，即授权所有受支持应用。运行时不再按应用弹窗，不建立应用 allowlist、denylist 或 `read/click/full` 权限分层。全局禁用、操作系统权限、目标进程与窗口有效性仍需检查。

`computer-use-config.json` 保留历史 `authorizedApps`、`grantFlags`、`pythonPath` 和未知字段，避免覆盖用户配置；这些历史应用记录不构成新的应用授权边界。Windows/Linux 生产入口不再检测或安装 Python，`/setup` 只返回原生运行组件说明。macOS 仍通过原生权限卡处理辅助功能与屏幕录制。

## macOS 引擎保持独立

macOS 的持久 JS 工具运行在隔离子进程中，暴露 `cua.getApp()`、App 操作与 AX/截图读取。原生调用经过有身份校验的 NDJSON daemon 通道进入 `native/cu-helper/`。

- 元素使用带快照与窗口 epoch 的句柄、语义 fingerprint 和进程身份重新解析，避免把旧索引套到新界面。
- 点击等动作优先使用 AX 行为；需要合成事件时用 `CGEvent.postToPid` 与目标窗口路由，不移动真实鼠标，不向全局 HID 输入流投递。
- 合成焦点协议让后台应用接受输入；前台 lease 检查真人干预。目标自行抢前台时仅在证据允许的情况下恢复原前台，不盲目重试。
- 截图绑定目标窗口、进程身份和坐标变换。ScreenCaptureKit 流用于被遮挡窗口；无法证明画面新鲜时不把缓存截图当作成功证据。
- 系统剪贴板仍是共享资源；粘贴路径有内容备份与 change-count 保护。用户同时操作同一应用仍可能干扰结果。

这条路径不调用 `agent-desktop`，也不回退到 Python。

## Windows/Linux 的单个 desktop 工具

`buildAgentDesktopTools()` 暴露一个 MCP 工具，而不是把 CLI 命令拆成 60 个 MCP 工具：

```json
{"command":"snapshot","args":["--app","APP","-i"]}
```

`command` 允许固定上游版本的完整 **60 个命令名称**，包括观察、ref 操作、鼠标键盘、应用与窗口、通知、剪贴板、wait、batch、session、trace、status、permissions 和 skills。名称可用不等于每个平台都实现其动作，例如 held-input 命令会按上游规则明确拒绝。

首次使用先通过同一工具加载内嵌指南：

```json
{"command":"skills","args":["get","desktop"]}
{"command":"skills","args":["get","platform"]}
```

`args` 是 argv 字符串数组，不经过 shell。宿主管理 `--session`、`--agent-id`、trace 与图像输出路径；调用者通过 `headed: true` 请求本次命令允许物理输入，不能自行覆盖宿主身份。`batch` 顺序执行，同样经过命令与策略检查，不是事务。

观察得到的 ref 必须完整保留，例如 `@s8f3k2p9:e1`。动作重新校验 live identity；`STALE_REF` 或 `AMBIGUOUS_TARGET` 应重新观察。不能用裸 `@e1`，也不能从另一个 native session 借用快照。

### headless 与输入副作用

默认 headless 的核心是受支持的 ref 语义操作不移动真实指针，并在需要不被允许的物理操作时拒绝。它仍要求可用的图形用户会话，也不是所有命令的无副作用总开关。

| 路径 | 实际行为 |
|---|---|
| Windows 语义 ref | 使用 UIA Invoke、Value、Selection、Toggle 等模式。标准 WinForms 按钮和编辑框的后台点击、设值与清空使用 LegacyIAccessible，避开 Windows 代理的焦点切换 |
| Windows `type`、右键、多击、focus | 需要 `headed: true`；`type` 使用 `SendInput`，不能声称是后台定向键盘 |
| Linux headless ref | AT-SPI 语义动作，X11 与 Wayland 都可用；是否可执行由控件能力与 live identity 决定 |
| Linux headed ref | `click`、`right-click`、`type` 优先尝试物理输入；只有明确未投递的受支持拒绝才可能回退语义路径 |
| Linux 物理指针 | 普通应用只支持 X11，使用共享指针；Wayland 明确拒绝。Wayland 部分键盘路径依赖 Mutter RemoteDesktop 能力 |
| 裸 `press`、`focus-window`、剪贴板 | 即使没传 headed，也可能向当前前台发键、切前台或读写共享剪贴板；带目标的 press 会额外验证前台归属 |

Windows 最小化窗口应先恢复再观察；`focus-window` 会抢前台，不能当作后台动作的惯常准备步骤。Linux Wayland 的窗口操作与截图有额外限制：原生窗口不能按 X11 方式移动或聚焦，截图经过 portal 并可能需要真人同意，剪贴板需要 `wl-clipboard`。X11 也不能假定所有 compositor 都支持全屏捕获。

JSON envelope 中的 `delivery`、`retry` 与验证范围必须保留。已投递但未验证、部分投递、超时或取消后的结果未知，都需要先读当前状态；不能根据 `ok` 或一次键鼠投递就盲目重放业务动作。

## 会话、trace 与多 Agent 光标

bridge 把 `AGENT_DESKTOP_HOME` 定向到产品配置目录。Windows 使用由原生引擎设定私有 DACL 的 `.runtime/agent-desktop-private/`，Linux 使用 `.runtime/agent-desktop/`。Windows 的就绪探针在会话目录内验证写入、读回和清理，失败原因会显示在设置页。需要操作的首次调用创建宿主管理的原生会话并启用多 Agent 光标配置，渲染器按动作启动。

业务命令保留当前 Agent 的 `getCwd()` 异步上下文，相对图像与文件路径按该工作目录解析；状态目录由 `AGENT_DESKTOP_HOME` 单独控制。每次派发原生进程前都会重新检查已保存的全局授权，包括会话初始化和光标配置之后的实际动作；撤销授权仍允许必要的资源清理。

每个产品会话关联 native session，主 Agent 与子 Agent 通过宿主传入各自 `agent-id`；名字不合法时使用稳定散列。快照与 trace 受 native session 命名空间约束。trace 可能保留界面与动作信息，应作为用户数据处理；图像通过宿主受限的 artifact 目录读取并作为 MCP image 返回。trace 导出仍是原生命令能力。

Windows 光标使用动作的物理像素坐标，按所在显示器的 DPI 缩放箭头和标签。宿主把回合内的空闲淡出延迟设为 45 秒。渲染器在目标帧提交到 Windows 合成窗口后才确认到达，绘制失败时返回警告。Linux X11 在动作位置显示静态箭头。动作结果的 `cursor_overlay` 分别报告光标配置、渲染确认和警告。输入设备和剪贴板由系统共享。

产品原有的 `computer-use.lock` 仍以产品 session 为 owner，一次只允许一条产品会话持有，turn 结束或取消时释放。同一进程的主 Agent/子 Agent 共享 binder，保留各自异步上下文并按队列执行；上游的交互 lease 另行约束原生动作。多 Agent 身份与光标不等于多 Agent 同时写独立桌面。

turn 清理会关闭当前 native 光标，清理失败或超时会把宿主状态标为未知，下一次动作重新配置光标。进程 shutdown 会取消正在运行的原生命令并结束其拥有的全部 native session，包括切换产品会话前创建的会话。会话停止按钮和 CLI 的 Ctrl+C 传递取消信号；POSIX 取消给上游输入释放保留两秒预算，并在子进程退出后才放行队列。当前宿主没有可承诺的跨应用全局 Esc 停止快捷键。

## 构建与分发

固定来源为 Vercel Labs `agent-desktop` **1.0.2**，commit `9eb9b296192fcb70bda25e918cd6dd66abfa3d0d`。`native/agent-desktop/UPSTREAM.json` 记录固定版本及复制文件摘要，`PATCHES.md` 记录产品光标外形等本地改动。

准备 stable Rust 工具链、目标标准库、系统链接依赖和锁定的 Cargo 缓存后，构建脚本离线执行。首次准备缓存可用：

```sh
cargo +stable fetch --locked --manifest-path native/agent-desktop/Cargo.toml
```

在对应平台 runner 上构建；以 Linux x64 开发构建为例：

```sh
bun desktop/scripts/native-agent-desktop.ts --target-triple x86_64-unknown-linux-gnu --debug
```

`desktop/scripts/build-sidecars.ts` 集成该脚本，使用 `cargo +stable build --locked --offline`，将 CLI 放入 `desktop/src-tauri/binaries/`。Linux 还必须把 `agent-desktop-linux-clipboard-owner` 放在 CLI 旁；Windows 使用 `.exe`。macOS 打包继续构建原 Swift helper。生成的二进制、Cargo target 与 manifest 不提交到仓库。

开发 resolver 可读取源码树下的 Cargo target；打包 resolver 从应用的 binaries 目录读取。Electron 将这些文件放在 `app.asar.unpacked`，同时携带 `agent-desktop-licenses/` 下的 `LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES`、`UPSTREAM.json` 与 `PATCHES.md`。上游原有代码按 Apache-2.0 授权，原授权不因根目录的 Community Source License 而被收窄；依赖保留各自许可。不能删掉这些声明后仅分发可执行文件。

## 主要源码入口

| 路径 | 职责 |
|---|---|
| `src/utils/computerUse/setup.ts`、`common.ts`、`gates.ts` | 平台 capability、二进制门禁与工具注册 |
| `src/vendor/computer-use-mcp/mcpServer.ts`、`src/utils/computerUse/wrapper.tsx` | 会话绑定、异步上下文、取消与产品锁 |
| `src/vendor/computer-use-mcp/agentDesktopTools.ts`、`agentDesktopProtocol.ts`、`agentDesktopDispatch.ts` | 单 MCP 工具、完整命令 schema 与队列 |
| `src/utils/computerUse/agentDesktopBridge.ts`、`agentDesktopBinary.ts`、`agentDesktopProcess.ts`、`agentDesktopResult.ts` | native session、解析、受控子进程与图像交付 |
| `native/cu-helper/` | macOS AX、定向事件、焦点与窗口捕获 |
| `native/agent-desktop/` | 固定上游 Rust workspace 与平台实现 |
| `src/server/api/computer-use.ts` | 状态、全局配置与 macOS 权限卡 API |
| `desktop/src/pages/ComputerUseSettings.tsx` | 平台状态、全局启用确认与恢复说明 |

回归测试应使用临时配置目录、fake runner 或 loopback transport，验证参数、状态与结果边界；不得拿真人桌面、真实 provider 或用户配置当测试夹具。平台真机 smoke 是另一类证据，不能用 macOS 构建或 mock 结果代替 Windows/Linux 输入验证。

Session 身份由宿主管理。显式 `session start` / `session end` 必须单独调用；`batch` 内的生命周期变更会被拒绝，避免后续命令继续绑定已结束的 session 或留下旧光标。
