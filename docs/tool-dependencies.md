# 工具依赖项文档

本文档记录项目中所有工具的**非基础**外部依赖。"基础能力"指 Windows Git Bash 自带的 Unix 标准命令（如 `cat`, `ls`, `grep`, `git`, `npm` 等），这些不需要额外安装。

## 目录

- [核心依赖（必须）](#核心依赖必须)
- [平台专用依赖](#平台专用依赖)
- [可选/功能门控依赖](#可选功能门控依赖)
- [Vendored 依赖](#vendored-依赖)
- [开发环境依赖（本项目当前状态）](#开发环境依赖本项目当前状态)
- [环境变量速查](#环境变量速查)

---

## 核心依赖（必须）

这些是工具运行所必需的外部程序，缺失会导致对应工具不可用。

### ripgrep (`rg`)

| 属性 | 说明 |
|------|------|
| **影响工具** | `GrepTool`, `GlobTool` |
| **代码位置** | `src/utils/ripgrep.ts` |
| **用途** | 高性能正则搜索文件内容 (`GrepTool`) 和文件名匹配 (`GlobTool`) |
| **缺失表现** | 报错 `Executable not found in $PATH`，只能通过 Bash 的 `grep` 进行搜索 |

**查找优先级** (`src/utils/ripgrep.ts:31-65`)：

| 优先级 | 来源 | 条件 |
|--------|------|------|
| 1 | 系统 `rg` | `USE_BUILTIN_RIPGREP=0` 且在 PATH 中找到 `rg` |
| 2 | 嵌入式 | `isInBundledMode()` 为 true（Bun 编译模式） |
| 3 | Vendored | 路径 `src/utils/vendor/ripgrep/<arch>-<platform>/rg(.exe)` |

**安装方式**：

```powershell
# Windows (推荐)
scoop install ripgrep

# 或 choco install ripgrep
# 或手动下载: https://github.com/BurntSushi/ripgrep/releases
```

安装后在 `.env` 中配置：
```
USE_BUILTIN_RIPGREP=0
```

> **当前项目状态**: 系统未安装 `rg`，`vendor/` 目录不存在，开发模式下嵌入式路径也不可用。三个路径全部失效，导致 `Glob` / `Grep` 工具不可用。

### Shell 解释器

| 属性 | 说明 |
|------|------|
| **影响工具** | `BashTool` |
| **代码位置** | `src/utils/Shell.ts:73-137` |
| **用途** | 执行用户的 shell 命令 |
| **查找顺序** | `$CLAUDE_CODE_SHELL` → `$SHELL` → `which(zsh)` → `which(bash)` → `/bin/bash` |

Git Bash 已提供 `bash`，正常情况下无需额外安装。

### PowerShell

| 属性 | 说明 |
|------|------|
| **影响工具** | `PowerShellTool` |
| **代码位置** | `src/utils/shell/powershellDetection.ts:25-70` |
| **用途** | 执行 PowerShell 命令 |
| **查找顺序** | `which(pwsh)` → `which(powershell)` |

Windows 系统自带 `powershell.exe`。`pwsh` (PowerShell Core 7+) 为可选升级。

---

## 平台专用依赖

### Windows

| 命令 | 代码位置 | 用途 | 必须? |
|------|----------|------|-------|
| `powershell.exe` | `src/server/services/desktopCliLauncherService.ts` | PATH 管理 | 否 |
| `powershell.exe` | `src/utils/imagePaste.ts` | Windows 剪贴板图片操作 | 否 |
| `reg` | `src/utils/deepLink/registerProtocol.ts` | URL scheme 注册表操作 | 否 (深链功能) |
| `reg` | `src/utils/settings/mdm/rawRead.ts` | MDM 组策略设置读取 | 否 (企业功能) |
| `reg` | `src/utils/claudeInChrome/setup.ts` | Chrome 扩展安装 | 否 (Chrome 集成) |
| `explorer` | `src/utils/browser.ts` | 文件/文件夹打开 | 否 |
| `rundll32` | `src/utils/browser.ts` | URL 打开 | 否 |
| `clip` | `src/ink/termio/osc.ts` | 剪贴板写入（OSC 52 回退） | 否 |
| `cmd` | `src/utils/desktopDeepLink.ts` | 深链处理 | 否 (深链功能) |
| `wt.exe` | `src/utils/deepLink/terminalLauncher.ts` | Windows Terminal 启动 | 否 (终端启动) |
| `tasklist` | `src/utils/ide.ts` | 检测运行中的 IDE | 否 |
| `where.exe` | `src/utils/which.ts` | 查找 PATH 中的可执行文件 | **是** (`which` 的 Windows 实现) |

### macOS

| 命令 | 代码位置 | 用途 | 必须? |
|------|----------|------|-------|
| `osascript` | `src/services/notifier.ts`, `src/utils/imagePaste.ts`, `src/utils/screenshotClipboard.ts` | 系统通知、剪贴板、AppleScript | 否 |
| `security` | `src/utils/auth.ts`, `src/utils/secureStorage/macOsKeychainStorage.ts` | Keychain 凭证读写 | **是** (凭证存储) |
| `codesign` | `src/utils/ripgrep.ts` | 对 vendored rg 进行 ad-hoc 签名 | 否 (仅 vendored 模式) |
| `xattr` | `src/utils/ripgrep.ts` | 移除 vendored rg 的 quarantine 属性 | 否 (仅 vendored 模式) |
| `defaults` | `src/services/notifier.ts`, `src/utils/appleTerminalBackup.ts` | 用户默认配置读写 | 否 |
| `caffeinate` | `src/services/preventSleep.ts` | 防止长时间运行中系统休眠 | 否 |
| `open` | `src/utils/browser.ts` | URL/文件打开 | 否 |
| `pbcopy` | `src/ink/termio/osc.ts` | 剪贴板写入 | 否 |
| `killall` | `src/commands/terminalSetup/terminalSetup.tsx` | 刷新 cfprefsd | 否 |
| `/usr/libexec/PlistBuddy` | `src/commands/terminalSetup/terminalSetup.tsx` | Terminal.app plist 修改 | 否 |
| `lsregister` | `src/utils/deepLink/registerProtocol.ts` | URL scheme 注册 | 否 (深链功能) |

### Linux

| 命令 | 代码位置 | 用途 | 必须? |
|------|----------|------|-------|
| `xdg-open` | `src/utils/browser.ts` | URL/文件打开 | 否 |
| `xdg-mime` | `src/utils/deepLink/registerProtocol.ts` | MIME 类型查询 | 否 (深链功能) |
| `x-terminal-emulator` | `src/utils/deepLink/terminalLauncher.ts` | 终端启动 | 否 |
| `xclip` / `xsel` | `src/utils/imagePaste.ts`, `src/ink/termio/osc.ts` | X11 剪贴板读写 | 否 |
| `wl-copy` / `wl-paste` | `src/ink/termio/osc.ts`, `src/utils/imagePaste.ts` | Wayland 剪贴板读写 | 否 |
| `arecord` | `src/services/voice.ts` | ALSA 语音录制 | 否 (语音功能) |
| `rec` (SoX) | `src/services/voice.ts` | 语音录制 | 否 (语音功能) |

---

## 可选/功能门控依赖

### tmux（多 Agent 面板管理）

| 属性 | 说明 |
|------|------|
| **影响功能** | 多 Agent teammate 面板、worktree 开发面板、fullscreen 模式 |
| **代码位置** | `src/utils/swarm/constants.ts`, `src/utils/swarm/backends/TmuxBackend.ts`, `src/tools/shared/spawnMultiAgent.ts` |
| **缺失表现** | 多 Agent swarm 功能不可用，退化为单面板模式 |

```bash
# Windows (Git Bash 不自带)
scoop install tmux
```

### iTerm2（macOS 多 Agent 面板）

| 属性 | 说明 |
|------|------|
| **影响功能** | 多 Agent teammate 面板（macOS 专用，tmux 的替代） |
| **代码位置** | `src/utils/swarm/backends/ITermBackend.ts`, `src/utils/swarm/backends/detection.ts` |
| **缺失表现** | iTerm2 多面板功能不可用，退化为 tmux 或单面板模式 |

### GitHub CLI (`gh`)

| 属性 | 说明 |
|------|------|
| **影响功能** | PR 查看/评论、GitHub App 安装、远程仓库设置、PR 状态检测 |
| **代码位置** | `src/utils/github/ghAuthStatus.ts`, `src/commands/install-github-app/`, `src/utils/ghPrStatus.ts` |
| **缺失表现** | `/gh` 相关命令不可用，GitHub API 操作失败 |

```bash
scoop install gh
```

### Python 3

| 属性 | 说明 |
|------|------|
| **影响功能** | Computer Use (截图分析、鼠标/键盘控制辅助脚本) |
| **代码位置** | `src/utils/computerUse/pythonBridge.ts`, `src/server/api/computer-use-python.ts` |
| **缺失表现** | Computer Use 的 Python 辅助功能不可用 |
| **查找顺序** | `which(python3)` → `which(py)` → 创建 venv |

### 语音录制

| 属性 | 说明 |
|------|------|
| **影响功能** | 语音输入 |
| **代码位置** | `src/services/voice.ts` |
| **依赖** | macOS: CoreAudio (原生 NAPI)；Linux: `arecord` (ALSA) 或 `rec` (SoX)；Windows: 原生 NAPI |
| **缺失表现** | 语音输入功能不可用 |

### 剪贴板图片（非文本）

| 属性 | 说明 |
|------|------|
| **影响功能** | 从剪贴板粘贴图片 |
| **代码位置** | `src/utils/imagePaste.ts`, `src/utils/screenshotClipboard.ts` |
| **依赖** | macOS: `osascript`；Linux: `xclip`；Windows: `powershell.exe` |

### LSP 服务（语言服务器）

| 属性 | 说明 |
|------|------|
| **影响功能** | `LSPTool` — 代码定义跳转、引用查找、诊断 |
| **代码位置** | `src/services/lsp/LSPClient.ts`, `src/tools/LSPTool/LSPTool.ts` |
| **依赖** | 用户通过插件配置的 LSP 服务器，如 `typescript-language-server`、`rust-analyzer`、`pyright` 等 |
| **缺失表现** | LSP 功能不可用，启动时 `ENOENT` 错误被静默捕获 |

### MCP 服务

| 属性 | 说明 |
|------|------|
| **影响功能** | `MCPTool` — 模型上下文协议工具集成 |
| **代码位置** | `src/services/mcp/client.ts`, `src/tools/MCPTool/MCPTool.ts` |
| **依赖** | 用户通过 `.mcp.json` 或 `settings.json` 配置的 MCP stdio 服务器。传输层支持 sse/http/ws/stdio/sdk |
| **缺失表现** | 对应 MCP 工具不可用 |

### 编辑器集成

| 属性 | 说明 |
|------|------|
| **影响功能** | 在编辑器中打开文件 (`/ide` 命令) |
| **代码位置** | `src/utils/editor.ts`, `src/commands/ide/ide.tsx` |
| **依赖** | `code` (VSCode), `cursor`, `windsurf`, `subl`, `notepad++`, `vi`, `vim`, `nvim`, `nano`, `emacs` 等 |
| **缺失表现** | 编辑器打开文件功能退化为仅终端编辑器 |

### Sandbox

| 属性 | 说明 |
|------|------|
| **影响功能** | 命令执行的沙箱隔离 |
| **代码位置** | `src/components/sandbox/SandboxDependenciesTab.tsx` |
| **依赖** | `bwrap` (bubblewrap, Linux), `socat` |

### 浏览器集成

| 属性 | 说明 |
|------|------|
| **影响功能** | Claude in Chrome 扩展安装 |
| **代码位置** | `src/utils/claudeInChrome/setup.ts`, `src/utils/claudeInChrome/common.ts` |
| **依赖** | Chrome/Chromium 浏览器, Windows: `reg` |

---

## Vendored 依赖

以下依赖预期随项目分发，位于 `src/utils/vendor/` 目录下。

| 依赖 | 预期路径 | 当前状态 |
|------|----------|----------|
| **ripgrep** | `src/utils/vendor/ripgrep/<arch>-<platform>/rg(.exe)` | ❌ 目录不存在 |

`vendor/` 目录在 git 中可能通过 `.gitignore` 排除，需要构建/安装脚本下载。macOS 上还会通过 `codesign` 和 `xattr` 对 vendored 二进制进行签名和去隔离处理。

---

## 开发环境依赖（本项目当前状态）

在 Windows + Git Bash 开发环境下，以下依赖状态值得关注：

| 依赖 | 状态 | 影响 | 建议 |
|------|------|------|------|
| **ripgrep** | ❌ 未安装, vendor 目录不存在 | `Glob`/`Grep` 工具不可用 | `scoop install ripgrep` + 在 `.env` 设 `USE_BUILTIN_RIPGREP=0` |
| **bash** | ✅ Git Bash 自带 | `BashTool` 正常 | - |
| **powershell** | ✅ Windows 自带 | `PowerShellTool` 正常 | - |
| **git** | ✅ Git Bash 自带 | git 相关功能正常 | - |
| **tmux** | ⚠️ 未安装 | 多 Agent 面板不可用 | `scoop install tmux` (可选) |
| **gh** | ⚠️ 未安装 | GitHub PR 功能不可用 | `scoop install gh` (可选) |
| **python3** | ⚠️ 未安装 | Computer Use Python 辅助不可用 | `scoop install python` (可选) |

---

## 环境变量速查

| 变量 | 作用 | 代码位置 |
|------|------|----------|
| `USE_BUILTIN_RIPGREP=0` | 优先使用系统安装的 `rg` | `src/utils/ripgrep.ts:33` |
| `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` | 覆盖 ripgrep 超时 (默认 20s, WSL 60s) | `src/utils/ripgrep.ts:132` |
| `CLAUDE_CODE_SHELL` | 指定 BashTool 使用的 shell | `src/utils/Shell.ts` |
| `DISABLE_INSTALLATION_CHECKS` | 跳过安装诊断和通知 | `src/utils/doctorDiagnostic.ts:443` |
| `CLAUDE_CODE_GLOB_NO_IGNORE` | 设为 `0` 时 Glob 遵守 `.gitignore` | `src/utils/glob.ts:98` |
| `CLAUDE_CODE_GLOB_HIDDEN` | 设为 `0` 时 Glob 排除隐藏文件 | `src/utils/glob.ts:99` |
| `ENABLE_LOCKLESS_UPDATES` | 启用无锁更新模式 | `src/utils/nativeInstaller/installer.ts` |
