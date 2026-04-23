# Computer Use 功能指南


> **魔改说明**：本功能是基于 Claude Code 泄露源码中的 Computer Use（内部代号 "Chicago"）进行的**深度改造版本**。官方实现依赖 Anthropic 内部私有原生模块（`@ant/computer-use-swift`、`@ant/computer-use-input`），无法公开获取。我们**替换了整个底层操作层**，使用 Python bridge 实现所有系统交互——macOS 使用 `pyautogui` + `mss` + `pyobjc`，Windows 使用 `pyautogui` + `mss` + `win32gui` + `psutil`，使得任何人都可以在 macOS 和 Windows 上运行 Computer Use 功能。

---

## 目录

- [功能简介](#功能简介)
- [支持的设备与平台](#支持的设备与平台)
- [工作原理](#工作原理)
- [快速开始](#快速开始)
- [使用方式](#使用方式)
- [安全机制](#安全机制)
- [环境变量](#环境变量)
- [技术架构详解](#技术架构详解)
- [我们尝试过的方案](#我们尝试过的方案)
- [已知限制](#已知限制)
- [参考项目与致谢](#参考项目与致谢)

---

## 功能简介

Computer Use 让 AI 模型能够**直接控制你的电脑**——截屏、移动鼠标、点击按钮、输入文字、管理应用窗口。

支持的操作（共 24 个 MCP 工具）：

| 类别 | 工具 |
|------|------|
| 截屏 | `screenshot`、`zoom` |
| 鼠标 | `left_click`、`right_click`、`middle_click`、`double_click`、`triple_click`、`left_click_drag`、`mouse_move`、`left_mouse_down`、`left_mouse_up`、`cursor_position`、`scroll` |
| 键盘 | `type`、`key`、`hold_key` |
| 应用 | `open_application`、`switch_display` |
| 权限 | `request_access`、`list_granted_applications` |
| 剪贴板 | `read_clipboard`、`write_clipboard` |
| 其他 | `wait`、`computer_batch` |

---

## 支持的设备与平台

| 平台 | 芯片 | 状态 | 说明 |
|------|------|------|------|
| macOS | Apple Silicon (M1/M2/M3/M4) | ✅ 完整支持 | 推荐平台 |
| macOS | Intel x86_64 | ✅ 完整支持 | |
| Windows | x64 | ✅ 完整支持 | 使用 `win32gui` + `psutil` + `pyperclip` + `screeninfo` 替代 macOS 专有 API |
| Linux | 任意 | ⚠️ 理论可行 | 需替换平台专有部分为 `wmctrl` + `xdotool`，当前未适配 |

### 运行环境要求

- [Bun](https://bun.sh) >= 1.1.0
- Python >= 3.8（首次运行自动创建 venv 并安装依赖）
- **macOS**：系统权限 Accessibility（辅助功能）+ Screen Recording（屏幕录制）
- **Windows**：无需额外权限配置

---

## 工作原理

Computer Use 的核心是一个**截图-分析-操作**的闭环：

```
┌──────────────────────────────────────────────┐
│  AI 模型（Claude / 其他 Anthropic 协议模型）     │
│                                               │
│  1. 收到用户请求 "打开网易云搜索喜欢你"            │
│  2. 调用 screenshot 工具 → 收到屏幕截图           │
│  3. 模型分析截图像素，识别 UI 元素位置              │
│     → "搜索框在 (756, 342)"                     │
│  4. 调用 left_click { coordinate: [756, 342] }  │
│  5. 调用 type { text: "喜欢你" }                 │
│  6. 再次 screenshot → 确认结果 → 下一步...        │
└──────────────┬───────────────────────────────┘
               │ MCP Tool Call
               ▼
┌──────────────────────────────────────────────┐
│  TypeScript 工具层                              │
│  (vendor/computer-use-mcp)                     │
│                                               │
│  - 安全检查（应用白名单、TCC 权限）               │
│  - 坐标模式转换（pixels / normalized）           │
│  - 工具分发 → executor                          │
└──────────────┬───────────────────────────────┘
               │ callPythonHelper()
               ▼
┌──────────────────────────────────────────────┐
│  Python Bridge                                │
│  macOS: runtime/mac_helper.py                 │
│  Windows: runtime/win_helper.py               │
│                                               │
│  pyautogui.click(756, 342)  ← 鼠标控制         │
│  mss.grab(monitor)          ← 截图             │
│  macOS: NSWorkspace.open()  ← 应用管理          │
│  Windows: win32gui / psutil ← 应用管理          │
└──────────────────────────────────────────────┘
```

**关键：坐标分析完全由模型的视觉能力完成**——模型"看"截图就像人看屏幕一样，直接从像素中识别按钮、输入框等 UI 元素的位置。

---

## 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 确保 Python 3 可用

```bash
python3 --version  # 需要 >= 3.8
```

> Python 依赖会在首次使用 Computer Use 时**自动安装**到 `.runtime/venv/`，无需手动操作。

### 3. 授予 macOS 权限

#### Accessibility（辅助功能）

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
```

将你的**终端应用**（如 iTerm、Terminal、Ghostty 等）添加到允许列表。

#### Screen Recording（屏幕录制）

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
```

同样添加你的终端应用。授权后可能需要**重启终端**。

### 4. 启动

```bash
./bin/claude-haha
```

### 5. 使用

在对话中用自然语言请求即可：

```
> 帮我打开网易云音乐，搜索一首歌
> 截个屏看看当前桌面
> 帮我在 VS Code 里打开终端
```

---

## 使用方式

首次使用 Computer Use 时，系统会弹出**应用授权对话框**，你需要选择允许 Claude 操作的应用。

- 模型会先调用 `request_access` 请求权限
- 你在终端中确认允许哪些应用
- 之后模型就可以截图、点击、输入了

---

## 安全机制

| 机制 | 说明 |
|------|------|
| **应用白名单** | 每次会话需要明确授权允许操作的应用 |
| **并发保护** | 同一时间只有一个 Claude 会话可使用 Computer Use（文件锁机制） |
| **剪贴板保护** | 通过剪贴板输入文本时会自动保存和恢复原始剪贴板内容 |
| **操作确认** | 敏感操作（如系统快捷键）需要额外授权 |

> 注意：由于底层改为 Python bridge，原生方案中的全局 Escape 快捷键中止和操作前自动隐藏应用功能暂不可用。可使用 `Ctrl+C` 中止。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAUDE_COMPUTER_USE_ENABLED` | `1` | 设为 `0` 可禁用 Computer Use |
| `CLAUDE_COMPUTER_USE_COORDINATE_MODE` | `pixels` | 坐标模式：`pixels` 或 `normalized_0_100` |
| `CLAUDE_COMPUTER_USE_CLIPBOARD_PASTE` | `1` | 是否启用剪贴板粘贴输入 |
| `CLAUDE_COMPUTER_USE_MOUSE_ANIMATION` | `1` | 是否启用鼠标动画 |
| `CLAUDE_COMPUTER_USE_HIDE_BEFORE_ACTION` | `0` | 操作前是否隐藏其他窗口 |
| `CLAUDE_COMPUTER_USE_DEBUG` | `0` | 调试模式 |

---

## 技术架构详解

### 整体分层

```
src/
├── vendor/computer-use-mcp/     ← MCP 工具定义与分发（12 个文件）
│   ├── tools.ts                 ← 24 个工具的 schema 定义
│   ├── toolCalls.ts             ← 安全检查 + 工具分发
│   ├── mcpServer.ts             ← MCP 服务器创建
│   ├── types.ts                 ← 全部类型定义
│   └── ...
├── utils/computerUse/
│   ├── executor.ts              ← 执行器（调用 Python bridge）
│   ├── pythonBridge.ts          ← Python 子进程管理
│   ├── hostAdapter.ts           ← 权限检查适配器
│   ├── gates.ts                 ← 功能开关（已绕过灰度）
│   ├── wrapper.tsx              ← MCP 工具覆写层
│   ├── setup.ts                 ← MCP 配置初始化
│   └── ...
└── runtime/
    ├── mac_helper.py            ← macOS Python 实现
    ├── win_helper.py            ← Windows Python 实现
    ├── requirements.txt         ← macOS Python 依赖
    └── requirements-win.txt     ← Windows Python 依赖
```

### 灰度控制绕过

官方 Claude Code 中 Computer Use 通过三层门控限制访问：

| 层级 | 原始机制 | 我们的处理 |
|------|----------|-----------|
| 编译时 | `feature('CHICAGO_MCP')` (Bun 编译宏) | 替换为 `true` |
| 订阅检查 | `hasRequiredSubscription()` (Max/Pro) | `getChicagoEnabled()` 直接返回 `true` |
| 远程配置 | GrowthBook `tengu_malort_pedway` | 同上，不再依赖远程配置 |
| 默认禁用 | `isDefaultDisabledBuiltin('computer-use')` | `isDefaultDisabledBuiltin()` 返回 `false` |

### Python Bridge 工作机制

```typescript
// pythonBridge.ts
async function callPythonHelper<T>(command: string, payload: object): Promise<T> {
  await ensureBootstrapped()  // 首次调用自动创建 venv + pip install
  
  // 调用: python3 runtime/mac_helper.py <command> --payload '{...}'
  const result = execFile(pythonBin, ['mac_helper.py', command, '--payload', JSON.stringify(payload)])
  
  return JSON.parse(result.stdout)  // { ok: true, result: T }
}
```

首次运行自动完成：
1. 创建 Python 虚拟环境 (`.runtime/venv/`)
2. 安装 pip
3. 按平台安装依赖：
   - **macOS**: `mss`, `Pillow`, `pyautogui`, `pyobjc-*`（`requirements.txt`）
   - **Windows**: `mss`, `Pillow`, `pyautogui`, `win32gui`, `psutil`, `pyperclip`, `screeninfo`（`requirements-win.txt`）
4. SHA256 哈希验证（仅 requirements 变更时重新安装）

---

## 我们尝试过的方案

### 方案一：从 Claude Code 二进制提取原生 .node 模块 ❌

**思路**：从已安装的 Claude Code 二进制 (`~/.local/share/claude/versions/2.1.91`，189MB Mach-O) 中定位并提取嵌入的原生 NAPI 模块。

**实施**：
- 成功从 Bun `$bunfs` 虚拟文件系统中提取了 `computer-use-swift.node` (ARM64 424KB + x64 430KB) 和 `computer-use-input.node` (ARM64 836KB + x64 821KB)
- 同步方法（TCC 权限检查、显示枚举）正常工作
- 创建了 npm 包装包并通过 workspace 注册

**失败原因**：
- Swift 异步方法（`screenshot.captureExcluding`）的 continuation 永远不会 resume
- 根因：提取的 .node 文件是针对 Claude Code 内置的 Bun 运行时编译的，与用户系统的 Bun 版本的 N-API 异步实现不兼容
- 错误信息：`SWIFT TASK CONTINUATION MISUSE: captureScreenWithExclusion leaked its continuation without resuming it`

### 方案二：创建空 Stub 包 ❌

**思路**：为 `@ant/computer-use-mcp`、`@ant/computer-use-input`、`@ant/computer-use-swift` 创建最小化的 stub 包，使代码能编译加载。

**失败原因**：代码能编译但 MCP 服务器注册后无法执行任何实际操作——截图、点击等全部报错。

### 方案三：Python Bridge 替代原生模块 ✅（当前方案）

**思路**：参考 [wimi321/macos-computer-use-skill](https://github.com/wimi321/macos-computer-use-skill)，用 Python 子进程替代所有原生模块调用。

**优势**：
- 零二进制依赖，不依赖特定 Bun/Node 版本
- 纯 Python 实现，首次运行自动安装
- 截图、鼠标、键盘、应用管理全部可用
- macOS ARM64 + x86_64 均支持

---

## 已知限制

| 限制 | 说明 |
|------|------|
| 不支持 Linux | 需要适配平台专有 API 部分 |
| 无全局 Escape 中止 | 原生方案用 CGEventTap 实现，Python 版暂不支持，用 `Ctrl+C` 代替 |
| 操作前不自动隐藏窗口 | 原生方案的 `prepareDisplay` 依赖 Swift，Python 版未实现 |
| 性能略低 | Python 进程启动 ~100ms 开销，但模型思考时间通常是秒级，用户感知不到 |
| 像素验证关闭 | `pixelValidation` 默认关闭 |

---

## 参考项目与致谢

本功能的实现参考了以下开源项目，在此致以感谢：

| 项目 | 许可证 | 贡献 |
|------|--------|------|
| [wimi321/macos-computer-use-skill](https://github.com/wimi321/macos-computer-use-skill) | MIT | Python bridge 架构、`mac_helper.py` 运行时、`executor.ts` 适配方案。该项目从 Claude Code 工作流中提取了可复用的 TypeScript 逻辑，并用完全公开的 Python 库替代了私有原生模块 |
| [domdomegg/computer-use-mcp](https://github.com/domdomegg/computer-use-mcp) | MIT | 独立的 Computer Use MCP 服务器实现（基于 nut.js），跨平台可用。在方案调研阶段提供了参考 |
| [paoloanzn/free-code](https://github.com/paoloanzn/free-code) | - | Feature flag 系统分析和构建系统参考 |
| [oboard/claude-code-rev](https://github.com/oboard/claude-code-rev) | - | 泄露源码的早期恢复工作，提供了 stub 包的参考实现 |

### 底层依赖

| 库 | 平台 | 用途 |
|----|------|------|
| [pyautogui](https://github.com/asweigart/pyautogui) | 跨平台 | 鼠标和键盘控制 |
| [mss](https://github.com/BoboTiG/python-mss) | 跨平台 | 屏幕截图 |
| [Pillow](https://github.com/python-pillow/Pillow) | 跨平台 | 图像处理和压缩 |
| [pyobjc](https://github.com/ronaldoussoren/pyobjc) | macOS | Cocoa/Quartz 框架绑定（应用管理、显示枚举） |
| [pywin32](https://github.com/mhammond/pywin32) | Windows | Win32 API 绑定（窗口管理） |
| [psutil](https://github.com/giampaolo/psutil) | Windows | 进程管理（应用列表、进程操作） |
| [pyperclip](https://github.com/asweigart/pyperclip) | Windows | 剪贴板操作 |
| [screeninfo](https://github.com/rr-/screeninfo) | Windows | 显示器信息（多屏支持） |
