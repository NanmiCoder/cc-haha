# Bus and Permissions on Linux

Observation and semantic actions need no permission dialog. Whether the AT-SPI
accessibility bus answers gates everything.

## How the CLI finds the bus

1. It connects to the D-Bus session bus of the current session (from
   `DBUS_SESSION_BUS_ADDRESS` or the runtime directory).
2. It calls `GetAddress` on `org.a11y.Bus`. The call auto-starts the bus
   launcher, so a healthy session that has not used accessibility yet still
   answers.
3. It connects to the address it got and reads `ChildCount` on the AT-SPI
   registry root. Every later command reuses that connection and reconnects
   after a connection-level failure.

The accessibility bus is not the session bus. Judge health with `status`, not
with `busctl --user list` or a name-owner check: on a cold session
`org.a11y.Bus` has no owner until the first `GetAddress`, so a healthy session
looks missing.

## The three bus states

| State | `status` shows | Meaning |
|-------|----------------|---------|
| Answered, healthy | `accessibility` is `granted`; `supported_surfaces` lists surfaces; `list-apps` returns rows | Normal |
| Answered, empty | `accessibility` is `granted`; `list-apps` returns no rows | The bus is up and no app registered. This is a success, not a fault. Start an app, or restart one that started before the bus existed |
| Unavailable | `accessibility` is `denied` with a suggestion; `supported_surfaces` is empty; commands fail with `PLATFORM_NOT_SUPPORTED` | The session bus or the accessibility bus cannot be reached. The empty `supported_surfaces` list is a consequence, not a separate problem |

An app that started before the accessibility bus existed never registers on a
bus that appears later: restart it. A false `toolkit-accessibility` GSettings
key does not stop the bus or the apps from working. The `IsEnabled` property is
not a diagnostic.

## Commands

On a hand-started session the AT-SPI registry that starts on first use prints
`SpiRegistry daemon is running with well-known name - org.a11y.atspi.Registry`
on the terminal of the process that started the bus. That is not CLI output:
the CLI's stdout stays one JSON envelope and its stderr stays empty on success.

```bash
agent-desktop status
agent-desktop permissions
```

| `permissions` field | Linux value |
|---------------------|-------------|
| `accessibility` | `granted` when the bus answered, `denied` with a cause-specific suggestion when it cannot be reached |
| `screen_recording` | `not_required` on X11; `unknown` on Wayland (only a screenshot request shows the answer) |
| `automation` | `not_required` |

`permissions --request` has nothing to request on Linux.

## Unavailable bus: the four causes

Each cause returns `PLATFORM_NOT_SUPPORTED`, `details.retryable: false`, a
suggestion naming the next step, and the raw D-Bus error in `platform_detail`.

| Cause | Suggestion | Meaning |
|-------|------------|---------|
| No session bus | Run inside a desktop session, or start one with `dbus-run-session -- <command>` | `DBUS_SESSION_BUS_ADDRESS` and the runtime socket are missing |
| AT-SPI not installed | Install `at-spi2-core`; Flatpak: add `--talk-name=org.a11y.Bus`; snap: connect `desktop-legacy` or `unity7` | `GetAddress` answered `ServiceUnknown` or `NameHasNoOwner` |
| Launcher cannot start | Read `systemctl --user status at-spi-dbus-bus.service` | The launcher failed to spawn |
| Socket gone | Restart `at-spi-dbus-bus.service`, or log out and back in | The accessibility bus socket is missing or refuses connections |

A timeout is `TIMEOUT`, not one of these causes, and proves nothing about the
bus. A bus that dies mid-session returns `INTERNAL` with a retry suggestion.
Registry reads, shell-owner lookups and permission probes drop the failed cached
connection so a later call reconnects. An established adapter does not
auto-start a replacement bus during recovery, so repeated calls remain
`INTERNAL` until the accessibility service is running again. A new adapter keeps
normal bus activation. The loss alone does not prove whether an action was
delivered. Do not retry an action unless its disposition says retry is safe.

Do not run the restart suggestion on a machine where another process owns the
bus. The suggestion is right on your own desktop. On a shared host a second
launcher that shares the runtime directory can delete the live bus socket and
break every other client. Use a private session instead:

```bash
XDG_RUNTIME_DIR=$(mktemp -d) dbus-run-session -- agent-desktop status
```

The private `XDG_RUNTIME_DIR` (`mktemp -d` makes it mode 0700) keeps the new bus
launcher away from the live socket.

## Session requirements

- Run the CLI as the user who owns the session. A process of another user or
  session is not matched by name.
- The target app must run on the same session bus. A process whose environment
  names another bus counts as another session's.
- A sandboxed app (Flatpak, snap) is on the bus only when the sandbox shares it.
  See `references/shell-tray-and-notifications.md`.

## State root

The state root (`~/.agent-desktop`, or `AGENT_DESKTOP_HOME`) must be private to
the user. A root the tool creates has mode 0700. A root that is group-writable or open to
other users makes the commands that write there (`snapshot` for one) fail with
`INTERNAL` and the message "private file parent is accessible by group or other
users". `status` still runs. Fix an existing root:

```bash
chmod 700 "${AGENT_DESKTOP_HOME:-$HOME/.agent-desktop}"
```

Do not pre-create it with `mkdir -p` under a umask of 002.

The interaction lock lives under `/tmp/agent-desktop-<uid>/`, outside the state
root. It serializes input per user. `TIMEOUT` with `lock_timeout` and a high
`contention_count` means another agent of the same user is driving input.
