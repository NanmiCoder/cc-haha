# Computer Use 使用指南

Computer Use 允许模型读取屏幕并操作鼠标、键盘、应用和剪贴板。它直接作用于当前电脑，启用前请先理解授权范围和平台差异。

## 支持平台

| 平台 | 状态 | 关键差异 |
|---|---|---|
| macOS Apple Silicon / Intel | 支持 | 需要“辅助功能”和“屏幕录制”权限；支持原生截图过滤 |
| Windows | 支持 | 使用 Windows Python 运行时；截图不会过滤未授权窗口 |
| Linux | 不支持 | 当前没有 Linux 执行器 |

打包桌面端不要求用户安装 Bun。Computer Use 需要可用的 Python 3，应用会在用户配置目录下创建隔离的虚拟环境并安装平台依赖。

## 快速开始

### 桌面端

1. 打开“设置 → Computer Use”。
2. 开启 Computer Use。
3. 检查 Python 状态；自动检测失败时，可选择 Python 可执行文件。
4. 执行安装或修复，让应用创建虚拟环境和安装依赖。
5. macOS 用户授予“辅助功能”和“屏幕录制”权限，然后重新检查。
6. 选择允许控制的应用，并按需要开启剪贴板和系统组合键权限。
7. 新建会话，用自然语言描述目标和允许操作的应用。

可以从简单、可撤销的任务开始：

```text
截取当前屏幕并告诉我你看到了什么。
打开 Notes，新建一条标题为“测试”的空白笔记。
在已授权的应用中，帮我找到设置入口，但不要修改任何内容。
```

### CLI

源码模式需要先安装项目依赖，并保证 Python 3 可用：

```bash
bun install
python3 --version
./bin/claude-haha
```

可以通过环境变量关闭动态 Computer Use MCP：

```bash
CLAUDE_COMPUTER_USE_ENABLED=0 ./bin/claude-haha
```

也可以在 `~/.claude/cc-haha/computer-use-config.json` 中设置：

```json
{
  "enabled": false
}
```

桌面设置页修改的是同一份托管配置。优先使用设置页，不要手工覆盖其中未知字段。

## 工具与 Teach 能力

代码中定义了 27 个 Computer Use 工具：

| 类别 | 工具 |
|---|---|
| 授权 | `request_access`、`list_granted_applications` |
| 截图 | `screenshot`、`zoom` |
| 鼠标 | `left_click`、`right_click`、`middle_click`、`double_click`、`triple_click`、`left_click_drag`、`mouse_move`、`left_mouse_down`、`left_mouse_up`、`cursor_position`、`scroll` |
| 键盘 | `type`、`key`、`hold_key` |
| 应用 | `open_application`、`switch_display` |
| 剪贴板 | `read_clipboard`、`write_clipboard` |
| 控制流 | `wait`、`computer_batch` |
| Teach | `request_teach_access`、`teach_step`、`teach_batch` |

基础控制能力包含 24 个工具。Teach 的 3 个工具只在宿主启用 Teach capability 时公开；未启用时，当前会话只会看到基础工具。

Teach 用于“带着用户一步一步操作”的场景：

1. `request_teach_access` 请求教学所需的应用授权。
2. `teach_step` 展示一个带锚点的说明，并等待用户点击下一步。
3. `teach_batch` 把可以预判的多个教学步骤合并，减少模型往返。

Teach 授权与普通控制授权相互独立。教学步骤仍经过应用白名单和输入安全检查；用户退出教学后，模型不应继续调用 Teach 工具。

## 工作原理

Computer Use 使用“截图 → 分析 → 操作 → 再截图”的闭环：

```text
模型
  → 调用 Computer Use MCP 工具
  → TypeScript 调度与安全检查
  → Python Bridge
  → macOS / Windows 系统操作
  → 截图或操作结果返回模型
```

- 工具定义与授权逻辑位于 `src/vendor/computer-use-mcp/`。
- CLI 集成和 Python Bridge 位于 `src/utils/computerUse/`。
- 平台执行器位于 `runtime/mac_helper.py` 和 `runtime/win_helper.py`。
- 桌面安装、权限和预授权由 `src/server/api/computer-use.ts` 与 `desktop/src/pages/ComputerUseSettings.tsx` 管理。

## 授权模型

### 应用授权

模型必须先调用 `request_access`，说明需要哪些应用以及原因。用户可以批准或拒绝。设置页中的预授权应用是默认授权配置，不代表任意应用都可以被控制；运行中新增应用仍需要走相应授权流程。

应用按能力分为三个等级：

| 等级 | 能力 |
|---|---|
| `read` | 读取截图，不执行输入 |
| `click` | 点击、移动和滚动，不输入文字或执行高权限动作 |
| `full` | 在其他安全检查通过后允许键盘、拖拽等完整操作 |

### 剪贴板与系统组合键

剪贴板读取、剪贴板写入和系统级组合键是单独的授权标志。允许控制某个应用，不会自动获得这些权限。

### 并发

Computer Use 使用会话锁防止多个会话同时争夺鼠标和键盘。看到“正在被其他会话使用”时，应先停止或完成原会话，而不是删除锁文件。

## 平台安全边界

### macOS

- 需要“辅助功能”才能输入和操作应用。
- 需要“屏幕录制”才能截图。
- 截图支持原生窗口过滤，只保留授权应用和桌面。

### Windows

- 当前截图过滤能力为 `none`：截图中可能出现所有可见窗口。
- 应用白名单仍会阻止把输入动作发送给未授权的前台应用。
- 因为截图本身不做过滤，开始前应主动关闭或最小化包含敏感信息的窗口。

### 当前明确没有的保护

- **没有全局 Escape 中止热键。** 桌面端应使用当前任务的停止操作；CLI 运行可用终端中断。
- **不会在每次操作前自动隐藏未授权窗口。** 不要依赖自动隐藏来保护敏感内容。
- **像素陈旧验证默认关闭。** UI 变化后，模型应重新截图再点击。

这些限制是当前实现边界，不应在文档或 UI 中描述成已经可用。

## Python 运行时

首次安装或修复时，应用会：

1. 把当前平台的 helper 和 requirements 同步到用户配置目录。
2. 使用自动检测或用户选择的 Python 创建 venv。
3. 安装或升级 pip。
4. 按 requirements 内容哈希决定是否重新安装依赖。
5. 通过 JSON payload 调用平台 helper，并解析统一 JSON 结果。

macOS 主要依赖 `mss`、Pillow、PyAutoGUI 和 PyObjC；Windows 还使用 pywin32、psutil、pyperclip 与 screeninfo。准确版本约束以 `runtime/requirements*.txt` 为准。

## 故障排查

### macOS 仍提示缺少权限

- 确认授权的是实际启动 Claude Code Haha 的应用。
- 权限变更后完全退出并重新打开应用。
- 在设置页重新执行权限检查。

### Python 安装失败

- 在设置页选择明确的 Python 3 可执行文件。
- 确认该 Python 支持 `venv`。
- 使用“安装/修复”重新创建运行时。
- 查看“诊断”页中的 Computer Use 安装日志。

### 截图可以但点击失败

- 确认目标应用处于授权列表。
- 确认它是当前前台应用。
- 检查授权等级是否允许该动作。
- UI 已变化时重新截图，不要复用旧坐标。

### Windows 截图出现其他窗口

这是当前 Windows 截图能力的已知边界。输入白名单不会过滤截图内容；执行前请关闭或最小化敏感窗口。

## 深入阅读

- [Computer Use 架构](./computer-use-architecture.md)
- [桌面端架构](../desktop/02-architecture.md)
