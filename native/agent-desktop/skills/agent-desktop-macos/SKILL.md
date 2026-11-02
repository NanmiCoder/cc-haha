---
name: agent-desktop-macos
tags: macos-automation, accessibility, ax, tcc, ai-agent, gui-automation, cli
requirements:
  - agent-desktop
description: >
  macOS platform guide for the agent-desktop CLI. Use for desktop automation
  on macOS: granting Accessibility and Screen Recording permission (TCC),
  what headed mode does on macOS (physical-first click, type and scroll),
  surfaces (menu, menubar, sheet, popover, alert), Notification Center,
  Chromium and Electron apps including launch --cdp, and fixing PERM_DENIED,
  empty accessibility trees, ACTION_FAILED and APP_UNRESPONSIVE.
---

# agent-desktop on macOS

Read the core skill first (`agent-desktop skills get desktop`) for the observe, act, verify loop. This skill covers only what is different on macOS. Symptoms and fixes are in [references/troubleshooting.md](references/troubleshooting.md).

## Requirements

- macOS 13 or later, Intel or Apple Silicon.
- Accessibility permission for the app that launches agent-desktop (Terminal, iTerm2, Warp, VS Code, Codex). macOS 27 and later name this list Device Control and Data Access. If System Settings lists the `agent-desktop` binary separately, grant it too.
- Screen Recording permission, only for `screenshot` and for `session start --screenshots` artifacts.
- Automation permission for System Events, only where a command reports it missing.

## First contact

1. Run `agent-desktop permissions`.
2. If a permission is denied, run `agent-desktop permissions --guide`. It opens the correct System Settings page with a panel that shows the user which app to drag into the list. The user confirms with Touch ID or a password, and the panel moves to the next missing permission by itself. The command returns at once with `"guide": "started"`, `"already_running"` or `"not_needed"`. `agent-desktop permissions --request` shows the system prompts instead.
3. If the guide cannot run, open System Settings > Privacy & Security > Accessibility (Device Control and Data Access on macOS 27 and later). Add the launching app and turn it on.
4. Run `agent-desktop permissions` to confirm `granted`. The next agent-desktop call sees a new grant, so the launching app does not need a restart.
5. Run `agent-desktop snapshot -i` to confirm. It reads the focused app. `snapshot --app Finder -i` returns `WINDOW_NOT_FOUND` when Finder has no open window.

`permissions` does not prompt. `permissions --request` can prompt, including for Automation. `permissions --guide` does not prompt and covers Accessibility and Screen Recording only. Automation reports `unknown` when macOS would need to prompt.

## What differs on macOS

**Headed is physical first** for `click`, `right-click`, `type`, `clear` and `scroll`. Core focuses the exact window of the ref. The adapter then sends a real click, key or wheel event to the verified point. `expand`, `collapse`, `set-value`, `select`, `toggle`, `check`, `uncheck`, `focus` and `scroll-to` stay semantic under `--headed`. Double-click, triple-click, `hover` and `drag` need `--headed`. Raw `--xy` input never changes focus.

**Judge delivery by observation.** AX return codes do not prove an effect. Finder returns success from an `AXConfirm` that does nothing. Snapshot again or use `get` and `is` to check the result.

**Surfaces.** Use `--surface menubar` for File, Edit and View menus and for menu bar apps (status items). While a menu, sheet, alert or popover is open, refs from the window tree behind it are the wrong target.

**Menus.** `right-click` headless uses `AXShowMenu`. If the menu opened but the app returned `APP_UNRESPONSIVE` with `retry: unsafe`, do not retry. Inspect the menu with `--surface menu`. For combo boxes and menu buttons, use `select @ref "Option"`. `select` needs a closed-to-open menu transition, so dismiss any open menu first.

**Notification Center.** The notification commands drive Notification Center through accessibility, with the rules in the core `commands-system` reference. When agent-desktop opens the center, it closes it afterwards and restores the previous app focus. Pass both `--expected-app` and `--expected-title` on a single dismiss or action, because the stack shifts. Use `wait --notification --app "App"` for banners that vanish before you list them.

**Chromium and Electron.** agent-desktop switches on the web accessibility of a Chromium renderer automatically when it needs it. For a dense running app, use `snapshot --skeleton -i --compact`, then drill with `--root @ref`.

**Identity.** `launch` accepts a display name (`"System Settings"`) or a bundle ID (`com.apple.systempreferences`). Other commands take the display name through `--app`. Window IDs such as `w-4521` stay valid for the life of the window. Find them with `list-windows`.

**Keys.** The primary modifier is `cmd`: `press cmd+c`, `press cmd+s`. Quit shortcuts such as `cmd+q`, `cmd+shift+q`, `cmd+alt+esc`, `ctrl+cmd+q` and `cmd+shift+delete` return `POLICY_DENIED` unless you pass `--force`. To quit an app, use `close-app`. Punctuation keys work in combos, as the symbol (`,` `.` `/` `;` `'` `[` `]` `\` `-` `=` `` ` ``) or by name (`comma`, `period`, `slash`, `semicolon`, `quote`, `leftbracket`, `rightbracket`, `backslash`, `minus`, `equal`, `grave`). Each one is sent with the key that types it in the active keyboard layout, so `press cmd+,` opens Settings on ANSI and JIS keyboards alike.

**Cursor overlay.** `cursor-overlay enable` draws the agent cursor in a click-through window. It never moves the OS pointer or activates an app. The macOS motion and image limits are in the core `commands-system` reference.

## Next step

When a command fails, find the symptom in [references/troubleshooting.md](references/troubleshooting.md).
