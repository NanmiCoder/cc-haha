# agent-desktop

Computer use for AI agents: read and operate desktop apps through the OS accessibility tree.

<p>
  <a href="https://vercel.com/labs#labs-products"><img alt="Vercel Labs Product" src="https://img.shields.io/badge/LABS-PRODUCT-0a0a0a.svg?style=for-the-badge&amp;logo=Vercel&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/agent-desktop"><img alt="npm version: agent-desktop" src="https://img.shields.io/npm/v/agent-desktop.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="https://github.com/vercel-labs/agent-desktop/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/vercel-labs/agent-desktop.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/agent-desktop"><img alt="npm downloads per month: agent-desktop" src="https://img.shields.io/npm/dm/agent-desktop.svg?style=for-the-badge&amp;labelColor=000000&amp;label=npm%20downloads" height="28"></a>
</p>

A CLI and C library for macOS, Windows and Linux. A snapshot returns JSON with a ref for every element an agent can act on. The agent acts on a ref and snapshots again to check, with no pixel matching; the loop stays in your agent.

On macOS, CLI calls reuse a private command host for each snapshot namespace and binary build. It retains native accessibility objects so a removed row cannot silently resolve to a surviving row with the same identifier. The host exits after 15 idle minutes. `TMPDIR` must be owned by the current user with mode `0700`; the standard macOS per-user temporary directory satisfies this requirement. Headless calls still prohibit foreground activation and synthesized input.

Snapshots, clipboard reads, screenshots, command output and debug artifacts can contain private desktop content. Keep them out of public logs and uploads. The optional [JEV helper](skills/jev-desktop/SKILL.md) sends screen descriptions to a configured model provider; it is separate from the native CLI. See [privacy and data handling](docs/faq.md#what-data-can-contain-private-information).

## Installation

Install on macOS, Windows or Linux with npm:

```bash
npm install -g agent-desktop
agent-desktop version
```

Bun, Yarn and pnpm can install the same package. It includes native binaries and platform helpers for x64 and ARM64.
For direct execution without a JavaScript launcher, download the matching native archive from
[GitHub Releases](https://github.com/vercel-labs/agent-desktop/releases) and keep its helper beside the executable.

Official Homebrew and Scoop packages are being submitted; they are not yet available in the default catalogs.
The repository no longer maintains a custom Homebrew tap or Scoop bucket.

- **macOS** needs Accessibility permission: `agent-desktop permissions --guide`.
- **Windows** needs no grant for apps at your terminal's integrity level.
- **Linux** needs the user's graphical session with `at-spi2-core`.

See [installation and permissions](docs/install.md) for package-manager behavior, release archives, and building from source.

## Quick start

Observe, act on a ref, observe again. Any app name from `agent-desktop list-apps` works; Finder is the macOS example.
Each command prints one JSON envelope; a trimmed snapshot follows the commands.

```bash
agent-desktop snapshot --app Finder -i      # interactive elements, each with a ref
agent-desktop click @s8f3k2p9:e8            # act on a ref from that snapshot
agent-desktop snapshot --app Finder -i      # observe again to verify
```

```json
{
  "version": "2.5",
  "ok": true,
  "command": "snapshot",
  "data": {
    "app": "Finder",
    "window": { "id": "w-204749", "title": "Downloads" },
    "snapshot_id": "s8f3k2p9",
    "ref_count": 59,
    "complete": true,
    "tree": {
      "role": "window",
      "name": "Downloads",
      "children": [
        { "role": "treeitem", "name": "Documents", "ref_id": "@s8f3k2p9:e8", "available_actions": ["Click"] }
      ]
    }
  }
}
```

- **Refs belong to their snapshot.** A bare `@e8` is rejected with `INVALID_ARGS`. When the UI changes, an action
  returns `STALE_REF` or `AMBIGUOUS_TARGET`: take a new snapshot and use its refs.
- **Several windows** give `AMBIGUOUS_TARGET`; `snapshot` lists the candidate window ids in `error.details`. Pass one
  with `--window-id`.
- **Dense apps:** map first with `snapshot --skeleton --app Slack -i --compact`, then drill into one region with
  `snapshot --root @s8f3k2p9:e3 -i --compact`.
- **Headless by default.** Ref actions go through the accessibility API without moving the pointer or taking focus.
  The global `--headed` flag allows physical input.
- **PowerShell.** Quote every ref (`'@s8f3k2p9:e8'`), because a bare `@token` is the splatting operator.

## For AI agents

The binary carries its own docs, matched to its version:

```bash
agent-desktop skills get desktop      # the loop, refs, verification and retry rules
agent-desktop skills get platform     # what differs on the OS you run on
agent-desktop <command> --help        # flags for one command
```

Install the skill into an agent harness from [skills.sh](https://skills.sh/vercel-labs/agent-desktop/agent-desktop):

```bash
npx skills add https://github.com/vercel-labs/agent-desktop --skill agent-desktop
```

Or add this to your `AGENTS.md`:

```markdown
Use `agent-desktop` to see and operate desktop apps. Before the first use, run
`agent-desktop skills get desktop` and `agent-desktop skills get platform`, and follow them.
```

Every command prints one envelope with `ok` and either `data` or `error`. An error carries a `code`, a `disposition` and usually a `suggestion`; retry only when `error.disposition.retry` is `safe`. The contract, error codes and exit codes are in [docs/json-output.md](docs/json-output.md).

## Commands

It ships 60 command names, 56 operational commands. The other four (`key-down`, `key-up`, `mouse-down`, `mouse-up`) refuse to run until a daemon can release a held key or button.

| Group | Commands |
|---|---|
| Observe | `snapshot`, `find`, `get`, `is`, `screenshot`, `list-surfaces` |
| Act on a ref | `click`, `double-click`, `triple-click`, `right-click`, `type`, `set-value`, `clear`, `focus`, `select`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `scroll`, `scroll-to` |
| Keyboard and mouse | `press`, `hover`, `drag`, `mouse-move`, `mouse-click`, `mouse-wheel`, `key-down`, `key-up`, `mouse-down`, `mouse-up` |
| Apps and windows | `launch`, `close-app`, `list-apps`, `list-windows`, `list-displays`, `focus-window`, `resize-window`, `move-window`, `minimize`, `maximize`, `restore`, `open-system-surface` |
| Notifications | `list-notifications`, `dismiss-notification`, `dismiss-all-notifications`, `notification-action` |
| Clipboard | `clipboard-get`, `clipboard-set`, `clipboard-clear` |
| Wait | `wait` |
| Sessions | `session`, `trace`, `cursor-overlay` |
| System | `status`, `permissions`, `version`, `batch`, `skills` |

## Platform support

| | macOS | Windows | Linux |
|---|:---:|:---:|:---:|
| Accessibility tree | Yes | Yes | Yes (AT-SPI) |
| Click / type / keyboard | Yes | Yes | AT-SPI; X11 / GNOME keys |
| Mouse input | Yes | Yes | X11, `--headed` |
| Screenshot | Yes | Yes | X11 windows; Wayland portal |
| Clipboard | Yes | Yes | Yes; Wayland needs `wl-clipboard` |
| App & window management | Yes | Yes | Launch/list; X11 window control |
| Notifications | Yes | Yes | GNOME Shell |
| Shell surfaces (`open-system-surface`) | Planned | Yes | GNOME tray, Action Center |

The Windows surface and `launch` notes and the Linux X11 and Wayland notes are in [docs/install.md](docs/install.md#platform-notes).

`agent-desktop skills get platform` prints the full capability table for the OS you run on.

## Language bindings

Each release also ships `libagent_desktop_ffi` for macOS, Linux and Windows, so a program can call the tool in process instead of starting the CLI for each command. `agent-desktop skills get ffi` covers the entry points, memory ownership and threading rules.

```python
import ctypes
lib = ctypes.CDLL("./lib/libagent_desktop_ffi.dylib")
lib.ad_adapter_create.restype = ctypes.c_void_p
lib.ad_adapter_destroy.argtypes = [ctypes.c_void_p]
assert lib.ad_init(6) == 0  # AD_RESULT_OK when the header's AD_ABI_VERSION_MAJOR matches the library
adapter = lib.ad_adapter_create()
lib.ad_adapter_destroy(adapter)
```

## Development

Each platform adapter builds only on its own OS, so scope cargo to the host's packages. On macOS:

```bash
HOST_PKGS=(-p agent-desktop-core -p agent-desktop-macos -p agent-desktop -p agent-desktop-ffi)
cargo test "${HOST_PKGS[@]}"
cargo clippy "${HOST_PKGS[@]}" --all-targets -- -D warnings
```

On Windows, replace `agent-desktop-macos` in that list with `agent-desktop-windows`; on Linux, with `agent-desktop-linux`.
[CONTRIBUTING.md](CONTRIBUTING.md) lists every gate. Build from source: [docs/install.md](docs/install.md#from-source).

## Documentation

| I want to... | Read |
|---|---|
| Fix an install problem, grant permissions, verify a download or build from source | [docs/install.md](docs/install.md) |
| Parse the JSON envelope, error codes and exit codes | [docs/json-output.md](docs/json-output.md) |
| Drive the tool as an AI agent | `agent-desktop skills get desktop` ([skills/agent-desktop/](skills/agent-desktop/)) |
| Learn what differs on one OS | [macOS](skills/agent-desktop-macos/), [Windows](skills/agent-desktop-windows/), [Linux](skills/agent-desktop-linux/) |
| Call the C library | [skills/agent-desktop-ffi/](skills/agent-desktop-ffi/) |
| Look up the vocabulary: refs, snapshots, sessions | [CONCEPTS.md](CONCEPTS.md) |
| Contribute and pass the gates | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Read the engineering rules | [AGENTS.md](AGENTS.md) |
| Learn from past bugs and lessons | [docs/solutions/](docs/solutions/) |
| Find answers to common questions | [docs/faq.md](docs/faq.md) |
| Report a vulnerability | [SECURITY.md](SECURITY.md) |
| Get help | [SUPPORT.md](SUPPORT.md) |

## License

Apache-2.0
