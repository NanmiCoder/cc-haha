# Installation

Claude Code Haha Desktop is built with Electron and ships packages for macOS, Windows, and Linux. Official macOS releases from `v0.4.3` onward use Developer ID signing and notarization; older or temporary builds may still require manual approval.

## Download

Open [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases) and select the package for your platform:

| Platform | Package |
|---|---|
| macOS Apple Silicon | `Claude-Code-Haha-<version>-mac-arm64.dmg` |
| macOS Intel | `Claude-Code-Haha-<version>-mac-x64.dmg` |
| Windows x64 | `Claude-Code-Haha-<version>-win-x64.exe` |
| Windows ARM64 | `Claude-Code-Haha-<version>-win-arm64.exe` |
| Linux x64 | `...-linux-x86_64.AppImage` or `...-linux-amd64.deb` |
| Linux ARM64 | `...-linux-arm64.AppImage` or `...-linux-arm64.deb` |

On macOS, **Apple M-series** means arm64; **Intel** means x64.

## macOS

Open the DMG and drag the app to `Applications`. An official signed release should only show the normal downloaded-app confirmation.

For an older or explicitly unsigned temporary build, macOS may report that the app is damaged or cannot verify the developer. After confirming the package source, either use **System Settings → Privacy & Security → Open Anyway**, or run:

```bash
xattr -cr /Applications/Claude\ Code\ Haha.app
```

Do not use this workaround for an untrusted download.

## Windows

Run the `.exe` installer. If an unsigned package triggers SmartScreen, verify that it came from the expected GitHub Release, then select **More info → Run anyway**.

The installer supports x64 and ARM64 packages. Close running Claude Code Haha processes before an overwrite install. User data is kept separately from application files.

## Linux

For AppImage:

```bash
chmod +x Claude-Code-Haha-<version>-linux-x86_64.AppImage
./Claude-Code-Haha-<version>-linux-x86_64.AppImage
```

If FUSE is missing, Ubuntu 22.04 and earlier normally use `libfuse2`; Ubuntu 24.04 and later normally use `libfuse2t64`.

For a deb package:

```bash
sudo apt install ./Claude-Code-Haha-<version>-linux-amd64.deb
```

## Local Web UI

For source development, run the server from the repository root and Vite from `desktop/`:

```bash
SERVER_PORT=3456 bun run src/server/index.ts
```

In a second terminal:

```bash
cd desktop
bun run dev --host 127.0.0.1 --port 2024
```

Open `http://127.0.0.1:2024`.

True loopback access from the same machine does not require H5 to be enabled or an H5 token. This trust does not extend to LAN addresses or reverse proxies.

## Headless Linux over SSH

Keep both processes bound to loopback:

```bash
SERVER_PORT=3456 bun run src/server/index.ts

cd desktop
bun run dev --host 127.0.0.1 --port 2024
```

Forward both ports from your own computer:

```bash
ssh -L 2024:127.0.0.1:2024 -L 3456:127.0.0.1:3456 user@example.com
```

Then open:

```text
http://127.0.0.1:2024/?serverUrl=http%3A%2F%2F127.0.0.1%3A3456
```

This does not expose the service to the LAN. To serve the built Web UI to a trusted LAN or reverse proxy, follow [H5 Access](./06-h5-access.md#enable-h5-without-the-desktop-ui).

## Updates and data

Official releases check GitHub Releases for updates. In-place updates and overwrite installs are designed to preserve local settings and sessions.

The default data location is under `~/.claude`. A custom data directory can be selected in the app. Before changing storage manually, use the in-app controls and read the recovery guidance in [FAQ](./05-FAQ.md).
