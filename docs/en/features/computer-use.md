# Computer Use Guide


> **Modified Version**: This feature is a **heavily modified version** of the Computer Use (internal codename "Chicago") found in the leaked Claude Code source. The official implementation relies on Anthropic's private native modules (`@ant/computer-use-swift`, `@ant/computer-use-input`) that are not publicly available. We **replaced the entire underlying operation layer** with a Python bridge (`pyautogui` + `mss` + `pyobjc`), enabling anyone to run Computer Use on macOS.

---

## Table of Contents

- [Overview](#overview)
- [Supported Platforms](#supported-platforms)
- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Security](#security)
- [Environment Variables](#environment-variables)
- [Technical Architecture](#technical-architecture)
- [Approaches We Tried](#approaches-we-tried)
- [Known Limitations](#known-limitations)
- [References and Credits](#references-and-credits)

---

## Overview

Computer Use allows AI models to **directly control your computer** — taking screenshots, moving the mouse, clicking buttons, typing text, and managing application windows.

24 MCP tools are available:

| Category | Tools |
|----------|-------|
| Screenshot | `screenshot`, `zoom` |
| Mouse | `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `left_click_drag`, `mouse_move`, `left_mouse_down`, `left_mouse_up`, `cursor_position`, `scroll` |
| Keyboard | `type`, `key`, `hold_key` |
| Apps | `open_application`, `switch_display` |
| Permissions | `request_access`, `list_granted_applications` |
| Clipboard | `read_clipboard`, `write_clipboard` |
| Other | `wait`, `computer_batch` |

---

## Supported Platforms

| Platform | Architecture | Status | Notes |
|----------|-------------|--------|-------|
| macOS | Apple Silicon (M1/M2/M3/M4) | ✅ Fully supported | Recommended |
| macOS | Intel x86_64 | ✅ Fully supported | |
| Windows | Any | ⚠️ Theoretically possible | Core libs (`pyautogui` + `mss`) are cross-platform, but `pyobjc` parts (app management) need to be replaced with `win32com`. Not yet adapted |
| Linux | Any | ⚠️ Theoretically possible | Same as above — `pyobjc` needs to be replaced with `wmctrl` + `xdotool`. Not yet adapted |

### Requirements

- [Bun](https://bun.sh) >= 1.1.0
- Python >= 3.8 (venv and dependencies are auto-installed on first use)
- macOS permissions: Accessibility + Screen Recording

---

## How It Works

Computer Use operates through a **screenshot → analyze → act** feedback loop:

```
┌────────────────────────────────────────────────────┐
│  AI Model (Claude / any Anthropic-protocol model)   │
│                                                     │
│  1. Receives user request: "open Music app"         │
│  2. Calls screenshot tool → receives screen image   │
│  3. Model analyzes pixels, identifies UI elements   │
│     → "search box is at (756, 342)"                 │
│  4. Calls left_click { coordinate: [756, 342] }     │
│  5. Calls type { text: "search query" }             │
│  6. Calls screenshot again → verify → next step...  │
└───────────────┬────────────────────────────────────┘
                │ MCP Tool Call
                ▼
┌────────────────────────────────────────────────────┐
│  TypeScript Tool Layer (vendor/computer-use-mcp)    │
│  - Security checks (app allowlist, TCC permissions) │
│  - Coordinate transformation                        │
│  - Tool dispatch → executor                         │
└───────────────┬────────────────────────────────────┘
                │ callPythonHelper()
                ▼
┌────────────────────────────────────────────────────┐
│  Python Bridge (runtime/mac_helper.py)              │
│  pyautogui.click(756, 342)   ← mouse control        │
│  mss.grab(monitor)           ← screenshot            │
│  NSWorkspace.open(bundleId)  ← app management        │
└────────────────────────────────────────────────────┘
```

**Key**: Coordinate analysis is performed entirely by the model's vision capabilities — it "sees" the screenshot like a human sees a screen, identifying buttons, text fields, and other UI elements directly from pixels.

---

## Quick Start

### 1. Install dependencies

```bash
bun install
```

### 2. Ensure Python 3 is available

```bash
python3 --version  # >= 3.8 required
```

> Python dependencies are **automatically installed** into `.runtime/venv/` on first Computer Use invocation.

### 3. Grant macOS permissions

**Accessibility:**

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
```

Add your **terminal app** (iTerm, Terminal, Ghostty, etc.) to the allow list.

**Screen Recording:**

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
```

Add your terminal app as well. You may need to **restart your terminal** after granting permission.

### 4. Start

```bash
./bin/claude-haha
```

### 5. Use

Just ask in natural language:

```
> Take a screenshot of my desktop
> Open Safari and search for something
> Type "hello" in the text editor
```

---

## Security

| Mechanism | Description |
|-----------|-------------|
| **App allowlist** | Each session requires explicit authorization for which apps Claude can interact with |
| **Concurrency lock** | Only one Claude session can use Computer Use at a time (file lock) |
| **Clipboard guard** | Original clipboard content is saved and restored when typing via clipboard |
| **Sensitive action gates** | System keyboard shortcuts require additional authorization |

> Note: Since we replaced the native modules with Python bridge, the global Escape hotkey abort and auto-hide features from the original implementation are not available. Use `Ctrl+C` to abort instead.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_COMPUTER_USE_ENABLED` | `1` | Set to `0` to disable Computer Use |
| `CLAUDE_COMPUTER_USE_COORDINATE_MODE` | `pixels` | Coordinate mode: `pixels` or `normalized_0_100` |
| `CLAUDE_COMPUTER_USE_CLIPBOARD_PASTE` | `1` | Enable clipboard-based text input |
| `CLAUDE_COMPUTER_USE_MOUSE_ANIMATION` | `1` | Enable mouse animation |
| `CLAUDE_COMPUTER_USE_DEBUG` | `0` | Debug mode |

---

## Technical Architecture

### Gate Bypass

The official Claude Code gates Computer Use behind three layers:

| Layer | Original Mechanism | Our Approach |
|-------|-------------------|--------------|
| Compile-time | `feature('CHICAGO_MCP')` (Bun macro) | Replaced with `true` |
| Subscription | `hasRequiredSubscription()` (Max/Pro only) | `getChicagoEnabled()` returns `true` directly |
| Remote config | GrowthBook `tengu_malort_pedway` | Same — no remote dependency |
| Default-disabled | `isDefaultDisabledBuiltin('computer-use')` | Returns `false` |

### Python Bridge

On first invocation, the bridge automatically:
1. Creates a Python virtual environment (`.runtime/venv/`)
2. Installs pip
3. Installs dependencies (`mss`, `Pillow`, `pyautogui`, `pyobjc-*`)
4. Validates via SHA256 hash (only reinstalls when `requirements.txt` changes)

---

## Approaches We Tried

### Approach 1: Extract native .node modules from Claude Code binary ❌

Extracted `computer-use-swift.node` and `computer-use-input.node` from the installed Claude Code Mach-O binary. Synchronous methods worked, but async Swift methods (screenshot) hung due to N-API async incompatibility between Bun versions.

### Approach 2: Create empty stub packages ❌

Stub packages allowed compilation but provided no actual functionality.

### Approach 3: Python Bridge ✅ (current)

Replaced all native module calls with Python subprocess calls via `callPythonHelper()`. Zero binary dependencies, auto-bootstrapping, full functionality on any macOS.

---

## Known Limitations

| Limitation | Description |
|------------|-------------|
| macOS only | Windows/Linux need `pyobjc` replacements |
| No global Escape abort | Original used CGEventTap; use `Ctrl+C` instead |
| No auto-hide windows | Original's `prepareDisplay` relied on Swift |
| Slightly higher latency | ~100ms Python process startup overhead per call |

---

## References and Credits

| Project | License | Contribution |
|---------|---------|-------------|
| [wimi321/macos-computer-use-skill](https://github.com/wimi321/macos-computer-use-skill) | MIT | Python bridge architecture, `mac_helper.py` runtime, executor adaptation |
| [domdomegg/computer-use-mcp](https://github.com/domdomegg/computer-use-mcp) | MIT | Independent Computer Use MCP server (nut.js based), used as reference |
| [paoloanzn/free-code](https://github.com/paoloanzn/free-code) | - | Feature flag system analysis |
| [oboard/claude-code-rev](https://github.com/oboard/claude-code-rev) | - | Early leaked source restoration, stub package reference |

### Underlying Libraries

| Library | Purpose |
|---------|---------|
| [pyautogui](https://github.com/asweigart/pyautogui) | Mouse and keyboard control |
| [mss](https://github.com/BoboTiG/python-mss) | Screenshot capture |
| [Pillow](https://github.com/python-pillow/Pillow) | Image processing and compression |
| [pyobjc](https://github.com/ronaldoussoren/pyobjc) | macOS Cocoa/Quartz framework bindings |
