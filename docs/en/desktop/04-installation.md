# Installation & Build

## Download

Go to [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases) and download the package for your platform:

| Platform | File |
|------|------|
| macOS (Apple Silicon) | `Claude.Code.Haha_x.x.x_aarch64.dmg` |
| macOS (Intel) | `Claude.Code.Haha_x.x.x_x64.dmg` |
| Windows (x64) | `Claude.Code.Haha_x.x.x_x64-setup.exe` |

> Not sure which Mac build you need? Click the Apple menu → About This Mac. Choose `aarch64` for Apple Silicon and `x64` for Intel.

## macOS Installation

1. Open the `.dmg` file and drag the app into `Applications`
2. If macOS says the app is damaged on first launch, run:

```bash
xattr -cr /Applications/Claude\ Code\ Haha.app
```

> The app is not notarized yet, so macOS may block the first launch until the quarantine attribute is removed.

## Windows Installation

1. Run the `.exe` installer and follow the setup flow
2. If SmartScreen appears on first launch, click **More info** → **Run anyway**

> The app is not code-signed yet, so this warning may appear on first launch.

## Web UI Mode

If the desktop app cannot be installed, you can run the Web UI in a browser instead.

### One-command startup (recommended)

From the project root, run:

```bash
./bin/claude-haha-desktop
```

If `bin/` is already on your PATH, you can also run:

```bash
claude-haha-desktop
```

This command will automatically:

- start the local API server on `127.0.0.1:3456`
- start the desktop frontend on `127.0.0.1:2024`
- open the browser at `http://127.0.0.1:2024`

### Manual startup (for debugging)

If you need to debug the startup manually, run the backend and frontend separately:

```bash
# 1. Start the backend from the project root
SERVER_PORT=3456 bun run src/server/index.ts

# 2. Start the frontend from the desktop directory
cd desktop
bun run dev --host 127.0.0.1 --port 2024
```

Then open `http://127.0.0.1:2024` in your browser.

## FAQ

**Q: macOS says the app is from an unidentified developer?**

Right-click the app → choose **Open** → click **Open** in the dialog. You only need to do this once.

**Q: Windows says WebView2 is missing?**

Download and install WebView2 from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
