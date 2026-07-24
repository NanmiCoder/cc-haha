# Computer Use Guide

Computer Use lets a model inspect the screen and operate the mouse, keyboard, applications, and clipboard. It acts on the current computer, so review the authorization scope and platform differences before enabling it.

## Supported platforms

| Platform | Status | Important difference |
|---|---|---|
| macOS Apple Silicon / Intel | Supported | Requires Accessibility and Screen Recording; supports native screenshot filtering |
| Windows | Supported | Uses the Windows Python runtime; screenshots are not filtered to authorized windows |
| Linux | Unsupported | There is currently no Linux executor |

The packaged desktop app does not require Bun. Computer Use does require a working Python 3 installation. The app creates an isolated virtual environment under the managed user configuration directory and installs the platform dependencies there.

## Quick start

### Desktop app

1. Open Settings → Computer Use.
2. Enable Computer Use.
3. Check Python status. If automatic discovery fails, select a Python executable.
4. Run Install or Repair so the app can create the virtual environment and install dependencies.
5. On macOS, grant Accessibility and Screen Recording, then check again.
6. Choose the applications that may be controlled and, if needed, enable clipboard and system key permissions.
7. Start a session and describe both the goal and the applications involved.

Start with a small, reversible task:

```text
Take a screenshot and tell me what you can see.
Open Notes and create an empty note titled "Test".
Find the settings entry in the authorized app, but do not change anything.
```

### CLI

Source mode requires the project dependencies and Python 3:

```bash
bun install
python3 --version
./bin/claude-haha
```

Disable the dynamic Computer Use MCP with:

```bash
CLAUDE_COMPUTER_USE_ENABLED=0 ./bin/claude-haha
```

Or set the managed configuration in `~/.claude/cc-haha/computer-use-config.json`:

```json
{
  "enabled": false
}
```

The desktop Settings page updates the same managed configuration. Prefer the UI and do not overwrite unknown fields by hand.

## Tools and Teach capability

The codebase defines 27 Computer Use tools:

| Category | Tools |
|---|---|
| Authorization | `request_access`, `list_granted_applications` |
| Screenshot | `screenshot`, `zoom` |
| Mouse | `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `left_click_drag`, `mouse_move`, `left_mouse_down`, `left_mouse_up`, `cursor_position`, `scroll` |
| Keyboard | `type`, `key`, `hold_key` |
| Applications | `open_application`, `switch_display` |
| Clipboard | `read_clipboard`, `write_clipboard` |
| Control flow | `wait`, `computer_batch` |
| Teach | `request_teach_access`, `teach_step`, `teach_batch` |

There are 24 base control tools. The three Teach tools are exposed only when the host enables the Teach capability; otherwise a session sees only the base tools.

Teach is intended for requests where the user wants to learn a workflow:

1. `request_teach_access` requests access to the applications used by the tour.
2. `teach_step` shows an anchored explanation and waits for the user to choose Next.
3. `teach_batch` groups predictable steps to reduce model round trips.

Teach authorization is separate from regular control authorization. Actions still pass the application allowlist and input safety checks. After the user exits a tour, the model must stop calling Teach tools.

## How it works

Computer Use follows a screenshot → analyze → act → screenshot loop:

```text
Model
  → Computer Use MCP tool
  → TypeScript dispatch and safety checks
  → Python bridge
  → macOS / Windows system operation
  → Screenshot or action result returned to the model
```

- Tool definitions and authorization logic live in `src/vendor/computer-use-mcp/`.
- CLI integration and the Python bridge live in `src/utils/computerUse/`.
- Platform executors live in `runtime/mac_helper.py` and `runtime/win_helper.py`.
- Desktop setup, permissions, and preauthorization are managed by `src/server/api/computer-use.ts` and `desktop/src/pages/ComputerUseSettings.tsx`.

## Authorization model

### Application access

The model first calls `request_access` with the required applications and a reason. The user can approve or deny the request. Applications preauthorized in Settings provide managed defaults; they do not grant arbitrary access to every application. Adding an application during a run still follows the relevant authorization flow.

Applications use three permission tiers:

| Tier | Capability |
|---|---|
| `read` | Inspect screenshots without input |
| `click` | Click, move, and scroll without typing or higher-risk input |
| `full` | Allow keyboard, drag, and other complete input after the remaining checks pass |

### Clipboard and system keys

Clipboard read, clipboard write, and system-level key combinations are separate grants. Authorizing an application does not automatically authorize these capabilities.

### Concurrency

A session lock prevents multiple sessions from competing for the mouse and keyboard. If Computer Use reports that another session owns the lock, finish or stop that session instead of deleting the lock file.

## Platform safety boundaries

### macOS

- Accessibility is required for application input.
- Screen Recording is required for screenshots.
- Screenshots support native window filtering, leaving authorized applications and the desktop visible.

### Windows

- The current screenshot filtering capability is `none`, so screenshots may include every visible window.
- The application allowlist still rejects input aimed at an unauthorized frontmost application.
- Because screenshot content is not filtered, close or minimize windows containing sensitive information before starting.

### Protections that are not currently available

- **There is no global Escape abort hotkey.** Use the current task's Stop action in the desktop app; a CLI run can be interrupted from its terminal.
- **Unauthorized windows are not automatically hidden before every action.** Do not rely on auto-hide for privacy.
- **Pixel staleness validation is disabled by default.** After the UI changes, the model should take another screenshot before clicking.

These are current implementation boundaries and must not be described as completed safeguards.

## Python runtime

During first install or repair, the app:

1. Synchronizes the helper and requirements for the current platform into the managed user directory.
2. Creates a venv with the detected or selected Python.
3. Installs or upgrades pip.
4. Uses the requirements content hash to decide whether dependencies need reinstalling.
5. Calls the platform helper with a JSON payload and parses a uniform JSON response.

macOS primarily uses `mss`, Pillow, PyAutoGUI, and PyObjC. Windows also uses pywin32, psutil, pyperclip, and screeninfo. See `runtime/requirements*.txt` for the current version constraints.

## Troubleshooting

### macOS still reports missing permissions

- Make sure the authorization applies to the app that actually launches Claude Code Haha.
- Fully quit and reopen the app after changing permissions.
- Run the permission check again from Settings.

### Python installation fails

- Select a specific Python 3 executable in Settings.
- Confirm that Python supports `venv`.
- Run Install or Repair again.
- Review the Computer Use installation log in Diagnostics.

### Screenshots work but clicks fail

- Confirm that the target application is authorized.
- Confirm that it is the frontmost application.
- Check whether the permission tier allows the requested action.
- Take a new screenshot after any UI change instead of reusing old coordinates.

### Other windows appear in Windows screenshots

This is a known boundary of the current Windows screenshot capability. The input allowlist does not filter screenshot content. Close or minimize sensitive windows first.

## Learn more

- [Computer Use architecture](./computer-use-architecture.md)
