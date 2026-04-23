# Computer Use 架构深度解析

> 深入解析 Computer Use 功能的底层实现：从 MCP 工具定义到 Python Bridge，从 9 层安全关卡到灰度控制绕过。

<p align="center">
<a href="#一补丁环境总览">补丁环境</a> ·
<a href="#二分层架构">分层架构</a> ·
<a href="#三mcp-工具层">MCP 工具层</a> ·
<a href="#四安全关卡体系">安全关卡</a> ·
<a href="#五python-bridge-机制">Python Bridge</a> ·
<a href="#六截图-分析-操作闭环">交互闭环</a> ·
<a href="#七关键源文件索引">源文件索引</a>
</p>

![Computer Use 整体架构](./images/01-computer-use-architecture.jpg)

---

## 一、补丁环境总览

Claude Code 原版的 Computer Use 功能（内部代号 **Chicago**）依赖三个不可公开获取的组件：

| 组件 | 作用 | 获取方式 |
|------|------|----------|
| `@ant/computer-use-swift` | 屏幕截图、显示器枚举 | Anthropic 私有 npm 包 |
| `@ant/computer-use-input` | 鼠标/键盘模拟 | Anthropic 私有 npm 包 |
| GrowthBook 远程配置 | 灰度控制、功能开关 | Anthropic 内部服务 |

我们的方案是：**保留原始 MCP 工具定义和安全机制不变，仅替换底层执行层和灰度控制**。

![补丁环境对比](./images/04-computer-use-patch.jpg)

### 我们做了什么

```
原始 Claude Code                         Claude Code Haha (补丁版)
─────────────────                        ─────────────────────────
@ant/computer-use-swift  ──替换为──→     Python Bridge (mac_helper.py)
@ant/computer-use-input  ──替换为──→     pyautogui + pyobjc
GrowthBook 灰度控制      ──绕过──→      gates.ts 硬编码 return true
订阅检查 (Max/Pro)       ──绕过──→      getChicagoEnabled() = true
编译宏 CHICAGO_MCP       ──替换为──→     true
isDefaultDisabledBuiltin ──修改──→      返回 false
```

### 我们没有改什么

- **MCP 工具定义**（24 个工具的 schema 和参数校验）
- **9 层安全关卡**（TCC 权限、应用白名单、权限等级、像素验证等）
- **应用分类系统**（191 个 bundle ID 的分类和权限映射）
- **会话上下文管理**（全局锁、截图缓存、状态同步）
- **键盘快捷键阻止列表**（系统级危险操作拦截）

### 灰度绕过细节

原始代码通过三层门控限制 Computer Use 的访问：

```typescript
// 原始代码（简化）
function getChicagoEnabled(): boolean {
  // 层1：GrowthBook 远程配置
  const config = getDynamicConfig('tengu_malort_pedway')
  // 层2：订阅检查
  const hasSubscription = hasRequiredSubscription() // Max/Pro
  // 层3：编译时宏
  return feature('CHICAGO_MCP') && config.enabled && hasSubscription
}
```

我们的处理：

```typescript
// gates.ts — 我们的修改
export function getChicagoEnabled(): boolean {
  return true  // ← 三层门控全部绕过
}
```

**注意**：子开关（pixelValidation、mouseAnimation 等）仍然保留原始逻辑，可通过配置控制。

---

## 二、分层架构

Computer Use 采用 **6 层架构**，每层职责清晰、边界明确：

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1 — MCP 工具接口层                                    │
│  tools.ts: 24 个工具 schema + 参数校验                       │
│  buildComputerUseTools() → MCP Tool Definition              │
├─────────────────────────────────────────────────────────────┤
│  Layer 2 — 工具调度与安全控制层                               │
│  toolCalls.ts: handleToolCall() + 9 层安全关卡               │
│  deniedApps.ts: 191 个应用分类 + 权限等级                    │
├─────────────────────────────────────────────────────────────┤
│  Layer 3 — MCP 服务器绑定层                                  │
│  mcpServer.ts: 会话上下文 + 全局锁 + 截图缓存               │
│  bindSessionContext() → per-call overrides                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 4 — CLI 集成层                                        │
│  wrapper.tsx: 权限对话框 + 状态读写                          │
│  setup.ts: MCP 配置初始化                                    │
│  gates.ts: 灰度控制（已绕过）                                │
├─────────────────────────────────────────────────────────────┤
│  Layer 5 — Python Bridge 进程通信层                  [补丁]  │
│  pythonBridge.ts: venv 管理 + JSON RPC + 错误处理           │
│  callPythonHelper<T>(command, payload) → T                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 6 — Python 运行时执行层                       [补丁]  │
│  mac_helper.py: pyautogui + mss + pyobjc                    │
│  660 行 Python 实现所有系统交互                              │
└─────────────────────────────────────────────────────────────┘
```

**标 `[补丁]` 的层**是我们替换/新增的代码，**其余层完全保留**原始 Claude Code 的逻辑。

### 为什么这样分层？

| 层 | 来源 | 可复用性 |
|----|------|----------|
| Layer 1-2 | `vendor/computer-use-mcp/` | 平台无关，可用于 Electron、Web 等宿主 |
| Layer 3 | `vendor/computer-use-mcp/` | 平台无关，MCP 标准协议 |
| Layer 4 | `utils/computerUse/` | CLI 专用，绑定应用状态 |
| Layer 5-6 | `utils/computerUse/` + `runtime/` | macOS 专用，Python 实现 |

---

## 三、MCP 工具层

### 24 个工具一览

Computer Use 通过 MCP（Model Context Protocol）暴露 24 个工具给模型：

| 类别 | 工具 | 权限等级 |
|------|------|----------|
| **权限** | `request_access`, `list_granted_applications` | 无需权限 |
| **截屏** | `screenshot`, `zoom` | read |
| **鼠标点击** | `left_click`, `double_click`, `triple_click` | click |
| **鼠标高级** | `right_click`, `middle_click`, `left_click_drag` | full |
| **鼠标移动** | `mouse_move`, `cursor_position`, `scroll` | click |
| **鼠标底层** | `left_mouse_down`, `left_mouse_up` | full |
| **键盘** | `type`, `key`, `hold_key` | full |
| **应用** | `open_application`, `switch_display` | full |
| **剪贴板** | `read_clipboard`, `write_clipboard` | full |
| **批量** | `computer_batch` | 继承子操作 |
| **等待** | `wait` | 无需权限 |

### 坐标系统

模型通过两种坐标模式与屏幕交互：

```
pixels 模式（默认）：
  模型看到截图尺寸 (1176 x 784)
  模型输出坐标 [588, 392]
  scaleCoord() 转换：
    x_logical = (588 * displayWidth / 1176) + originX
    y_logical = (392 * displayHeight / 784) + originY

normalized_0_100 模式：
  模型输出坐标 [50, 50]（百分比）
  scaleCoord() 转换：
    x_logical = (50 / 100) * displayWidth + originX
    y_logical = (50 / 100) * displayHeight + originY
```

截图尺寸经过 `imageResize.ts` 计算，确保：
- 长边 ≤ 1568 像素
- Token 预算 ≤ 1568（视觉编码器 28px/token）
- 保持宽高比

### 应用分类系统

`deniedApps.ts` 对 191 个应用进行精细分类：

**浏览器类**（55 个 bundle ID）→ 权限等级 `read`
```
Safari, Chrome, Firefox, Arc, Edge, Opera, Brave, Vivaldi...
理由：浏览器操作应使用 Chrome MCP，而非盲点击
```

**终端类**（102 个 bundle ID）→ 权限等级 `click`
```
Terminal, iTerm2, VS Code, Cursor, JetBrains 全家桶, Xcode...
理由：终端操作应使用 Bash Tool，限制为只能点击不能输入
```

**交易类**（34 个 bundle ID）→ 权限等级 `read`
```
Webull, Fidelity, Interactive Brokers, Binance, Kraken...
理由：金融操作风险极高，仅允许截图查看
```

**完全禁止**（策略拒绝名单）：
```
Netflix, Spotify, Apple Music, Kindle...
理由：版权合规，不进入权限对话框直接拒绝
```

---

## 四、安全关卡体系

每个输入操作（点击、键盘、拖拽）在执行前需通过 **9 层安全关卡**：

![安全关卡流程](./images/02-computer-use-security-gates.jpg)

### 关卡详解

#### Gate 1：Kill Switch
```typescript
if (adapter.isDisabled()) return errorResult("Computer Use is disabled")
```
读取 `getChicagoEnabled()` — 在补丁版中永远返回 `true`。

#### Gate 2：TCC 权限检查
```typescript
await adapter.ensureOsPermissions()
// → Python: check_permissions
//   → Accessibility: osascript "tell System Events..."
//   → Screen Recording: CGDisplayCaptureDisplay()
```
如果缺少 macOS Accessibility 或 Screen Recording 权限，直接报错。

#### Gate 3：全局互斥锁
```typescript
await tryAcquireComputerUseLock(sessionId)
// 文件锁: ~/.claude/computer-use.lock
// JSON: { sessionId, pid, acquiredAt }
```
确保同一时间只有一个 Claude 会话可以控制电脑。支持 stale PID 恢复。

#### Gate 4：隐藏非白名单应用
```typescript
await executor.prepareForAction(allowlistBundleIds)
// 隐藏所有不在白名单中的应用窗口
// 确保截图中只出现授权应用
```

#### Gate 5：前台应用检查
```typescript
const frontmost = await executor.getFrontmostApp()
if (!allowlist.includes(frontmost.bundleId)) {
  return errorResult("Application not authorized")
}
```
即使通过了白名单，还需确认当前前台应用是已授权的。

#### Gate 6：权限等级检查

三级权限模型：

| Tier | 允许的操作 | 禁止的操作 |
|------|-----------|-----------|
| `read` | 截图查看 | 任何输入操作 |
| `click` | 左键点击、滚动 | 右键、拖拽、键盘输入 |
| `full` | 全部操作 | 无限制 |

```typescript
function tierSatisfies(tier: CuAppPermTier, required: ActionKind): boolean {
  const order = { read: 0, click: 1, full: 2 }
  return order[tier] >= order[required]
}
```

**反绕过机制**：如果权限不足，响应中会附加 `TIER_ANTI_SUBVERSION` 提示，防止模型通过 AppleScript 或 System Events 绕过限制。

#### Gate 7：剪贴板防护

**威胁模型**：
```
1. Agent 调用 write_clipboard("rm -rf /")
2. 切换到 Terminal（click-tier 允许点击）
3. 模型点击 Terminal 的粘贴按钮
4. 恶意命令被执行
```

**防护机制**：
```
当 click-tier 应用成为前台时：
  → 保存当前剪贴板内容（stash）
  → 清空剪贴板
  → 每次操作后再次清空

当非 click-tier 应用成为前台时：
  → 恢复原始剪贴板内容
```

#### Gate 8：像素验证（Staleness Guard）

```
上次截图                  当前实际屏幕
┌────────────┐           ┌────────────┐
│    按钮A    │           │   对话框    │  ← UI 已变化
│   [756,342] │           │    确认?    │
└────────────┘           └────────────┘

像素验证：在 [756,342] 取 9×9 网格
  → 对比上次截图 vs 实时截图的像素
  → 不同 → 拒绝点击 + 提示重新截图
  → 相同 → 允许点击
```

**注意**：补丁版中 `pixelValidation` 默认关闭（`hostAdapter.cropRawPatch()` 返回 null）。

#### Gate 9：系统快捷键拦截

`keyBlocklist.ts` 阻止危险快捷键：

| 快捷键 | 危险操作 |
|--------|---------|
| `⌘Q` | 退出应用 |
| `⇧⌘Q` | 登出系统 |
| `⌥⌘⎋` | 强制退出对话框 |
| `⌘Tab` | 应用切换器 |
| `⌘Space` | Spotlight |
| `⌃⌘Q` | 锁屏 |

---

## 五、Python Bridge 机制

![Python Bridge 通信机制](./images/03-computer-use-python-bridge.jpg)

### 架构设计

原始 Claude Code 使用编译好的 Swift 原生模块（.node NAPI 插件）直接调用 macOS API。我们用 **Python 子进程 + JSON RPC** 替代了这一层：

```
TypeScript (Bun 运行时)                    Python (venv)
┌────────────────────┐                   ┌────────────────────┐
│  executor.ts       │                   │  mac_helper.py     │
│                    │   execFile()      │                    │
│  callPythonHelper  │ ──────────────→   │  main()            │
│  ('click',         │   command +       │    ├─ 解析 argv    │
│   {x:756,y:342})   │   --payload JSON  │    ├─ dispatch()   │
│                    │                   │    └─ click()      │
│  ← JSON.parse ──── │ ←──────────────   │       pyautogui    │
│  {ok:true,         │   stdout JSON     │                    │
│   result:true}     │                   │  json_output(...)  │
└────────────────────┘                   └────────────────────┘
```

### 启动引导流程

首次调用 `callPythonHelper()` 时自动完成环境初始化：

```
ensureBootstrapped()
  │
  ├─ 检查 .runtime/venv/bin/python3 是否存在
  │   └─ 不存在 → python3 -m venv .runtime/venv/
  │
  ├─ 检查 pip 是否可用
  │   └─ 不可用 → python3 -m ensurepip --upgrade
  │
  ├─ 计算 runtime/requirements.txt 的 SHA256
  │   └─ 与 .runtime/requirements.sha256 对比
  │       └─ 不同 → pip install -r requirements.txt
  │                 写入新的 SHA256 哈希
  │       └─ 相同 → 跳过安装
  │
  └─ 就绪，返回 venv Python 路径
```

**依赖清单**（`runtime/requirements.txt`）：

| 库 | 用途 |
|----|------|
| `mss` | 高性能屏幕截图 |
| `Pillow` | JPEG 编码和图像处理 |
| `pyautogui` | 鼠标点击、键盘输入 |
| `pyobjc-core` | macOS Objective-C 桥接 |
| `pyobjc-framework-Cocoa` | NSWorkspace（应用管理）、NSPasteboard（剪贴板） |
| `pyobjc-framework-Quartz` | CGDisplay（显示器）、CGWindow（窗口列表） |

### 命令映射表

`mac_helper.py`（660 行）实现了以下命令：

| 命令 | Python 实现 | 返回值 |
|------|------------|--------|
| `screenshot` | `mss.grab()` + `PIL.Image` JPEG 编码 | `{base64, width, height, displayWidth, displayHeight}` |
| `zoom` | `mss.grab(region)` 区域截图 | `{base64, width, height}` |
| `click` | `pyautogui.moveTo()` + `pyautogui.click()` | `true` |
| `key` | `pyautogui.hotkey()` / `pyautogui.press()` | `true` |
| `type` | `pyautogui.write(interval=0.008)` | `true` |
| `drag` | `pyautogui.dragTo(duration=0.2)` | `true` |
| `scroll` | `pyautogui.scroll()` / `pyautogui.hscroll()` | `true` |
| `hold_key` | `pyautogui.keyDown()` + `sleep` + `pyautogui.keyUp()` | `true` |
| `frontmost_app` | `NSWorkspace.frontmostApplication()` | `{bundleId, displayName}` |
| `list_displays` | `CGGetActiveDisplayList()` + `CGDisplayBounds()` | `[DisplayGeometry...]` |
| `find_window_displays` | `CGWindowListCopyWindowInfo()` + 交集计算 | `[{bundleId, displayIds}...]` |
| `list_installed_apps` | 递归扫描 `/Applications` + `plistlib` | `[InstalledApp...]` |
| `list_running_apps` | `NSWorkspace.runningApplications()` | `[RunningApp...]` |
| `open_app` | `NSWorkspace.launchApplicationAtURL_options_` | `void` |
| `read_clipboard` | `NSPasteboard.stringForType_()` | `string` |
| `write_clipboard` | `NSPasteboard.setString_forType_()` | `void` |
| `check_permissions` | `osascript` + `CGDisplayCaptureDisplay` | `{accessibility, screenRecording}` |

### 错误处理

```python
# mac_helper.py 的统一错误处理
def main():
    try:
        result = dispatch(command, payload)
        json_output({"ok": True, "result": result})
    except Exception as e:
        error_output({"ok": False, "error": {"message": str(e)}})
```

TypeScript 端：
```typescript
// pythonBridge.ts
const parsed = JSON.parse(stdout)
if (!parsed.ok) {
  throw new Error(parsed.error.message)  // → MCP tool error
}
return parsed.result
```

---

## 六、截图-分析-操作闭环

一个完整的 Computer Use 交互由多个 **截图-分析-操作** 循环组成：

### 典型交互流程

```
用户: "帮我打开网易云音乐，搜索一首歌"

┌─ 循环 1：发现并打开应用 ─────────────────────────────────┐
│                                                          │
│  Step 1: request_access                                  │
│    → 弹出权限对话框，用户授权允许操作的应用               │
│    → 设置 allowedApps, grantFlags                        │
│                                                          │
│  Step 2: screenshot                                      │
│    → 截取全屏 → JPEG 编码 → base64                       │
│    → 缓存截图尺寸 (lastScreenshotDims)                   │
│    → 返回给模型                                          │
│                                                          │
│  Step 3: 模型分析截图                                    │
│    → "桌面上没有网易云音乐，需要打开它"                   │
│    → 决定调用 open_application                           │
│                                                          │
│  Step 4: open_application("com.netease.163music")        │
│    → Gate 1-9 全部通过                                   │
│    → Python: NSWorkspace.launchApplicationAtURL_()       │
│                                                          │
└──────────────────────────────────────────────────────────┘

┌─ 循环 2：定位搜索框 ────────────────────────────────────┐
│                                                          │
│  Step 5: screenshot                                      │
│    → 截取全屏（网易云已打开）                             │
│    → 更新 lastScreenshotDims                             │
│                                                          │
│  Step 6: 模型分析截图                                    │
│    → 视觉识别搜索框位置 → (756, 342)                     │
│    → 决定点击搜索框                                      │
│                                                          │
│  Step 7: left_click({coordinate: [756, 342]})            │
│    → Gate 4: 隐藏非白名单应用                            │
│    → Gate 5: 前台是网易云 ✓                              │
│    → Gate 6: tier=full ≥ click ✓                         │
│    → Gate 7: 非 click-tier 应用，跳过                    │
│    → scaleCoord(756, 342) 转换为屏幕坐标                 │
│    → Python: pyautogui.click(x_logical, y_logical)       │
│                                                          │
└──────────────────────────────────────────────────────────┘

┌─ 循环 3：输入搜索词 ────────────────────────────────────┐
│                                                          │
│  Step 8: type({text: "喜欢你"})                          │
│    → Gate 6: tier=full ≥ keyboard ✓                      │
│    → Python: pyautogui.write("喜欢你", interval=0.008)   │
│                                                          │
│  Step 9: screenshot                                      │
│    → 确认搜索结果已出现                                  │
│    → 模型分析："搜索结果列表中第一个就是目标歌曲"         │
│                                                          │
│  Step 10: left_click({coordinate: [...]})                │
│    → 点击目标歌曲                                        │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 坐标转换的关键

**模型看到的**和**屏幕实际的**是不同的坐标空间：

```
原始屏幕 (2560 x 1600, Retina 2x)
  ├─ 逻辑尺寸: 1280 x 800
  └─ 物理像素: 2560 x 1600

imageResize 计算后：
  ├─ 缩放后尺寸: 1176 x 735 (≤1568px 预算)
  └─ 这就是模型"看到"的截图尺寸

模型输出坐标: [588, 368]（图像空间的像素位置）

scaleCoord 转换:
  x_logical = (588 / 1176) * 1280 + originX = 640 + 0 = 640
  y_logical = (368 / 735) * 800 + originY = 400 + 0 = 400

Python 执行:
  pyautogui.moveTo(640, 400)  ← 逻辑坐标（macOS 自动处理 Retina）
```

### 截图缓存与状态同步

```
bindSessionContext 闭包
  │
  ├─ lastScreenshot (内存)
  │   ├─ base64: JPEG 数据（用于 pixel validation）
  │   ├─ width/height: 模型看到的尺寸
  │   └─ displayWidth/displayHeight/originX/originY: 显示器几何
  │
  └─ AppState.computerUseMcpState (持久化)
      ├─ allowedApps: AppGrant[]          — 已授权应用列表
      ├─ grantFlags: {...}                — 剪贴板/系统快捷键权限
      ├─ selectedDisplayId?: number       — 选定的显示器
      ├─ lastScreenshotDims?: {...}       — 截图几何（跨重启恢复）
      └─ hiddenDuringTurn?: Set<string>   — 本轮隐藏的应用
```

---

## 七、关键源文件索引

### vendor/computer-use-mcp/（原始代码层）

| 文件 | 行数 | 职责 |
|------|------|------|
| `types.ts` | 622 | 权限模型、会话上下文、全部类型定义 |
| `tools.ts` | 707 | 24 个 MCP 工具的 schema 和参数校验 |
| `toolCalls.ts` | 1600+ | **核心**：工具派发、9 层安全关卡、权限流程 |
| `deniedApps.ts` | 554 | 191 个应用的分类（browser/terminal/trading）和权限映射 |
| `sentinelApps.ts` | 44 | 敏感应用预警标签（shell/filesystem/system_settings） |
| `mcpServer.ts` | 314 | MCP 服务器工厂、会话上下文绑定、全局锁 |
| `pixelCompare.ts` | 172 | 点击目标像素验证（staleness guard） |
| `imageResize.ts` | 109 | 截图尺寸计算（API 图像转码算法） |
| `keyBlocklist.ts` | 154 | 系统快捷键拦截（⌘Q、⌘Tab 等） |
| `executor.ts` | 101 | ComputerExecutor 接口定义 |
| `subGates.ts` | 20 | 灰度子开关预设组合 |

### utils/computerUse/（CLI 适配层）

| 文件 | 行数 | 职责 | 补丁? |
|------|------|------|-------|
| `executor.ts` | 231 | ComputerExecutor 的 Python bridge 实现 | ✅ 重写 |
| `pythonBridge.ts` | 111 | Python 子进程管理、venv 引导、JSON RPC | ✅ 新增 |
| `hostAdapter.ts` | 54 | HostAdapter 实现（权限检查、灰度读取） | 部分修改 |
| `gates.ts` | 51 | GrowthBook 灰度控制（`getChicagoEnabled` 绕过） | ✅ 修改 |
| `wrapper.tsx` | 300+ | 会话上下文构建、权限对话框、锁管理 | 未修改 |
| `setup.ts` | 54 | MCP 配置初始化 | 未修改 |
| `computerUseLock.ts` | 216 | 全局文件锁（`~/.claude/computer-use.lock`） | 未修改 |
| `common.ts` | 62 | 常量定义（server name、bundle ID） | 未修改 |
| `cleanup.ts` | — | turn-end 清理（应用恢复、剪贴板恢复） | 未修改 |
| `toolRendering.tsx` | — | 工具结果 UI 渲染 | 未修改 |

### runtime/（Python 运行时）

| 文件 | 行数 | 职责 | 补丁? |
|------|------|------|-------|
| `mac_helper.py` | 660 | 所有系统交互的 Python 实现 | ✅ 新增 |
| `requirements.txt` | 6 | Python 依赖声明 | ✅ 新增 |

---

## 八、设计权衡

### 为什么选择 Python Bridge？

| 维度 | 原生 Swift (.node) | Python Bridge |
|------|-------------------|---------------|
| **性能** | ~0ms（进程内调用） | ~50-100ms（子进程启动） |
| **可读性** | 编译后不可读 | 660 行清晰的 Python |
| **可修改性** | 需要 Swift 编译环境 | 直接编辑 .py 文件 |
| **依赖** | 特定 Bun 版本的 NAPI | 任意 Python 3.8+ |
| **跨平台** | 仅 macOS | pyautogui/mss 天然跨平台 |
| **用户体验** | 无感知 | 无感知（模型思考时间秒级） |

**结论**：50-100ms 的额外延迟在 Computer Use 的场景下完全可以忽略——模型分析截图和决策的时间通常是 2-5 秒，用户不会注意到底层操作多了 100ms。

### 我们尝试过但放弃的方案

**方案一：提取原生 .node 模块**
- 从 Claude Code 二进制中成功提取了 `computer-use-swift.node`（ARM64 424KB）
- 同步方法正常工作，但 **Swift 异步方法的 continuation 永远不会 resume**
- 根因：.node 文件针对 Claude Code 内置 Bun 编译，与用户 Bun 版本不兼容

**方案二：空 Stub 包**
- 代码能编译但所有操作报错——没有实际执行能力

---

## 相关文档

- [Computer Use 功能指南](./computer-use.md) — 使用方式、快速开始、环境变量
- [源码修复记录](/reference/fixes) — 其他修复和补丁的详细记录
