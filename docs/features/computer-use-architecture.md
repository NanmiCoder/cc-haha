# Computer Use 架构

> 本页说明 Computer Use 的工具、授权、平台执行器与当前安全边界。使用步骤请先阅读 [Computer Use 使用指南](./computer-use.md)。

## 分层结构

```text
模型 / MCP Client
  ↓
工具定义与参数校验
  src/vendor/computer-use-mcp/tools.ts
  ↓
会话授权与安全调度
  src/vendor/computer-use-mcp/toolCalls.ts
  src/vendor/computer-use-mcp/mcpServer.ts
  ↓
Claude Code Haha 集成
  src/utils/computerUse/
  ↓
Python Bridge
  src/utils/computerUse/pythonBridge.ts
  ↓
平台 Helper
  runtime/mac_helper.py
  runtime/win_helper.py
```

工具层与安全调度尽量保持平台无关。平台差异集中在 `ComputerExecutor` capability 和 Python helper 中。

## 工具注册

`buildComputerUseTools()` 生成 MCP 工具定义。代码中共有 27 个 schema：

- 24 个基础控制工具
- 3 个 Teach 工具：`request_teach_access`、`teach_step`、`teach_batch`

Teach 工具由 `caps.teachMode` 控制。宿主没有开启该 capability 时，`ListTools` 只返回基础工具。因此，“代码定义 27 个”与“每个运行时固定暴露 27 个”不是同一个事实。

MCP Server 有两条使用路径：

- `src/utils/computerUse/mcpServer.ts` 构造 CLI 使用的服务，并把已安装应用名称加入授权工具说明。
- `src/vendor/computer-use-mcp/mcpServer.ts` 绑定实际会话上下文，保存最近截图和授权状态。

`src/utils/computerUse/setup.ts` 生成动态 MCP 配置和允许工具名。实际工具调用仍由 Computer Use 自己的应用授权流程控制，而不是绕过授权直接执行。

## 会话状态

每个绑定会话维护：

- 已授权应用及其权限等级
- 剪贴板和系统组合键授权
- 当前显示器
- 最近一次截图及坐标几何
- Computer Use 会话锁
- Teach 是否处于活动状态

最近截图是后续点击坐标的参考。截图尺寸、逻辑显示尺寸、缩放比例和显示器原点必须作为一个整体保存，否则 Retina 或多显示器环境会点击到错误位置。

## 坐标与截图

工具只向模型公开一种坐标模式：

- `pixels`：坐标来自模型最近看到的截图
- `normalized_0_100`：以屏幕宽高百分比表示

工具描述与执行器读取同一份冻结后的坐标配置，避免模型按一种坐标描述输出，Host 却按另一种模式换算。

典型换算：

```text
模型截图坐标
  → 按截图尺寸映射到逻辑显示尺寸
  → 加上目标显示器原点
  → 交给平台 helper
```

截图会按图像预算缩放，但不应在文档中硬编码某个固定输出尺寸。

## 授权与动作检查

Computer Use 在动作执行前组合多类检查，而不是依赖单一权限弹窗。

### 全局开关与系统权限

- `CLAUDE_COMPUTER_USE_ENABLED=0` 或托管配置可关闭能力。
- macOS 需要 Accessibility 和 Screen Recording。
- Windows 不使用 macOS TCC，但仍受应用授权和动作检查约束。

### 会话互斥

会话锁确保同一时间只有一个会话控制系统输入。锁带进程和会话信息，并支持失效进程恢复。正常使用时不应要求用户手工删除锁文件。

### 应用白名单与前台检查

输入动作前会读取当前前台应用。如果它不在会话白名单中，动作被拒绝。应用授权按 `read`、`click` 和 `full` 三个等级限制能力。

平台截图能力不同：

| 平台 | `screenshotFiltering` | 行为 |
|---|---|---|
| macOS | `native` | 在截图合成层排除未授权应用窗口 |
| Windows | `none` | 截图可能包含所有可见窗口；输入白名单仍生效 |

Windows 的“输入不会落到未授权应用”不能推导为“截图不会泄露其他窗口”。

### 剪贴板与系统按键

剪贴板读取、写入和系统级组合键使用独立 grant flags。多行输入可能使用剪贴板快路径，执行器会尽力保存并恢复原内容，但只有用户批准相应标志后才能使用。

危险系统组合键还会经过专门的按键检查。普通应用授权不会自动放开退出应用、切换应用或锁屏等系统动作。

### 像素陈旧检查

工具层保留点击位置的像素比较能力，用于检测“模型看到截图后 UI 已变化”的情况。当前默认配置中 `pixelValidation` 为关闭状态，所以模型仍应在界面变化后主动重新截图。

## 当前不提供的能力

### 没有全局 Escape

`src/utils/computerUse/escHotkey.ts` 当前不注册系统级 Escape 中止。桌面 Host 和文档不能宣称用户可以在任何应用中按 Escape 强制停止。

### 不自动隐藏窗口

执行器保留 `prepareForAction()` 和 `previewHideSet()` 接口，但当前 macOS 与 Windows helper 不会根据白名单自动隐藏窗口；回合结束的 `unhideComputerUseApps()` 也是空操作。

因此：

- 不能把 `hideBeforeAction` 配置解释为已经实现的隐私保证。
- Windows 截图前应由用户自己关闭或最小化敏感窗口。
- macOS 的隐私保证来自原生截图过滤，而不是窗口自动隐藏。

## Teach 工作流

Teach 是在同一授权和动作调度之上的引导层：

```text
request_teach_access
  → 用户批准教学应用
  → Teach 会话激活
  → teach_step / teach_batch
  → 展示提示、等待 Next、执行动作、返回新截图
  → 用户退出或回合结束
```

关键约束：

- Teach 使用独立授权入口，不继承普通控制中的剪贴板和系统按键标志。
- `teach_step` 的文案是教学覆盖层中用户能看到的主要说明。
- `teach_batch` 适合界面可预判的连续步骤；界面变化不可预判时应回到单步。
- Teach 活动期间不能弹出会被隐藏的普通授权对话框。
- 用户选择退出后，后续 Teach 调用必须停止。
- 是否公开 Teach 工具由宿主 capability 决定。

## Python Bridge

`src/utils/computerUse/pythonBridge.ts` 负责：

1. 确定用户配置目录中的 `.runtime`。
2. 同步当前平台的 helper 和 requirements。
3. 使用自动检测或用户配置的 Python 创建 venv。
4. 依据 requirements 哈希安装或更新依赖。
5. 以 `command + JSON payload` 调用 helper。
6. 把统一 JSON 结果或错误返回 TypeScript。

运行时文件：

| 路径 | 职责 |
|---|---|
| `runtime/mac_helper.py` | macOS 截图、应用、鼠标、键盘和剪贴板 |
| `runtime/win_helper.py` | Windows 对应实现 |
| `runtime/requirements.txt` | macOS Python 依赖 |
| `runtime/requirements-win.txt` | Windows Python 依赖 |

Helper 每次调用是一个有边界的子进程请求。它不会直接读取模型状态；所有会话授权和动作策略都在 TypeScript 层决定。

## Host 集成

### CLI

`src/utils/computerUse/` 负责：

- 判断 macOS/Windows 支持状态
- 创建 `ComputerExecutor`
- 构造动态 MCP
- 绑定权限 UI 和会话状态
- 管理预授权应用及 Python 路径

### Desktop

桌面设置页通过 `src/server/api/computer-use.ts`：

- 读取和修改启用状态
- 检查与安装 Python 运行时
- 检查 macOS 系统权限
- 管理预授权应用
- 管理剪贴板和系统组合键标志

桌面设置只是配置入口。实际工具调用仍在 CLI 会话的 MCP 和授权边界内执行。

## 关键源文件

| 路径 | 职责 |
|---|---|
| `src/vendor/computer-use-mcp/tools.ts` | 工具 schema 和 Teach 工具 |
| `src/vendor/computer-use-mcp/toolCalls.ts` | 动作分发、授权与安全检查 |
| `src/vendor/computer-use-mcp/mcpServer.ts` | MCP Server 和会话绑定 |
| `src/vendor/computer-use-mcp/types.ts` | capability、授权和会话类型 |
| `src/utils/computerUse/common.ts` | 平台支持和 capability |
| `src/utils/computerUse/gates.ts` | 启用开关和子能力默认值 |
| `src/utils/computerUse/executor.ts` | Python Bridge 执行器 |
| `src/utils/computerUse/pythonBridge.ts` | venv、依赖和子进程协议 |
| `src/utils/computerUse/wrapper.tsx` | CLI 权限交互和会话上下文 |
| `src/server/api/computer-use.ts` | 桌面设置 API |
| `desktop/src/pages/ComputerUseSettings.tsx` | 桌面设置界面 |

## 修改时的验证重点

- 工具 schema 与 dispatch 支持的 action 保持同步。
- Tool 描述的坐标模式与执行器换算一致。
- macOS 与 Windows capability 文案不混用。
- 未授权前台应用的输入必须被拒绝。
- Windows 测试不能假设截图过滤存在。
- Teach capability 关闭时不应公开 Teach 工具。
- 配置迁移不能覆盖用户未知字段。
- Python 测试使用临时配置目录，不读取真实用户运行时。
