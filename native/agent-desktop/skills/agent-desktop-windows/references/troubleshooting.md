# Troubleshooting

Symptom-to-cause map for the Windows adapter. Each entry names the observable
symptom first.

## Empty or Tiny Tree

| Symptom | Cause | Fix |
|---------|-------|-----|
| Chromium/Electron app returns far fewer nodes than the UI shows | The first read came before the renderer's accessibility build settled | Run `snapshot --timeout-ms 30000`. The settle can take 10 to 25 s cold. See `chromium-and-electron.md` |
| Node count frozen at a small number however long you wait | Other windows fully cover the target during the settle | Bring the target to the foreground or minimize the covering windows, then snapshot again |
| WPF app: one node, `ClassName` like `HwndWrapper[...]`, zero children | A read before the automation peer existed bound the generic HWND provider permanently | Take a fresh snapshot. In-process retries never recover |
| Custom-rendered UI or a game returns nothing meaningful | No accessibility exposure at all | Out of scope. Use screenshots for verification only |

## PERM_DENIED with an E_ACCESSDENIED Detail

```json
"code": "PERM_DENIED",
"platform_detail": "COM HRESULT 0x80070005 (E_ACCESSDENIED: Access is denied)"
```

Cause: the target runs at a strictly higher integrity level, typically an
elevated app driven from a Medium terminal. UIPI blocks synthesized input across
that boundary, while reads still succeed.

Fix: run your terminal elevated to the target's level. See
`permissions-and-elevation.md`.

## COM Apartment Error

```json
"message": "... COM multithreaded apartment ..."
```

Cause: UIA needs the calling thread to belong to a COM apartment. The CLI joins
the multithreaded apartment itself, so this error means an embedding host's
threading conflicts with it.

Fix: in an FFI consumer, initialize through the library's bootstrap entrypoints
instead of calling UIA from arbitrary threads. The error's `suggestion` names
joining the multithreaded apartment. The defect is in the calling process, not
in the target application.

## DPI-Scaled Coordinates

Symptom: headed coordinate actions (`mouse-click --xy`, drag endpoints) land
offset from the visible element on scaled or multi-monitor setups.

Cause: without per-monitor awareness, Windows reports virtualized coordinates.
The adapter applies `Per-Monitor V2` at startup, so bounds and `--xy` values are
physical pixels.

- A host that already set an incompatible awareness context is tolerated
  (`ERROR_ACCESS_DENIED` on the second call means it is already set).
- If startup reports `INTERNAL` with a `SetProcessDpiAwarenessContext` Win32
  error detail, the hosting process locked the context first. Run from a plain
  terminal instead of an embedded host.
- Prefer refs to raw coordinates.

## The Binary Will Not Start

agent-desktop ships unsigned on Windows. Three execution controls treat that
differently:

- **SmartScreen:** a browser download carries Mark-of-the-Web, so
  double-clicking it can show "Windows protected your PC". Choose More info,
  then Run anyway. The npm package bundles the binary and downloads nothing,
  so npm installation attaches no mark and fires no mark-gated prompt.
- **Antivirus quarantine:** Defender or another scanner may quarantine a new
  unsigned executable however it was obtained. Restore or allow-list it after
  you verify the published SHA-256 checksum.
- **Smart App Control:** on a clean Windows 11 install it blocks unknown
  unsigned executables at process creation, including command-line launches.
  No download path or launch mode avoids it. Turn Smart App Control off or use
  a signed build.

## POLICY_DENIED from a Shell-Surface or Notification Command

Symptom: `open-system-surface`, `list-notifications`, `wait --notification` or a
notification mutation returns `POLICY_DENIED` without touching the desktop.

Cause: the command raises shell chrome and so takes the foreground, which strict
headless refuses before anything is raised.

Fix: pass global `--headed`, or raise the surface yourself first.
`snapshot --surface <kind>` reads an already-present shell surface headless, and
`list-notifications` and `wait --notification` adopt an already-open Action
Center.

## wait --notification Times Out While Toasts Are Being Posted

Cause: the Action Center collects a toast only while it is open, and the wait
opens and closes the center on each poll, so a toast posted between polls is
lost.

Fix: hold the center open yourself across the staging window, so the polls
adopt it without closing it, or confirm the toast with a `list-notifications`
taken while the center is open.

## A Hosted (UWP) App Reads as ApplicationFrameHost

Symptom: `focused_window` or `list-windows` reports a hosted UWP app (Settings
and its peers) under the frame host's identity, or an identity verified against
the app's pid stops resolving.

Cause: the app is suspended, which drops its `CoreWindow` while the frame
survives. See "Hosted (UWP) Window Identity" in `shell-and-overlay.md`.

Fix: activate the app so it resumes, then list again.

## INTERNAL: "private file parent is owned by a foreign principal"

```json
"code": "INTERNAL",
"message": "private file parent is owned by a foreign principal, not this
process's token user, token owner, or an owner-eligible token group; if a
different principal owns this path intentionally, relocate the state root with
AGENT_DESKTOP_HOME instead of reusing it"
```

Cause: a process with a different token owner created the state root
(`~/.agent-desktop`). On Windows this is almost always an elevated (Run as
administrator) shell that reuses a directory a non-elevated session created, or
the reverse. The ownership check protects refmaps and trace segments from a
pre-planted path.

Fix: run from one elevation level, or set `AGENT_DESKTOP_HOME` to a fresh
absolute directory for the elevated session. Do not take ownership of the
existing directory or open its ACL to work around the error, because that
defeats the check.

## Action Verification

Every stateful action (`set-value`, `clear`, `type`, `toggle`, `check`,
`uncheck`, `expand`, `collapse`) runs **exactly once**, then re-reads live
state. The settle loop polls every 50 ms up to a 400 ms cap and stops as soon as
the postcondition holds. It never runs the action again.

The three outcomes are not interchangeable:

- The readback matches: `disposition.delivery` is `delivered_verified`. A value
  write also carries `details.verification_scope: "element_value"` with
  `application_commit: "not_verified"`: the control holds your value, but it
  cannot say whether the application committed it.
- The readback contradicts the request: `ACTION_FAILED` with
  `details.kind: "post_action_verification"` and `details.post_state`. **Read
  `post_state` before anything else.** The action was delivered, so
  `disposition.retry` is `unsafe`.
- The evidence was never observed: the action succeeds as
  `delivered_unverified` with `details.verification_scope: "unavailable"`. This
  is not a failure and not proof that nothing changed. The element lacks the
  UIA property the check needs, such as a TogglePattern or
  ExpandCollapsePattern, or the read failed. **`type` is verified only when the
  focused field exposes a readable Text pattern selection.** Without one, `type`
  lands here. Confirm the value with a fresh `get` if it matters.

**A `set-value` that the application reshapes reads as failed.** If the app
trims whitespace, reformats a date or normalizes a number, the readback differs
from what you wrote, and the envelope says `ACTION_FAILED` although the write
landed. The `SetValue` check captures no before-state, so it cannot tell
"nothing happened" from "accepted and reshaped". Compare
`details.post_state.value` with what you sent: your value in the app's own
format means the write succeeded. Numeric tolerance is role-scoped: only
`slider`, `incrementor`, `scrollbar` and `handle` compare numerically, so a
`textfield` that stores `42.0` after you wrote `42` fails this way.

## Saving a document, headless, without keyboard input

No `save` command exists. Saving is a menu path plus a dialog, and the whole
chain is semantic, so it needs no `--headed` and no keystrokes. The same shape
fits any app whose save flow is File, then Save As.

The script runs as written against an open Notepad. Each ref comes from the JSON
of the step before it, so the sequence stays correct when the tree shifts.

```powershell
$out = "$env:TEMP\notepad-save-demo.txt"

agent-desktop restore --app notepad.exe                 # only if minimized; behind is fine
$doc = (agent-desktop find --app notepad.exe --role textfield | ConvertFrom-Json).data.matches[0]
agent-desktop set-value $doc.ref_id "the document body"

$file = (agent-desktop find --app notepad.exe --role menuitem --name "File" | ConvertFrom-Json).data.matches[0]
agent-desktop expand $file.ref_id
agent-desktop wait --menu --app notepad.exe             # the open menu is its own surface
$menu = (agent-desktop snapshot --app notepad.exe --surface menu | ConvertFrom-Json).data.tree
agent-desktop click ($menu.children | Where-Object name -eq 'Save As...').ref_id

agent-desktop wait --window "Save As" --app notepad.exe # the dialog is a new window
$dialog = (agent-desktop list-windows --app notepad.exe | ConvertFrom-Json).data |
    Where-Object title -eq 'Save As'
$name = (agent-desktop find --name "File name" --window-id $dialog.id | ConvertFrom-Json).data.matches |
    Where-Object role -eq 'textfield'
agent-desktop set-value $name.ref_id $out               # full path goes in the name field

$save = (agent-desktop find --role button --name "Save" --window-id $dialog.id | ConvertFrom-Json).data.matches[0]
agent-desktop click $save.ref_id
agent-desktop wait --window "notepad-save-demo - Notepad" --app notepad.exe
Get-Content $out
```

Three things that surprise a first-time caller:

- **`find --name "File name"` returns three matches:** a `statictext` label, a
  `combobox`, and the `textfield` inside the combobox. Only the textfield
  accepts `set-value`, so match on `role` as well as name.
- **The full path in the name field selects the directory.** There is no
  separate folder step, and navigating the file list by ref is far more fragile.
- **The file does not exist when the Save click returns.** The shell took
  10.9 s between the click's envelope and the file on disk. Wait for the title
  change with `wait --window`. A fixed sleep of a second or two reads as a
  missing file.

The dialog's Save button returns `delivered_unverified`, because a synthesized
invoke cannot confirm what the shell dialog did with it. Verify by reading the
file back from disk.
