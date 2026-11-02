# Permissions and Elevation

Windows has no TCC-style permission grant for UI Automation. What controls
access instead is **integrity level**: a Medium-integrity agent can observe and
act on same-integrity applications, and the OS gates what crosses the boundary
upward.

## Same-Integrity Targets Need No Grant

- UIA reads (snapshot, find, get, is, screenshot) and same-integrity input work
  from any terminal with no permission prompt.
- `agent-desktop permissions` probes UIA live rather than consulting a policy
  store: `accessibility` reports `granted` when UIA answers, `automation`
  reports `not_required`, and `screen_recording` reflects capture availability.
- There is no `--request` dialog to trigger; if `accessibility` reports
  `denied`, the cause is an integrity or policy boundary below, not a missing
  checkbox.

## The UIPI Boundary

User Interface Privilege Isolation blocks synthesized input from a
lower-integrity process into a higher-integrity one (Medium to High, such as an
elevated Notepad):

- **Reads cross the boundary.** From Medium, UIA resolves an elevated target's
  name, class, control type, pid, bounds and node count the same as a High
  caller, and `WM_GETTEXT` reads succeed. Observation is never refused across
  the boundary.
- **Writes do not.** The adapter compares the integrity levels of the two
  process tokens before it synthesizes anything, and a strictly higher target
  returns `PERM_DENIED` whose `platform_detail` reads
  `COM HRESULT 0x80070005 (E_ACCESSDENIED: Access is denied)`.
- **Fix:** run agent-desktop from a terminal elevated to the target's level,
  or act on elements that do not cross the boundary.

### Detection Is a Token Read, Never a SendInput Verdict

`SendInput`'s return value proves nothing: it reports success whether or not
the events landed. Only the token comparison above, or a re-read of the effect,
tells delivered from silently dropped. A target whose integrity level the
process cannot read is not assumed to be same-or-lower: the action proceeds
best-effort and is judged by re-reading its effect.

## Window Activation Crosses the Boundary

`focus-window` succeeds against a higher-integrity target.
`SetForegroundWindow` is gated by the Windows foreground-lock heuristic (recent
input, `AllowSetForegroundWindow`), not by integrity. When foreground cannot be
confirmed before the budget runs out, a strictly-higher target returns an
activation-worded `PERM_DENIED` and an equal-integrity target returns
`ACTION_FAILED`.

## Blocked Key Combos

`press` refuses dangerous shortcuts before synthesis. Every modifier order,
key alias (`meta`/`cmd`/`super` to `win`) and modifier superset is caught:

| Blocked | Why |
|---------|-----|
| `alt+f4` | closes the active window |
| `win+l` | locks the session |
| `win+d` | shows the desktop |
| `alt+tab` | steals the foreground mid-run |
| `win+r` | opens Run over the target |
| `win+x` | opens the Quick Link menu over the target |
| `win+e` | opens File Explorer over the target |
| `ctrl+shift+esc` | opens Task Manager over the target |

Supersets such as `alt+shift+tab` are blocked too. `--force` overrides the
guard. `ctrl+alt+delete` is not on the list, because `SendInput` cannot
synthesize the Secure Attention Sequence at all.

## Protected Processes

`close-app` refuses session- and shell-critical images by exact,
case-insensitive `.exe` name: `csrss.exe`, `wininit.exe`, `winlogon.exe`,
`services.exe`, `lsass.exe`, `smss.exe`, `lsaiso.exe`, `dwm.exe`,
`explorer.exe`. Other names close normally, including near-misses such as
`explorer++.exe`. A refusal is `INVALID_ARGS`.

## Cross-Process Interaction Lease

Interactive work holds an exclusive, token-derived lock file, so two concurrent
agent-desktop processes cannot interleave focus changes, clicks and typing on
the same desktop. An inherited-handle mode
(`AGENT_DESKTOP_INTERACTION_LEASE_HANDLE`) lets a parent pass its lease to a
child after re-verifying identity and exclusivity. If acquisition fails, wait
for the other process to finish. Do not bypass the lease.

## The Cursor Overlay's Control Pipe

The cursor overlay is a detached renderer process driven over a named pipe.

**What is protected:**

- Remote clients are rejected (`PIPE_REJECT_REMOTE_CLIENTS`).
- Another user's process is refused in both directions: each connection's
  token user SID must match.
- Before it sends a control, the client checks that the pipe server's
  executable is named `agent-desktop` (case-insensitive, with or without
  `.exe`). This is a file-name check, not a signature check. A mismatch makes
  `enable` report `rendered: false`.
- One renderer per session (`FILE_FLAG_FIRST_PIPE_INSTANCE`). A second renderer
  exits before it creates a window.

**What is not protected: a same-user process on the same machine.** The pipe
has no security descriptor, and its name derives from the state root, the
session id and the protocol generation. A same-user process can:

- hold the name first, so `enable` answers `rendered: false` while it does
  (a missing overlay, never a fake one);
- connect to a live renderer and move the drawn cursor or put any text in the
  label card.

The overlay is presentation-only. It never performs or fails an action and
carries no credential. On a host where other people run processes as your
account, do not trust what the overlay draws, and leave it disabled.
